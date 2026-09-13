"""LLM-сводка бота (И5): промпт §1.6 (ссылки, ассистент, top-N, русский)
на боевом стриминговом _call (R9); параметры 900×2 + mock-фолбэк (D25)."""
import logging
import time

import httpx
from pipeline import config as pconfig
from pipeline.llm import _call, mock_summary  # R9: боевой клиент GLM

log = logging.getLogger("bot.llm")

# Промпт §1.6 плана: тон личного ассистента, ссылки только из материалов,
# глубина тем по приоритетам FR-02, суммарный лимит ~3500 символов.
SYSTEM_PROMPT = """Ты — личный новостной ассистент: читаешь все источники хозяина и в заданное \
время присылаешь выжимку нового — как будто личный помощник всё прочитал и пересказал.

Вход: список новостей за период, по одной в строке: «заголовок — ссылка».
Напиши сводку на русском языке одним сообщением.

Правила:
1. Используй ТОЛЬКО предоставленные новости; выдумывать факты и ссылки
   запрещено. Ссылка пункта — обязательно из его исходной строки.
2. Выбери не более 25 пунктов: связанные новости объединяй, мелочь отбрасывай.
3. Формат: короткий лид «что важно за период», затем пункты вида
   «Суть новости — 1-2 предложения <a href="URL">подробнее</a>»,
   в конце «💡 Итог:» — 1-2 предложения об общем фоне.
4. Разрешены только теги <a>, <b>, <i>; каждый тег закрывай; тег <a> —
   одной строкой, без переносов внутри.
5. Глубина по приоритетам: драгметаллы (Au, Pt, Pd), USD, рынок США,
   инвест-идеи (вкл. wallstreetbets), IPO/AI-робототехника/биотех, новые
   AI-модели и промпт-инжиниринг — подробно; макро — кратко; геополитика —
   только направление («в какую сторону весы»); крипта — очень кратко.
   Порядок: от важного к второстепенному, пустые темы пропускай.
6. Вся сводка — не более 3500 символов, без воды, приветствий и извинений."""

MAX_TOKENS = 16000  # как в проде: thinking-блоки GLM съедают бюджет до text-блока
READ_TIMEOUT = 900.0  # D25: модель может долго думать над большим объёмом
ATTEMPTS = 2
RETRY_PAUSE = 30.0  # D25: пауза между попытками

_sleep = time.sleep  # заменяется в тестах (TC-31)


def summarize(items_text: str) -> str:
    """Сводка по дельте (§1.6). Без ключа — mock (NFR-05); 5xx/таймауты/
    пустой ответ — 2 попытки с паузой 30 с, затем mock с пометкой (D25);
    прочие 4xx — сразу mock: ретраи бессмысленны (баланс/авторизация)."""
    if not pconfig.LLM_API_KEY:
        log.warning("LLM_API_KEY не задан — mock-сводка")
        return mock_summary(items_text)
    messages = [{"role": "user", "content": items_text}]
    last_exc: Exception | None = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            result = _call(SYSTEM_PROMPT, messages, MAX_TOKENS, read_timeout=READ_TIMEOUT)
            if result.strip():
                return result
            last_exc = RuntimeError("пустой ответ (только thinking-блоки?)")
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code < 500:
                body = exc.response.text[:200]
                log.error("LLM API вернул %s: %s — mock-сводка",
                          exc.response.status_code, body)
                return mock_summary(
                    items_text, reason=f"LLM API error {exc.response.status_code}: {body}"
                )
            last_exc = exc
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_exc = exc
        log.error("LLM попытка %d/%d не удалась: %s", attempt, ATTEMPTS, last_exc)
        if attempt < ATTEMPTS:
            _sleep(RETRY_PAUSE)
    return mock_summary(items_text, reason=f"LLM недоступна после 2 попыток: {last_exc}")
