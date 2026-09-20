"""LLM-сводка бота (И5 → iter-11b/D41-D43): mega-вызов одним запросом,
формат 3-4 сообщения с эмодзи-ссылками на первоисточник, персональный
профиль интересов (11d) вместо жёстких приоритетов; стриминг `_call` (R9),
2 попытки + mock-фолбэк (D25). Диалог (И7): pipeline.llm.chat (R11/D27).
11d/D45: подбор источников по профилю (suggest_sources)."""
import json
import logging
import os
import re
import time

import httpx
from pipeline import config as pconfig
from pipeline.llm import _call, chat, mock_summary  # R9/R11: боевой клиент GLM

log = logging.getLogger("bot.llm")

# Промпт дайджеста — согласован с пользователем дословно 2026-09-15 (план
# mega-digest §Промпты; D42/D43); ревизия формата 2026-09-20 — заголовки
# разделов капсом+эмодзи, пункты без буллетов. {INTERESTS_PROFILE} —
# единственная подстановка, заполняется из users.interests_text (11d) или
# дефолтом.
SYSTEM_PROMPT = """Ты — личный аналитик одного читателя: частный дайджест-сервис премиального
уровня. Ты прочитал весь входной поток новостей за период и теперь пишешь
выжимку максимальной плотности: без воды, без пересказа статей, только суть
и следствия. Это твой единственный читатель — работай для него, а не «для всех».

<интересы_читателя>
{INTERESTS_PROFILE}
</интересы_читателя>

Метод (выполняй строго по порядку):
1. Прочитай ВСЕ пункты блока <новости>. Дубли и продолжения одной истории
   склей в один пункт, взяв самую полную формулировку; ссылки склеенных
   пунктов не теряй — веди на самый авторитетный первоисточник.
2. Отбрось шум: саморекламу, повторы без новой информации, пустые анонсы,
   заголовки без последствий для читателя.
3. Сгруппируй значимое по разделам профиля интересов. Порядок разделов —
   по важности для читателя. Всегда опускай пустые разделы.
4. В каждом пункте дай нейро-вывод: что это значит, куда движется, на что
   повлияет. Пересказ статьи запрещён: заголовок уже есть, твоя ценность —
   интерпретация. ТЕКСТ и ВЫЖИМКА — сырьё для вывода, а не черновик:
   выбери 1-2 главные детали, остальное отбрось. Пункт целиком (суть +
   вывод) — не длиннее ~240 символов; пункт всегда короче своего источника.
5. Соединяй точки: если несколько новостей образуют тренд — назови тренд
   в лидере или синтезе и упомяни все его составляющие.

Формат вывода (строгий контракт):
- Лид: 2-3 предложения — главное за период и почему это важно.
- Разделы: заголовок раздела — с новой строки, тегом <b>, КАПСОМ, с эмодзи
  темы из карты ниже в начале: <b>📈 РЫНОК США</b>. Маркеры списков
  (•, -, *) запрещены нигде. Пункты — каждый с новой строки, без маркера
  (суть ≤80 символов, нейро-вывод 1-2 предложения; пункт всегда короче
  источника):
  <b>Суть новости</b> — нейро-вывод. <a href="URL">ЭМОДЗИ</a>
- ЭМОДЗИ — единственная ссылка пункта, встроена в эмодзи-категорию,
  ведёт на первоисточник этой новости:
  🥇 драгметаллы/сырьё · 💵 валюты · 📈 рынок США · 💡 инвест-идеи/форумы ·
  🚀 IPO/роботы/биотех · 🤖 AI-модели · 🏦 макро/ЦБ · 🌍 геополитика ·
  ₿ крипта · ⚡ энергия · 🛠 прочее
- В конце два блока (заголовки — так же: КАПСОМ с эмодзи):
  «🧠 СИНТЕЗ» — 3-5 предложений: тренды периода, риски, к чему готовиться.
  «👀 НА РАДАРЕ» — до 5 пунктов-триггеров: события, которые вот-вот
  выстрелят (если таких нет — блок опусти).

Контроль качества:
- Используй ТОЛЬКО факты из <новости>. Числа, тикеры, цитаты — из входа.
  Ссылку копируй в <a href> посимвольно из входа, без изменений.
- Ни один значимый факт не должен пропасть: лучше длиннее, чем потерять
  суть. Но каждый пункт обязан нести новую информацию.
- Язык — русский; тикеры и названия компаний латиницей как есть.
- Разрешённые теги: <a>, <b>, <i>. Никаких других тегов и никакого <br>.
- Целевой объём: 12000-16000 символов (60-80 пунктов при полном потоке).
  Если новостей мало — пиши короче, не расширяй воду."""

