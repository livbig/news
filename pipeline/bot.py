import logging
import re
import time
from datetime import datetime, timedelta

import httpx

from . import channels, config, db, digest, fetch, llm, telegram

log = logging.getLogger("bot")

TME_RE = re.compile(r"(?:https?://)?t\.me/(?:s/|joinchat/|\+)?([A-Za-z0-9_]{4,32})", re.I)
CATEGORIES = {"metals_fx", "usmarket", "wsb", "ipo_ai_bio", "tech_ai", "macro", "geopolitics", "crypto"}

HELP = (
    "Команды:\n"
    "/digest — собрать новости (фиды + каналы) и прислать сводку\n"
    "/channels — список подписок\n"
    "/del имя — отписаться\n"
    "\n"
    "Подписка на канал: пришлите ссылку t.me/имя,\n"
    "можно с категорией через пробел: t.me/имя macro\n"
    "Категории: metals_fx, usmarket, wsb, ipo_ai_bio, tech_ai, macro, geopolitics, crypto"
)


def get_updates(offset: int) -> list[dict]:
    response = httpx.get(
        f"https://api.telegram.org/bot{config.TELEGRAM_TOKEN}/getUpdates",
        params={"timeout": 25, "offset": offset},
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("result", [])


def collect(conn) -> int:
    return fetch.fetch_all(conn) + channels.fetch_all_channels(conn)


def handle_chat(conn, text: str) -> None:
    """Свободный вопрос владельца: контекст = последние статьи ленты + история диалога."""
    conn.execute("INSERT INTO chat_history (role, text) VALUES ('user', ?)", (text,))
    history = conn.execute(
        "SELECT role, text FROM chat_history ORDER BY id DESC LIMIT 12"
    ).fetchall()[::-1]
    rows = conn.execute(
        "SELECT title, url, category, source FROM articles ORDER BY id DESC LIMIT 120"
    ).fetchall()
    context = "\n".join(f"[{c}] {t} — {s} — {u}" for t, u, c, s in rows)
    try:
        answer = llm.chat([{"role": r, "content": t} for r, t in history], context)
    except Exception as exc:
        log.error("Ошибка LLM в диалоге: %s", exc)
        telegram.send(f"LLM недоступен: {exc}")
        return
    conn.execute("INSERT INTO chat_history (role, text) VALUES ('assistant', ?)", (answer,))
    conn.commit()
    telegram.send(answer)


def handle_message(conn, msg: dict) -> None:
    chat_id = str(msg.get("chat", {}).get("id", ""))
    if config.TELEGRAM_CHAT_ID and chat_id != config.TELEGRAM_CHAT_ID:
        log.warning("Сообщение от чужого чата %s — игнор", chat_id)
        return
    text = (msg.get("text") or "").strip()
    if not text:
        return
    if text.startswith(("/start", "/help")):
        telegram.send(HELP)
    elif text.startswith("/digest"):
        new = collect(conn)
        result = digest.build_digest(conn)
        if result is None:
            telegram.send(f"Новых статей нет (прошлый прогон: +{new}).")
        else:
            digest.deliver(result)
    elif text.startswith("/channels"):
        rows = conn.execute("SELECT name, category FROM channel_subs ORDER BY name").fetchall()
        listing = "\n".join(f"t.me/{n} [{c}]" for n, c in rows) or "Подписок нет — пришлите ссылку t.me/имя"
        telegram.send(listing)
    elif text.startswith("/del"):
        parts = text.split()
        if len(parts) > 1:
            name = parts[1].lstrip("@").removeprefix("t.me/")
            conn.execute("DELETE FROM channel_subs WHERE name = ?", (name,))
            conn.commit()
            telegram.send(f"Канал {name} отписан.")
        else:
            telegram.send("Формат: /del имя_канала")
    else:
        m = TME_RE.search(text)
        if m and "joinchat" not in text and "/+" not in text:
            name = m.group(1)
            words = text.split()
            category = words[1] if len(words) > 1 and words[1] in CATEGORIES else "tech_ai"
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO channel_subs (name, category) VALUES (?, ?)", (name, category)
                )
                conn.commit()
                added = channels.fetch_channel(conn, name, category)
                telegram.send(f"Подписался на t.me/{name} [{category}]. Свежих постов: {added}")
            except Exception as exc:
                conn.execute("DELETE FROM channel_subs WHERE name = ?", (name,))
                conn.commit()
                telegram.send(f"Не получилось прочитать t.me/{name}: {exc}")
        else:
            handle_chat(conn, text)


def _next_fire(times: set[str], after: datetime) -> datetime:
    """Ближайший слот после `after` (сегодня или завтра)."""
    for t in sorted(times):
        h, m = map(int, t.split(":"))
        candidate = after.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate > after:
            return candidate
    t = sorted(times)[0]
    h, m = map(int, t.split(":"))
    return (after + timedelta(days=1)).replace(hour=h, minute=m, second=0, microsecond=0)


def run_bot():
    if not config.TELEGRAM_TOKEN:
        log.error("TELEGRAM_TOKEN не задан — бот не стартует")
        return
    conn = db.connect()
    offset = 0
    schedule = {s.strip() for s in config.DIGEST_TIMES.split(",") if s.strip()}
    next_fire = _next_fire(schedule, datetime.now()) if schedule else None
    log.info("Бот запущен. Следующая сводка: %s", next_fire or "нет расписания")
    while True:
        try:
            for upd in get_updates(offset):
                offset = upd["update_id"] + 1
                msg = upd.get("message")
                if msg:
                    handle_message(conn, msg)
        except Exception as exc:
            log.error("getUpdates: %s (VPN?) — повтор через 10с", exc)
            time.sleep(10)
        # догоняющая сводка: сработает и после сна Mac, если слот проспан
        if next_fire and datetime.now() >= next_fire:
            try:
                new = collect(conn)
                result = digest.build_digest(conn)
                if result:
                    digest.deliver(result)
                    log.info("Сводка по расписанию (+%d статей)", new)
            except Exception as exc:
                log.error("Сводка по расписанию упала: %s", exc)
            next_fire = _next_fire(schedule, datetime.now())
