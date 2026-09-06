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
3. Начни со строки «📰 Сводка за период» и вводного абзаца (2-3 предложения): главный
   тренд периода своими словами.
4. Дальше — секции с заголовками-эмодзи: 🥇 Металлы и валюты / 📈 Рынок США и инвест-идеи /
   🎯 Идеи с форумов (WSB) / 🚀 IPO, AI-робототехника, биотех / 🤖 Технологии и AI /
   🏦 Макро и центробанки / 🌍 Геополитика / ₿ Крипта. Пустые секции пропускай.
   Внутри секции — связная проза: связанные события объединяй в один абзац
   («золото подросло на фоне X, а платина…»), а не «новость — новая строка».
5. Каждую новость из списка отрази (полные дубли одной истории объединяй). Крупное —
   1-2 предложениями с деталями, мелкое — короткой фразой внутри общего абзаца.
6. Глубина по темам: драгметаллы, USD/RUB, рынок США, инвест-идеи, IPO/AI-робототехника/
   биотех — развёрнуто; геополитика — только направление («в какую сторону весы»);
   крипта — максимально коротко.
7. В конце секция «💡 Итог»: 2-3 предложения — общий фон и к чему быть готовым.
8. Пиши по-русски, тикеры/термины оставляй как есть. Объём растёт с числом новостей:
   20-40 новостей — это 3000-6000 символов готового текста."""


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
