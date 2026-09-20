import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress

import httpx
from pipeline.telegram import (  # R7/R8: боевые чанкинг и санитайз HTML
    _balance_tags,
    _sanitize_html,
    _strip_tags,
    _unwrap_tags,
    chunk_text,
)

from . import config

log = logging.getLogger("bot.tgsend")

TYPING_DELAY = float(os.environ.get("BOT_TYPING_DELAY", "1.0"))  # порог ~1 с (FR-15)
TYPING_REFRESH = 4.0  # sendChatAction живёт ~5 с — обновляем чаще


async def _typing_loop(bot, chat_id):
    await asyncio.sleep(TYPING_DELAY)  # быстрее порога — индикатор не нужен
    while True:
        try:
            await bot.send_chat_action(chat_id=chat_id, action="typing")
        except Exception as exc:
            log.warning("sendChatAction chat=%s: %s", chat_id, exc)
        await asyncio.sleep(TYPING_REFRESH)


@asynccontextmanager
async def with_typing(bot, chat_id):
    """«Печатает…» при операциях дольше ~1 с — сбор, LLM (FR-15, TC-30)."""
    if not chat_id:
        yield  # служебный chat_id=0 (mock-прогон) — индикатор не нужен
        return
    task = asyncio.create_task(_typing_loop(bot, chat_id))
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


def _post(text: str, chat_id, parse_mode: str | None) -> bool:
    body = {"chat_id": chat_id, "text": text}
    if parse_mode:
        body["parse_mode"] = parse_mode
    response = httpx.post(
        f"https://api.telegram.org/bot{config.TOKEN}/sendMessage", json=body, timeout=30
    )
    if response.status_code != 200:
        log.warning("sendMessage %s: %s", response.status_code, response.text[:200])
    return response.status_code == 200


def send_chat(text: str, chat_id) -> bool:
    """Доставка сообщения чату (split ≤4000, HTML с фолбэком в plain).
    Без токена или для chat_id=0 — mock-вывод в stdout (NFR-05)."""
    if not config.TOKEN or not chat_id:
        print(text)
        return True
    text = _sanitize_html(_unwrap_tags(text))
    for chunk in chunk_text(text):
        chunk = _balance_tags(chunk)
        if not _post(chunk, chat_id, parse_mode="HTML"):
            if not _post(_strip_tags(chunk), chat_id, parse_mode=None):
                log.error("sendMessage не прошёл даже в plain-режиме")
                return False
            log.warning("HTML не принят — отправлено как plain text")
        log.info("Отправлено сообщение %d символов", len(chunk))
    return True