# Дефолтный профиль — приоритеты пользователя до онбординг-интервью (11d/D45)
DEFAULT_INTERESTS = (
    "Глубоко: драгметаллы (Au, Pt, Pd), USD/RUB, рынок США, инвест-идеи "
    "(вкл. wallstreetbets), IPO и акции AI/робототехники/биотеха, новые "
    "AI-модели, промпт-инжиниринг. Кратко: макро. Геополитика — только "
    "направление («в какую сторону весы»). Крипта — очень кратко."
)

# 11b/D41: thinking-блоки GLM-5.3 съедают бюджет до text-блока (env — для опытов)
MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "32000"))
READ_TIMEOUT = 900.0  # D25: модель может долго думать над большим объёмом
ATTEMPTS = 2
RETRY_PAUSE = 30.0  # D25: пауза между попытками

_sleep = time.sleep  # заменяется в тестах (TC-31)

_BR = re.compile(r"<br\s*/?>", re.IGNORECASE)
_BULLET = re.compile(r"(?m)^[ \t]*[•·]\s*")


def _normalize(text: str) -> str:
    """LLM любит <br> — в Telegram-HTML такого тега нет, он экранируется
    и виден как текст (инцидент 2026-09-14): заменяем на перенос строки.
    Буллеты в начале строк запрещены формат-контрактом (ревизия 2026-09-20),
    но LLM их проскальзывает — срезаем."""
    return _BULLET.sub("", _BR.sub("\n", text))


def _system_prompt(interests: str | None) -> str:
    profile = interests.strip() if interests and interests.strip() else DEFAULT_INTERESTS
    return SYSTEM_PROMPT.replace("{INTERESTS_PROFILE}", profile)


def summarize(items_text: str, interests: str | None = None) -> str:
    """Сводка по дельте (D42: один mega-вызов). interests — профиль читателя
    (users.interests_text); None/пустой → DEFAULT_INTERESTS. Без ключа —
    mock (NFR-05); 5xx/таймауты/пустой ответ — 2 попытки с паузой 30 с,
    затем mock с пометкой (D25); прочие 4xx — сразу mock: ретраи
    бессмысленны (баланс/авторизация)."""
    if not pconfig.LLM_API_KEY:
        log.warning("LLM_API_KEY не задан — mock-сводка")
        return mock_summary(items_text)
    messages = [{"role": "user", "content": items_text}]
    last_exc: Exception | None = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            result = _call(
                _system_prompt(interests), messages, MAX_TOKENS, read_timeout=READ_TIMEOUT
            )
            if result.strip():
                return _normalize(result)
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


# --- 11d/D45: LLM-подбор источников по профилю ------------------------------------

SUGGEST_SOURCES_PROMPT = """Ты — редактор-исследователь источников новостей. По профилю интересов
читателя подбери 40-60 РЕАЛЬНО СУЩЕСТВУЮЩИХ источников.

Требования:
- Формат ответа — строго JSON-массив, без пояснений:
  [{"title": "короткое название", "kind": "rss", "url": "https://.../feed.xml"},
   {"title": "...", "kind": "tgweb", "url": "username_канала"}]
- kind: "rss" — прямые ссылки на RSS/Atom-фиды изданий, блогов, агентств;
  "tgweb" — публичные Telegram-каналы (username без @, без t.me/);
  "html" — страницы со списком новостей (только если нет RSS).
- РАЗРЕШЕНО предлагать только реально существующие источники: известные
  издания и фиды. НЕ выдумывай URL — каждый несуществующий URL отсекается
  проверкой, и читатель теряет источник.
- Разнообразье важнее количества одинаковых: мейнстрим + нишевые +
  отраслевые + форумы/агрегаторы по профилю.
- Языки источников — согласно профилю; по умолчанию EN + RU.

Профиль интересов:
{PROFILE}"""

SUGGEST_TIMEOUT = 300.0   # подбор — одиночный вызов, не в слоте
SUGGEST_MAX_TOKENS = 16000  # D41: thinking-блоки GLM съедают бюджет до text-блока
                           # (инцидент 2026-09-20: 8000 → JSON обрезан → 0 кандидатов)
SUGGEST_MAX_CANDIDATES = 60
_SUGGEST_KINDS = ("rss", "tgweb", "html")


def _extract_json_array(text: str) -> list:
    """JSON-массив из ответа LLM: regex-извлечение [...] (LLM любит пояснения)."""
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return []
    return data if isinstance(data, list) else []


