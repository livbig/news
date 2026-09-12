import logging

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
