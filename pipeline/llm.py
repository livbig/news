import logging

import httpx

from . import config

log = logging.getLogger("llm")

SYSTEM_PROMPT = """Ты — редактор личного новостного дайджеста на русском языке.

Правила:
1. Используй ТОЛЬКО предоставленные новости. Не выдумывай факты и не добавляй своё.
2. Каждый пункт: 1-2 предложения + ссылка на первоисточник в конце в круглых скобках.
3. Структура сводки (пропускай пустые разделы):
🔥 Главное — самое важное для инвестиционных решений (3-7 пунктов)
🥇 Металлы и валюты — золото, платина, палладий, USD/RUB (подробно)
📈 Рынок США и инвест-идеи (подробно, вкл. идеи с форумов)
🚀 IPO и акции AI/робототехники/биотеха
🤖 Технологии и AI — новые модели, промпт-инжиниринг
🏦 Макро и центробанки
🌍 Геополитика — по одному предложению на новость, только направление («в какую сторону весы»)
₿ Крипта — максимально коротко
4. Дубли одной истории из разных источников объединяй в один пункт.
5. В конце — блок «💡 Итог»: 2-3 предложения об общем тренде дня для инвестиционных решений.
6. Пиши по-русски, термины/тикеры оставляй как есть."""


def summarize(items_text: str) -> str:
    if not config.LLM_API_KEY:
        log.warning("LLM_API_KEY не задан — mock-сводка")
        return mock_summary(items_text, reason="LLM_API_KEY не задан")
    try:
        response = httpx.post(
            f"{config.LLM_BASE_URL}/v1/messages",
            headers={
                "Authorization": f"Bearer {config.LLM_API_KEY}",
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": config.LLM_MODEL,
                "max_tokens": 16000,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": items_text}],
            },
            timeout=180,
        )
        response.raise_for_status()
        content = response.json()["content"]
        return "".join(block["text"] for block in content if block.get("type") == "text")
    except httpx.HTTPStatusError as exc:
        body = exc.response.text[:300]
        log.error("LLM API вернул ошибку %s: %s — mock-сводка", exc.response.status_code, body)
        return mock_summary(items_text, reason=f"LLM API error {exc.response.status_code}: {body}")


def mock_summary(items_text: str, reason: str = "LLM_API_KEY не задан") -> str:
    lines = [f"📰 MOCK-сводка ({reason})", ""]
    for line in items_text.splitlines():
        if line.strip():
            lines.append(f"• {line.strip()}")
    lines.append("")
    lines.append("💡 Итог: mock-сводка, причина выше. Проверьте баланс/доступность LLM API.")
    return "\n".join(lines)
