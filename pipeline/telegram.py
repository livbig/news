import logging
import re

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


def get_chat_ids() -> list[dict]:
    response = httpx.get(
        f"https://api.telegram.org/bot{config.TELEGRAM_TOKEN}/getUpdates",
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if not payload.get("ok"):
        raise RuntimeError(f"Telegram API error: {payload}")
    chats: dict[int, dict] = {}
    for update in payload.get("result", []):
        msg = update.get("message") or update.get("edited_message") or update.get("channel_post")
        if not msg:
            continue
        chat = msg["chat"]
        chats[chat["id"]] = {
            "id": chat["id"],
            "type": chat.get("type", "?"),
            "name": chat.get("title") or chat.get("username") or chat.get("first_name") or "",
        }
    return list(chats.values())


def _post(chat_text: str, parse_mode: str | None) -> bool:
    body = {"chat_id": config.TELEGRAM_CHAT_ID, "text": chat_text}
    if parse_mode:
        body["parse_mode"] = parse_mode
    response = httpx.post(
        f"https://api.telegram.org/bot{config.TELEGRAM_TOKEN}/sendMessage",
        json=body,
        timeout=30,
    )
    return response.status_code == 200


def _strip_tags(text: str) -> str:
    return re.sub(r"</?[a-zA-Z][^>]*>", "", text)


def send(text: str) -> bool:
    if not (config.TELEGRAM_TOKEN and config.TELEGRAM_CHAT_ID):
        log.warning("TELEGRAM_TOKEN/CHAT_ID не заданы — доставка в mock-режиме")
        return False
    for chunk in chunk_text(text):
        if not _post(chunk, parse_mode="HTML"):
            if not _post(_strip_tags(chunk), parse_mode=None):
                log.error("sendMessage не прошёл даже в plain-режиме")
                return False
            log.warning("HTML не принят (ломаная разметка?) — отправлено как plain text")
        log.info("Отправлено сообщение %d символов", len(chunk))
    return True
