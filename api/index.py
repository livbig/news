"""М3: Mini App на Vercel — Starlette (ASGI), тот же JSON API, что и у
локального webapp.py: initData-авторизация, CRUD источников и расписания.
БД — общая Supabase (bot/db), схема создаётся на холодном старте функции.
GET / отдаёт ту же страницу (bot.webapp.PAGE); на Vercel «/» отдаёт CDN
(public/index.html — тот же текст), функция остаётся фолбэком и нужна
тестам. Env на Vercel: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_DB_URL."""
import json
import threading

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Route

from bot import db, scheduler
from bot.handlers.onboarding import TIME_RE, allowed
from bot.webapp import MAX_SLOTS, PAGE
from bot.webauth import diagnose_init_data, verify_init_data_detailed
from api.telegram import telegram_webhook
from bot import config

_conn = None
_lock = threading.Lock()  # один конн на инстанс функции: запросы сериализуем


def _get_conn():
    global _conn
    if _conn is None:
        with _lock:
            if _conn is None:
                _conn = db.connect()
    return _conn


def _set_conn(conn):
    """Тестам: подменить движок до первого запроса (как webapp.start(conn))."""
    global _conn
    _conn = conn


def _auth(request: Request):
    """user или None; reason — стадия отказа (диагностика в 401-JSON)."""
    raw = request.headers.get("authorization", "")
    if not raw.startswith("tma "):
        return None, "no_header"
    user, reason = verify_init_data_detailed(raw[4:].strip(), config.TOKEN)
    if not user:
        return None, reason
    if not allowed(user["id"]):
        return None, "not_allowed"
    return user, None


def _unauthorized(reason: str | None = None):
    body = {"error": "требуется initData из Telegram"}
    if reason:
        body["detail"] = reason  # no_header/no_hash/hash_mismatch/not_allowed/…
    return JSONResponse(body, status_code=401)


async def _body(request: Request):
    try:
        data = await request.json()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


async def _page(request):
    return HTMLResponse(PAGE)


async def _diag(request):
    """Диагностика initData без авторизации (М3.4/М3.5): страница на 401 шлёт
    сюда initData — ответ говорит, каким ключом/алгоритмом оно подписано.
    Каждая проба пишется в debug_auth_log (захват реального initData для
    локального подбора алгоритма)."""
    data = await _body(request)
    if data is None:
        return JSONResponse({"error": "нужен JSON-объект"}, status_code=400)
    init = str(data.get("init") or "")
    diag = diagnose_init_data(init, config.TOKEN)
    try:
        conn = _get_conn()
        conn.execute("INSERT INTO debug_auth_log (at, init, diag) VALUES (%s,%s,%s)",
                     (db.now_iso(), init[:8192], json.dumps(diag, ensure_ascii=False)))
        conn.commit()
    except Exception:  # лог диагностики не должен ломать диагностику
        pass
    return JSONResponse(diag)


async def _sources(request):
    user, reason = _auth(request)
    if user is None:
        return _unauthorized(reason)
    rows = db.list_sources(_get_conn(), user["id"])
    return JSONResponse({"sources": [
        {"id": r["id"], "title": r["title"], "kind": r["kind"], "url": r["url"],
         "origin": r["origin"], "enabled": bool(r["enabled"]),
         "status": r["status"], "status_msg": r["status_msg"]}
        for r in rows]})


async def _toggle(request):
    user, reason = _auth(request)
    if user is None:
        return _unauthorized(reason)
    data = await _body(request)
    if data is None:
        return JSONResponse({"error": "нужен JSON-объект"}, status_code=400)
    sid = data.get("id")
    row = db.get_source(_get_conn(), sid) if isinstance(sid, int) else None
    if row is None or row["chat_id"] != user["id"]:
        return JSONResponse({"error": "источник не найден"}, status_code=404)
    db.set_enabled(_get_conn(), row["id"], not row["enabled"])
    return JSONResponse({"ok": True, "enabled": not row["enabled"]})


async def _delete(request):
    user, reason = _auth(request)
    if user is None:
        return _unauthorized(reason)
    data = await _body(request)
    if data is None:
        return JSONResponse({"error": "нужен JSON-объект"}, status_code=400)
    sid = data.get("id")
    row = db.get_source(_get_conn(), sid) if isinstance(sid, int) else None
    if row is None or row["chat_id"] != user["id"]:
        return JSONResponse({"error": "источник не найден"}, status_code=404)
    db.delete_source(_get_conn(), row["id"])  # items — каскадом
    return JSONResponse({"ok": True})


async def _settings(request):
    user, reason = _auth(request)
    if user is None:
        return _unauthorized(reason)
    conn = _get_conn()
    if request.method == "GET":
        row = conn.execute(
            "SELECT send_times FROM users WHERE chat_id=%s", (user["id"],)).fetchone()
        return JSONResponse({"times": scheduler.parse_times(row[0]) if row else []})
    data = await _body(request)
    if data is None:
        return JSONResponse({"error": "нужен JSON-объект"}, status_code=400)
    times = data.get("times")
    if (not isinstance(times, list) or not 1 <= len(times) <= MAX_SLOTS
            or not all(isinstance(t, str) and TIME_RE.match(t) for t in times)):
        return JSONResponse(
            {"error": f"нужно 1–{MAX_SLOTS} времени в формате ЧЧ:ММ"}, status_code=400)
    times = sorted({f"{int(t.split(':')[0]):02d}:{t.split(':')[1]}" for t in times})
    db.set_send_times(conn, user["id"], times)
    return JSONResponse({"ok": True, "times": times})


app = Starlette(routes=[
    Route("/", _page, methods=["GET"]),
    Route("/api/diag", _diag, methods=["POST"]),
    Route("/api/sources", _sources, methods=["GET"]),
    Route("/api/sources/toggle", _toggle, methods=["POST"]),
    Route("/api/sources/delete", _delete, methods=["POST"]),
    Route("/api/settings", _settings, methods=["GET", "POST"]),
    Route("/api/telegram", telegram_webhook, methods=["POST"]),  # М4
])
