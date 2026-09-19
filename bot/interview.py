"""LLM-интервью онбординга (11d/D45): 5-8 раундов по одному вопросу,
итог — профиль интересов для дайджеста и подбора источников. Вызовы —
боевой `_call` (стрим, anthropic-messages); сбой/нет ключа → None →
фолбэк хендлеров (дефолт-профиль + весь каталог)."""
import logging

from pipeline import config as pconfig
from pipeline.llm import _call

log = logging.getLogger("bot.interview")

INTERVIEW_TIMEOUT = 120.0  # раунд — короткая генерация, но GLM думает
INTERVIEW_MAX_TOKENS = 1000
MAX_ROUNDS = 8

INTERVIEWER_PROMPT = """Ты — интервьюер персонального новостного ассистента. Твоя задача — за
несколько раундов составить глубокий профиль интересов читателя, чтобы
затем подобрать ему идеальные источники новостей.

Правила:
- Задавай РОВНО ОДИН вопрос за раунд. Короткий, конкретный, по-русски.
- Копай от общего к частному: сферы и рынки → глубина погружения в каждую →
  конкретные инструменты, компании, темы, авторы → предпочитаемые языки
  источников → что читать НЕ хочет (анти-интересы, игнор-лист).
- Используй уже данные ответы, чтобы уточнять, а не переспрашивать.
- Не задавай больше 8 вопросов. Если профиль уже понятен — верни только
  строку ГОТОВО.
- Ответом на это сообщение будет ответ читателя; следующий вопрос задашь
  в следующем вызове (история диалога передаётся сообщениями)."""

PROFILE_PROMPT = """Ты — интервьюер персонального новостного ассистента. Ниже — история
интервью. Собери из неё компактный профиль интересов читателя: сферы
(порядок по значимости), глубина по каждой, конкретика (инструменты,
компании, темы), языки, анти-интересы. Формат — простой структурированный
текст до 500 символов, без воды. Выведи только профиль."""

KICKOFF = "(Интервью начинается. Задай первый вопрос.)"


def next_question(history: list[dict]) -> str | None:
    """Один раунд: история Q/A → следующий вопрос; «ГОТОВО»/сбой/нет
    ключа → None (хендлер завершает интервью, фолбэк при сбое)."""
    if not pconfig.LLM_API_KEY:
        log.info("интервью: LLM_API_KEY не задан — фолбэк")
        return None
    try:
        out = _call(
            INTERVIEWER_PROMPT, history or [{"role": "user", "content": KICKOFF}],
            INTERVIEW_MAX_TOKENS, read_timeout=INTERVIEW_TIMEOUT,
        )
    except Exception as exc:
        log.error("интервью: раунд не удался: %s", exc)
        return None
    question = out.strip()
    if not question or "ГОТОВО" in question:
        return None
    return question


def build_profile(history: list[dict]) -> str | None:
    """Сборка профиля из истории интервью (§3); сбой/нет ключа → None."""
    if not pconfig.LLM_API_KEY or not history:
        return None
    try:
        out = _call(
            PROFILE_PROMPT, history,
            INTERVIEW_MAX_TOKENS, read_timeout=INTERVIEW_TIMEOUT,
        )
    except Exception as exc:
        log.error("интервью: сборка профиля не удалась: %s", exc)
        return None
    profile = out.strip()
    return profile or None
