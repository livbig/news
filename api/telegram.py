"""М4: webhook Telegram — secret_token, дедуп update_id (at-least-once
доставка), dp.feed_update до конца запроса (на Vercel фоновых задач нет).
Прод-токен подключается в М6; до того — dev-токен на preview-деплое."""
import asyncio
import logging
import threading

from aiogram import Bot
from starlette.requests import Request
from starlette.responses import JSONResponse

from bot import config, db
from bot.handlers import build_dispatcher
from bot.pgstorage import PgStorage

log = logging.getLogger("api.telegram")

_conn = None
_bot = None
_dp = None
_lock = threading.Lock()


def _resources():
    """Ленивый синглтон на инстанс функции: БД (схема на холодном старте),
    общий conn для хендлеров и FSM, Bot и Dispatcher без polling."""
    global _conn, _bot, _dp
    if _dp is None:
        with _lock:
            if _dp is None:
                from bot import handlers

                _conn = db.connect()
                handlers.init(_conn)
                _bot = Bot(config.TOKEN)
                _dp = build_dispatcher(PgStorage(_conn))
    return _conn, _bot, _dp


def _set_resources(conn=None, bot=None, dp=None):
    """Тестам: подмена до первого запроса (как api.index._set_conn)."""
    global _conn, _bot, _dp
    if conn is not None:
        _conn = conn
    if bot is not None:
        _bot = bot
    if dp is not None:
        _dp = dp


async def telegram_webhook(request: Request):
    secret = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not config.TELEGRAM_WEBHOOK_SECRET or secret != config.TELEGRAM_WEBHOOK_SECRET:
        return JSONResponse({"error": "webhook недоступен"}, status_code=401)
    try:
        update = await request.json()
    except Exception:
        return JSONResponse({"error": "нужен JSON"}, status_code=400)
    if not isinstance(update, dict) or not isinstance(update.get("update_id"), int):
        return JSONResponse({"error": "нужен Telegram update"}, status_code=400)
    conn, bot, dp = _resources()
    seen = await asyncio.to_thread(db.mark_update_seen, conn, update["update_id"])
    await asyncio.to_thread(db.cleanup_processed_updates, conn)
    if not seen:  # повторная доставка уже обработанного апдейта
        return JSONResponse({"ok": True, "duplicate": True})
    try:
        await dp.feed_update(bot, update)
    except Exception as exc:
        log.error("feed_update %s: %s", update["update_id"], exc)
        return JSONResponse({"ok": False}, status_code=500)
    return JSONResponse({"ok": True})
