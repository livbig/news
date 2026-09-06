import logging

import httpx

from . import config

log = logging.getLogger("telegram")

MAX_MESSAGE_LEN = 4000


def chunk_text(text: str, limit: int = MAX_MESSAGE_LEN) -> list[str]:
    chunks, current = [], ""
    for paragraph in text.split("\n\n"):
        candidate = f"{current}\n\n{paragraph}" if current else paragraph
        while len(candidate) > limit:
            if current:
                chunks.append(current)
                current, candidate = "", paragraph
            else:
                cut = paragraph.rfind("\n", 0, limit)
                cut = cut if cut > 0 else limit
                chunks.append(paragraph[:cut])
                paragraph = paragraph[cut:].lstrip("\n")
                candidate = paragraph
        current = candidate
    if current:
        chunks.append(current)
    return chunks


def send(text: str) -> bool:
    if not (config.TELEGRAM_TOKEN and config.TELEGRAM_CHAT_ID):
        log.warning("TELEGRAM_TOKEN/CHAT_ID не заданы — доставка в mock-режиме")
        return False
    for chunk in chunk_text(text):
        response = httpx.post(
            f"https://api.telegram.org/bot{config.TELEGRAM_TOKEN}/sendMessage",
            json={"chat_id": config.TELEGRAM_CHAT_ID, "text": chunk},
            timeout=30,
        )
        response.raise_for_status()
        log.info("Отправлено сообщение %d символов", len(chunk))
    return True
