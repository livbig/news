"""Mini App (FR-17): веб-сервер того же процесса — авторизация по Telegram
initData (HMAC бот-токена), JSON API CRUD источников и расписания,
одностраничный HTML5/JS UI. Только stdlib (NFR-01); слушает BOT_WEBAPP_BIND
(по умолчанию 127.0.0.1). С телефона открывается через публичный https-URL
(BOT_WEBAPP_PUBLIC_URL: туннель/хостинг) — он же идёт в web_app-кнопки и
меню-кнопку бота; без него кнопка даёт локальный адрес текстом.
Сервер недоступен (порт занят/не стартовал) → кнопка в боте уводит в меню (fallback)."""
import json
import logging
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import config, db, scheduler
from .handlers.onboarding import TIME_RE, allowed
from .webauth import verify_init_data_detailed  # общий модуль: локальный сервер и Vercel (М3)

log = logging.getLogger("bot.webapp")

URL: str | None = None
MAX_SLOTS = 2  # как в settings.py (P0: 1–2 слота)

PAGE = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Веб-панель — новости</title>
<style>
body{font-family:-apple-system,sans-serif;margin:16px;max-width:640px;color:#222}
button{margin:2px;padding:6px 10px}
.off{opacity:.45}
h3{margin:14px 0 4px}
small{color:#777}
#msg{color:#060;margin-top:10px}
label{margin-right:10px}
</style></head><body>
<h2>Источники</h2><div id="srcs">Загрузка…</div>
<h2>Расписание сводок</h2><div id="times"></div>
<p><button id="save" hidden>Сохранить расписание</button></p>
<div id="msg"></div>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const H = () => ({'Authorization': 'tma ' + (tg ? tg.initData : ''),
                  'Content-Type': 'application/json'});
async function api(p, body) {
  const r = await fetch(p, {method: body ? 'POST' : 'GET', headers: H(),
                            body: body ? JSON.stringify(body) : undefined});
  if (r.status === 401) {
    let d = '';
    try { d = (await r.json()).detail || ''; } catch (e) {}
    document.body.textContent = 'Панель доступна из Telegram — откройте её кнопкой из меню бота.' +
      ' [диагностика: sdk=' + (window.Telegram ? 'да' : 'нет') +
      ', initData=' + (tg ? tg.initData.length : 0) + ' симв.' +
      (d ? ', причина: ' + d : '') + ']';
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
let times = [];
const PRESETS = ['07:00', '09:00', '12:00', '18:00', '21:00'];
function drawTimes() {
  document.getElementById('times').innerHTML = PRESETS.map(t =>
    `<label><input type="checkbox" ${times.includes(t) ? 'checked' : ''} onchange="tog('${t}')"> ${t}</label>`).join('');
  document.getElementById('save').hidden = false;
}
function tog(t) { times.includes(t) ? times.splice(times.indexOf(t), 1) : times.push(t); }
async function saveTimes() {
  try {
    const r = await api('/api/settings', {times: times});
    document.getElementById('msg').textContent = 'Расписание сохранено: ' + r.times.join(', ');
  } catch (e) { document.getElementById('msg').textContent = 'Ошибка: ' + e.message; }
}
function drawSources(list) {
  document.getElementById('srcs').innerHTML = list.map(s =>
    `<h3 class="${s.enabled ? '' : 'off'}">${esc(s.title)} <small>(${s.kind}${s.status !== 'ok' ? ', ' + s.status : ''})</small></h3>
     <div><button onclick="toggle(${s.id})">${s.enabled ? '⏸ Выключить' : '▶ Включить'}</button>
     <button onclick="del(${s.id})">✕ Удалить</button></div>`).join('') || 'Нет источников.';
}
async function refresh() {
  try { drawSources((await api('/api/sources')).sources); }
  catch (e) { document.getElementById('msg').textContent = 'Ошибка: ' + e.message; }
}
async function toggle(id) { try { await api('/api/sources/toggle', {id: id}); refresh(); } catch (e) {} }
async function del(id) { try { await api('/api/sources/delete', {id: id}); refresh(); } catch (e) {} }
document.getElementById('save').onclick = saveTimes;
(async () => {
  try { times = (await api('/api/settings')).times; drawTimes(); } catch (e) {}
  refresh();
})();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # тихо: свой лог в точках ошибок
        pass

    # --- служебное ---------------------------------------------------------

    def _send(self, code, obj=None, html=None):
        body = html.encode() if html is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type",
                         "text/html; charset=utf-8" if html is not None else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _unauthorized(self, reason=None):
        body = {"error": "требуется initData из Telegram"}
        if reason:
            body["detail"] = reason
        self._send(401, body)

    def _auth(self):
        raw = (self.headers.get("Authorization") or "")
        if not raw.startswith("tma "):
            return None, "no_header"
        user, reason = verify_init_data_detailed(raw[4:].strip(), config.TOKEN)
        if not user:
            return None, reason
        if not allowed(user["id"]):
            return None, "not_allowed"
        return user, None

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    # --- GET ---------------------------------------------------------------

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            return self._send(200, html=PAGE)
        user, reason = self._auth()
        if user is None:
            return self._unauthorized(reason)
        chat_id = user["id"]
        with _lock:
            if path == "/api/sources":
                rows = db.list_sources(_conn, chat_id)
                return self._send(200, {"sources": [
                    {"id": r["id"], "title": r["title"], "kind": r["kind"], "url": r["url"],
                     "origin": r["origin"], "enabled": bool(r["enabled"]),
                     "status": r["status"], "status_msg": r["status_msg"]}
                    for r in rows]})
            if path == "/api/settings":
                row = _conn.execute(
                    "SELECT send_times FROM users WHERE chat_id=%s", (chat_id,)).fetchone()
                times = scheduler.parse_times(row[0]) if row else []
                return self._send(200, {"times": times})
        self._send(404, {"error": "нет такого пути"})

    # --- POST ---------------------------------------------------------------

    def do_POST(self):
        user, reason = self._auth()
        if user is None:
            return self._unauthorized(reason)
        chat_id = user["id"]
        data = self._body()
        if data is None:
            return self._send(400, {"error": "нужен JSON-объект"})
        with _lock:
            if self.path == "/api/sources/toggle":
                return self._toggle(chat_id, data)
            if self.path == "/api/sources/delete":
                return self._delete(chat_id, data)
            if self.path == "/api/settings":
                return self._settings(chat_id, data)
        self._send(404, {"error": "нет такого пути"})

    def _owned(self, chat_id, data):
        row = db.get_source(_conn, data.get("id")) if isinstance(data.get("id"), int) else None
        if row is None or row["chat_id"] != chat_id:
            self._send(404, {"error": "источник не найден"})
            return None
        return row

    def _toggle(self, chat_id, data):
        row = self._owned(chat_id, data)
        if row is None:
            return
        db.set_enabled(_conn, row["id"], not row["enabled"])
        log.info("webapp: источник %s «%s» enabled=%s", row["id"], row["title"],
                 not row["enabled"])
        self._send(200, {"ok": True, "enabled": not row["enabled"]})

    def _delete(self, chat_id, data):
        row = self._owned(chat_id, data)
        if row is None:
            return
        db.delete_source(_conn, row["id"])  # items — каскадом
        log.info("webapp: удалён источник %s «%s»", row["id"], row["title"])
        self._send(200, {"ok": True})

    def _settings(self, chat_id, data):
        times = data.get("times")
        if (not isinstance(times, list) or not 1 <= len(times) <= MAX_SLOTS
                or not all(isinstance(t, str) and TIME_RE.match(t) for t in times)):
            return self._send(400, {"error": f"нужно 1–{MAX_SLOTS} времени в формате ЧЧ:ММ"})
        times = sorted({f"{int(t.split(':')[0]):02d}:{t.split(':')[1]}" for t in times})
        db.set_send_times(_conn, chat_id, times)
        log.info("webapp: расписание chat=%s → %s", chat_id, times)
        self._send(200, {"ok": True, "times": times})


# --- жизненный цикл ---------------------------------------------------------

_server: ThreadingHTTPServer | None = None
_conn = None
_lock = threading.Lock()  # sqlite-конн один (R5): API-запросы сериализуем


def public_url() -> str | None:
    """Публичный https-URL Mini App (BOT_WEBAPP_PUBLIC_URL) или None.
    Не-https отклоняется: web_app-кнопки Bot API принимает только с https."""
    u = config.WEBAPP_PUBLIC_URL
    if not u:
        return None
    if not u.startswith("https://"):
        log.warning("BOT_WEBAPP_PUBLIC_URL игнорируется (нужен https): %s", u)
        return None
    return u


def start(conn, port=None) -> str | None:
    """Поднять сервер; URL или None (порт занят — fallback в боте, FR-17).
    URL — публичный https (BOT_WEBAPP_PUBLIC_URL), если задан, иначе локальный."""
    global _server, _conn, URL
    if _server is not None:
        return URL
    _conn = conn
    bind = config.WEBAPP_BIND
    try:
        _server = ThreadingHTTPServer((bind, config.WEBAPP_PORT if port is None else port),
                                      Handler)
    except OSError as exc:
        log.warning("Веб-панель не запущена (bind %s, порт %s): %s",
                    bind, config.WEBAPP_PORT, exc)
        return None
    URL = public_url() or f"http://127.0.0.1:{_server.server_address[1]}"
    threading.Thread(target=_server.serve_forever, daemon=True, name="bot-webapp").start()
    log.info("Веб-панель: %s (bind %s)", URL, bind)
    return URL


def stop() -> None:
    global _server, URL
    if _server is None:
        return
    _server.shutdown()
    _server.server_close()
    _server = None
    URL = None
    log.info("Веб-панель остановлена")


def running() -> bool:
    return _server is not None
