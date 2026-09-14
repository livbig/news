import logging
import re

import httpx

from . import config

log = logging.getLogger("telegram")

MAX_MESSAGE_LEN = 4000

HEADER_RE = re.compile(r"^[^\w\s]")


def _blocks(text: str) -> list[str]:
    """Разбивка на блоки: новый блок начинается со строки-заголовка (эмодзи/символ)."""
    blocks, current = [], []
    for line in text.splitlines():
        if line.strip() and HEADER_RE.match(line) and current:
            blocks.append("\n".join(current).strip("\n"))
            current = [line]
        else:
            current.append(line)
    if current:
        blocks.append("\n".join(current).strip("\n"))
    return [b for b in blocks if b.strip()]


def _split_long(block: str, limit: int) -> list[str]:
    """Блок длиннее лимита режем по абзацам, в крайнем случае — по строкам/символам."""
    if len(block) <= limit:
        return [block]
    pieces, cur = [], ""
    for para in block.split("\n\n"):
        while len(para) > limit:
            cut = para.rfind("\n", 0, limit)
            cut = cut if cut > 0 else limit
            pieces.append(para[:cut])
            para = para[cut:].lstrip("\n")
        candidate = f"{cur}\n\n{para}" if cur else para
        if len(candidate) > limit and cur:
            pieces.append(cur)
            cur = para
        else:
            cur = candidate
    if cur:
        pieces.append(cur)
    return pieces


def chunk_text(text: str, limit: int = MAX_MESSAGE_LEN) -> list[str]:
    """Каждое сообщение начинается с начала блока (секции), не с середины текста.
    Если блок длиннее лимита, его продолжение открывается заголовком «(продолжение)»."""
    chunks, cur = [], ""
    for block in _blocks(text):
        header = block.split("\n", 1)[0]
        pieces = _split_long(block, limit - len(header) - 20)
        for i, piece in enumerate(pieces):
            if i > 0:
                piece = f"{header} (продолжение)\n\n{piece}"
            candidate = f"{cur}\n\n{piece}" if cur else piece
            if len(candidate) > limit and cur:
                chunks.append(cur)
                cur = piece
            else:
                cur = candidate
    if cur:
        chunks.append(cur)
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
    if response.status_code != 200:
        log.warning("sendMessage %s: %s", response.status_code, response.text[:200])
    return response.status_code == 200


TAG_RE = re.compile(r"</?[abi]\b[^>]*>|&#?\w+;", re.I)


def _sanitize_html(text: str) -> str:
    """Экранируем символы, ломающие Telegram HTML (& из «S&P», < из «<1%» и т.п.),
    не трогая теги <a>/<b>/<i> и готовые сущности."""
    out, pos = [], 0
    for m in TAG_RE.finditer(text):
        out.append(text[pos:m.start()].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        out.append(m.group(0))
        pos = m.end()
    out.append(text[pos:].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    return "".join(out)


def _strip_tags(text: str) -> str:
    return re.sub(r"</?[a-zA-Z][^>]*>", "", text)


TAG_TOKEN_RE = re.compile(r"<(/?)([abi]\b[^>]*?)>", re.I)
WRAPPED_TAG_RE = re.compile(r"(<[abi]\b[^<>]*?)\s*\n\s*([^<>]*?>)", re.I)
TRUNCATED_TAG_RE = re.compile(r"<[abi]\b[^>]*$", re.I)


def _unwrap_tags(text: str) -> str:
    """LLM иногда рвёт тег переносом строки внутри URL — склеиваем."""
    while True:
        new = WRAPPED_TAG_RE.sub(r"\1\2", text)
        if new == text:
            return text
        text = new


def _balance_tags(text: str) -> str:
    """Ремонт ломаной разметки LLM: незакрытые теги закрываются, лишние
    закрывающие выбрасываются. Гарантирует валидный HTML для Telegram."""
    out, stack = [], []
    pos = 0
    for m in TAG_TOKEN_RE.finditer(text):
        out.append(text[pos:m.start()])
        token, inner = m.group(0), m.group(2)
        name = inner.split(None, 1)[0].lower() if inner else ""
        if not m.group(1):  # открывающий
            stack.append(name)
            out.append(token)
        else:  # закрывающий
            if stack and stack[-1] == name:
                stack.pop()
                out.append(token)
            # иначе: лишний закрывающий — выбрасываем
        pos = m.end()
    out.append(text[pos:])
    for name in reversed(stack):
        out.append(f"</{name}>")
    result = "".join(out)
    # обрубок тега без закрывающего '>' (разрезан границей чанка) — экранируем как текст
    result = TRUNCATED_TAG_RE.sub(lambda m: "&lt;" + m.group(0)[1:], result)
    return result


def send(text: str) -> bool:
    if not (config.TELEGRAM_TOKEN and config.TELEGRAM_CHAT_ID):
        log.warning("TELEGRAM_TOKEN/CHAT_ID не заданы — доставка в mock-режиме")
        return False
    text = _sanitize_html(_unwrap_tags(text))
    for chunk in chunk_text(text):
        chunk = _balance_tags(chunk)
        if not _post(chunk, parse_mode="HTML"):
            if not _post(_strip_tags(chunk), parse_mode=None):
                log.error("sendMessage не прошёл даже в plain-режиме")
                return False
            log.warning("HTML не принят (ломаная разметка?) — отправлено как plain text")
        log.info("Отправлено сообщение %d символов", len(chunk))
    return True
