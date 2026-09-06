import json
import logging

import httpx

from . import config

log = logging.getLogger("llm")

SYSTEM_PROMPT = """Ты — редактор личного новостного дайджеста на русском языке. Тебе дают список
новостей за период; ты пишешь ОДНО связное повествование человеческими словами, а не список пунктов.

Правила:
1. Используй ТОЛЬКО предоставленные новости. Не выдумывай факты и не добавляй своё.
2. Ссылки на первоисточник вставляй ПРЯМО В ТЕКСТ в виде <a href="URL">слов</a> — ссылкой
   должны быть сами слова новости (или тематический эмодзи сразу после), не отдельной строкой
   и не URL в скобках. Разрешены только теги <a>, <b>, <i> — никаких других.
   Строго закрывай КАЖДЫЙ открытый тег; никогда не вкладывай тег <a> внутрь другого <a>.
   Тег <a> пиши одной строкой — не переноси URL внутри href на новую строку.
3. Начни со строки «📰 Сводка за период» и вводного абзаца (2-3 предложения): главный
   тренд периода своими словами.
4. Дальше — секции с заголовками-эмодзи: 🥇 Металлы и валюты / 📈 Рынок США и инвест-идеи /
   🎯 Идеи с форумов (WSB) / 🚀 IPO, AI-робототехника, биотех / 🤖 Технологии и AI /
   🏦 Макро и центробанки / 🌍 Геополитика / ₿ Крипта. Пустые секции пропускай; добавляй
   собственные секции/подсекции, если в списке есть темы, не попадающие в этот набор.
   Внутри секции — связная проза: связанные события объединяй в один абзац
   («золото подросло на фоне X, а платина…»), а не «новость — новая строка».
5. Главная цель — широчайший кругозор. КАЖДАЯ новость из списка обязана найтись
   в сводке хотя бы полуфразой в тематическом абзаце. Важное — 1-2 предложениями,
   дубли одной истории объединяй. Никогда не жертвуй мелкими темами ради деталей крупных.
6. Глубина по темам: драгметаллы, USD/RUB, рынок США, инвест-идеи, IPO/AI-робототехника/
   биотех — развёрнуто; геополитика — только направление («в какую сторону весы»);
   крипта — максимально коротко.
7. В конце секция «💡 Итог»: 2-3 предложения — общий фон и к чему быть готовым.
8. Пиши по-русски, тикеры/термины оставляй как есть. Объём: 20-40 новостей — это
   6000-9000 символов, 100+ — пропорционально больше. Текст длиннее за счёт ОХВАТА
   (упомянуты все темы и новости), а не за счёт глубины одной темы. Тем много — дроби
   на дополнительные секции и подсекции с точными заголовками-эмодзи: чем шире карта
   периода, тем лучше. Воды и вводных фраз — ноль, плотность тем максимум."""

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