def suggest_sources(profile: str) -> list[dict]:
    """Кандидаты источников по профилю (11d/D45): [{title, kind, url}],
    kinds rss/tgweb/html, кап 60. Галлюцинации не фильтруются здесь — их
    отсекает collect.validate_candidates. LLM недоступна/сбой/пусто → []."""
    if not pconfig.LLM_API_KEY:
        log.warning("LLM_API_KEY не задан — подбор источников недоступен")
        return []
    prompt = SUGGEST_SOURCES_PROMPT.replace("{PROFILE}", profile.strip() or DEFAULT_INTERESTS)
    try:
        out = _call(
            "Ты — редактор-исследователь источников новостей. Отвечай строго JSON.",
            [{"role": "user", "content": prompt}],
            SUGGEST_MAX_TOKENS,
            read_timeout=SUGGEST_TIMEOUT,
        )
    except Exception as exc:
        log.error("suggest_sources: LLM не ответила: %s", exc)
        return []
    result = []
    for entry in _extract_json_array(out):
        if not isinstance(entry, dict):
            continue
        title, kind, url = entry.get("title"), entry.get("kind"), entry.get("url")
        if not (isinstance(title, str) and isinstance(url, str) and title.strip() and url.strip()):
            continue
        if kind not in _SUGGEST_KINDS:
            continue
        result.append({"title": title.strip()[:80], "kind": kind, "url": url.strip()})
        if len(result) >= SUGGEST_MAX_CANDIDATES:
            break
    log.info("suggest_sources: %d кандидатов", len(result))
    return result


# --- iter-14c (уровень 3): map-стадия — выжимка статьи ----------------------------

GIST_PROMPT = """Ты — аналитик личного дайджеста. Ниже — полный текст новости.
Сожми его в 1-3 предложения (до 400 символов): суть, ключевые цифры/тикеры,
следствия для читателя. Только факты из текста, без воды, русский язык.
Если текст — пустышка, реклама или не новость, верни ровно: ПУСТО

<текст>
{TEXT}
</текст>"""

MAP_MAX_TOKENS = int(os.environ.get("BOT_MAP_MAX_TOKENS", "2500"))
MAP_TIMEOUT = float(os.environ.get("BOT_MAP_TIMEOUT", "120"))
GIST_ATTEMPTS = 2
GIST_PAUSE = 10.0


def make_gist(text: str) -> str:
    """Map-стадия (14c): полный текст → плотная выжимка (≤600 симв.).
    '' — пустышка/реклама или LLM не ответила (в дайджест тогда идёт
    исходная выдержка ТЕКСТ)."""
    if not pconfig.LLM_API_KEY:
        return ""
    messages = [{"role": "user",
                 "content": GIST_PROMPT.replace("{TEXT}", text)}]
    for attempt in range(1, GIST_ATTEMPTS + 1):
        try:
            out = _call("Ты — аналитик: сжимаешь новости без потерь.",
                        messages, MAP_MAX_TOKENS, read_timeout=MAP_TIMEOUT)
        except Exception as exc:
            log.warning("gist: попытка %d/%d не удалась: %s",
                        attempt, GIST_ATTEMPTS, exc)
            out = ""
        out = (out or "").strip()
        if out:
            return "" if "ПУСТО" in out.upper() else out[:600]
        if attempt < GIST_ATTEMPTS:
            _sleep(GIST_PAUSE)
    return ""


# --- И7: диалоговый режим (R11, D27) --------------------------------------------

CHAT_HISTORY_LIMIT = 12   # как в проде (pipeline/bot.py)
CHAT_CONTEXT_LIMIT = 120  # последних заголовков ленты в контексте


def ask(conn, chat_id, text: str) -> str | None:
    """Вопрос владельца: контекст = лента чата + история диалога чата.
    Возвращает текст ответа или None-подобную подсказку при сбое; вся
    диагностика — в лог (как в проде). Без ключа — подсказка без похода в API."""
    if not pconfig.LLM_API_KEY:
        log.info("chat chat=%s: LLM_API_KEY не задан — диалог недоступен", chat_id)
        return "LLM-диалог недоступен: не задан LLM_API_KEY."
    from . import db

    db.add_chat_message(conn, chat_id, "user", text)
    history = db.chat_history(conn, chat_id, CHAT_HISTORY_LIMIT)
    context = db.news_context(conn, chat_id, CHAT_CONTEXT_LIMIT)
    try:
        answer = chat(history, context)
    except Exception as exc:
        log.error("chat chat=%s: ошибка LLM в диалоге: %s", chat_id, exc)
        return f"LLM недоступен: {exc}"
    if not answer.strip():
        log.warning("chat chat=%s: пустой ответ LLM", chat_id)
        return "LLM вернул пустой ответ — попробуйте переспросить."
    answer = _normalize(answer)
    log.info("chat chat=%s: ответ %d симв.", chat_id, len(answer))
    db.add_chat_message(conn, chat_id, "assistant", answer)
    return answer
