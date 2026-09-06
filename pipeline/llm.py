import json
import logging

import httpx

from . import config

log = logging.getLogger("llm")

SYSTEM_PROMPT = """Ты — редактор личного новостного дайджеста на русском языке. Тебе дают список
новостей за период; ты пишешь компактную обзорную сводку — карту дня.

Правила:
1. Используй ТОЛЬКО предоставленные новости. Не выдумывай факты и не добавляй своё.
2. БЕЗ ссылок и БЕЗ какой-либо разметки — только чистый текст.
3. Структура: строка «📰 Сводка за период», короткий вводный абзац (1-2 предложения
   о главном тренде), затем секции с заголовками-эмодзи: 🥇 Металлы и валюты /
   📈 Рынок США и инвест-идеи / 🎯 Идеи с форумов (WSB) / 🚀 IPO, AI-робототехника,
   биотех / 🤖 Технологии и AI / 🏦 Макро и центробанки / 🌍 Геополитика / ₿ Крипта.
   Пустые секции пропускай; темы вне набора — своими секциями.
4. Главное правило объёма: 1-2 ПРЕДЛОЖЕНИЯ НА ТЕМУ. Связанные новости одной темы
   сворачивай в одно предложение («золото выросло на фоне X, а платина стоит»).
   Если в секции несколько тем — по предложению на каждую, без раскрытия деталей.
5. Приоритет: драгметаллы, USD/RUB, рынок США, инвест-идеи, IPO/AI-роботы/биотех —
   первыми; геополитика — только направление («в какую сторону весы»);
   крипта — одной строкой.
6. В конце «💡 Итог»: 2-3 предложения об общем фоне и к чему быть готовым.
7. Пиши по-русски, тикеры как есть. Вся сводка обычно 1500-3000 символов."""

CHAT_SYSTEM_PROMPT = """Ты — ассистент владельца личного новостного дайджест-бота.
Он отвечает тебе текстом в Telegram — ты получаешь его вопрос, контекст последних
статей его ленты (с ссылками) и историю диалога.

Правила:
1. Если тема есть в ленте — отвечай с деталями из статей и инлайн-ссылками
   <a href="URL">словами</a>. Разрешены только теги <a>, <b>, <i>.
2. Если в ленте темы нет — отвечай своими знаниями и добавь в конце «(не из ленты)».
3. По-русски, кратко и по делу, без приветствий и извинений."""


def _call(system: str, messages: list[dict], max_tokens: int) -> str:
    """Стриминговый вызов: длинные генерации не упираются в read-timeout."""
    parts: list[str] = []
    with httpx.stream(
        "POST",
        f"{config.LLM_BASE_URL}/v1/messages",
        headers={
            "Authorization": f"Bearer {config.LLM_API_KEY}",
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": config.LLM_MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "stream": True,
        },
        timeout=httpx.Timeout(900.0, connect=30.0),
    ) as response:
        if response.status_code != 200:
            response.read()
            response.raise_for_status()
        for line in response.iter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if not payload or payload == "[DONE]":
                continue
            event = json.loads(payload)
            etype = event.get("type")
            if etype == "content_block_delta" and event.get("delta", {}).get("type") == "text_delta":
                parts.append(event["delta"]["text"])
            elif etype == "error":
                raise RuntimeError(f"LLM stream error: {event.get('error')}")
    return "".join(parts)


def summarize(items_text: str) -> str:
    if not config.LLM_API_KEY:
        log.warning("LLM_API_KEY не задан — mock-сводка")
        return mock_summary(items_text, reason="LLM_API_KEY не задан")
    try:
        return _call(SYSTEM_PROMPT, [{"role": "user", "content": items_text}], 16000)
    except httpx.HTTPStatusError as exc:
        body = exc.response.text[:300]
        log.error("LLM API вернул ошибку %s: %s — mock-сводка", exc.response.status_code, body)
        return mock_summary(items_text, reason=f"LLM API error {exc.response.status_code}: {body}")


def chat(messages: list[dict], news_context: str) -> str:
    system = CHAT_SYSTEM_PROMPT + "\n\nКонтекст последних статей ленты:\n" + news_context
    return _call(system, messages, 3000)


def mock_summary(items_text: str, reason: str = "LLM_API_KEY не задан") -> str:
    lines = [f"📰 MOCK-сводка ({reason})", ""]
    for line in items_text.splitlines():
        if line.strip():
            lines.append(f"• {line.strip()}")
    lines.append("")
    lines.append("💡 Итог: mock-сводка, причина выше. Проверьте баланс/доступность LLM API.")
    return "\n".join(lines)
