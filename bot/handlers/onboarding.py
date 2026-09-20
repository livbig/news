"""Онбординг и повторный опрос (FR-01..FR-03 → 11d/D45): LLM-интервью
(5-8 раундов) → профиль интересов → LLM-подбор источников (валидация,
мультивыбор, fallback — каталог) → расписание. ACTIVE — карта неактивности
для sweeper (длинное интервью обязано трогать _touch каждый раунд)."""
import asyncio
import logging
import re
import time

from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import catalog, collect, config, db, interview, keyboards, llm
from ..states import Survey

log = logging.getLogger("bot.onboarding")

router = Router()
conn = None

# (chat_id, user_id) -> timestamp последнего апдейта внутри опроса; sweeper по нему
# решает, какую сессию завершать (порог — scheduler.FSM_TIMEOUT_SECONDS, D17)
ACTIVE: dict[tuple[int, int], float] = {}

TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")

MIN_VALID_SOURCES = 15  # меньше валидных кандидатов → fallback-пул каталога (D45)

GREETING = (
    "Персональный новостной ассистент.\n\n"
    "Сначала короткое интервью (5-8 вопросов) — пойму ваши интересы, затем "
    "подберу источники и расписание. Отвечайте свободным текстом; есть кнопки "
    "«Достаточно» и «Пропустить вопрос»."
)


def allowed(chat_id) -> bool:
    return not config.ALLOWED_CHAT_ID or str(chat_id) == config.ALLOWED_CHAT_ID


def _touch(chat_id: int, user_id: int) -> None:
    ACTIVE[(chat_id, user_id)] = time.time()


async def _drop(state: FSMContext) -> None:
    key = state.key
    ACTIVE.pop((key.chat_id, key.user_id), None)
    await state.clear()


async def expire_session(bot, storage, chat_id: int, user_id: int) -> None:
    """Таймаут неактивности (FR-01): сообщение + сброс состояния."""
    from aiogram.fsm.storage.base import StorageKey

    key = StorageKey(bot_id=bot.id, chat_id=chat_id, user_id=user_id)
    await storage.set_state(key, None)
    await storage.set_data(key, {})
    ACTIVE.pop((chat_id, user_id), None)
    await bot.send_message(
        chat_id,
        "Диалог завершён из-за неактивности (10 минут). "
        "Отправьте /start, чтобы пройти опрос заново.",
    )


# --- тексты шагов -----------------------------------------------------------

def _fresh_data(mode: str) -> dict:
    return {"mode": mode, "history": [], "rounds": 0, "pool": [], "selected": [],
            "excluded": set(), "src_page": 0, "times": [], "freq": 1,
            "interests_draft": None}


def _sources_text(pool, excluded, page=0) -> str:
    pages = (len(pool) + keyboards.PAGE_SIZE - 1) // keyboards.PAGE_SIZE
    suffix = f" (страница {page + 1}/{pages})" if pages > 1 else ""
    titles = "\n".join(
        ("  " if i in excluded else "✓ ") + e["title"] for i, e in enumerate(pool)
    )
    return (f"2/5. Источники по вашему профилю — {len(pool) - len(excluded)} из "
            f"{len(pool)} выбрано{suffix}. Снимите галочки с ненужных.\n\n{titles}")


def _time_text(times, freq) -> str:
    need = int(freq)
    chosen = ", ".join(times) if times else "ничего"
    word = "время" if need == 1 else "времени"
    return (
        f"4/5. Во сколько присылать сводку? Нужно ровно {need} {word}. Выбрано: {chosen}.\n\n"
        "Кнопка — выбрать/снять, «Ввести своё» — отправьте сообщение вида 09:30."
    )


def _summary_text(data) -> str:
    profile = (data.get("interests_draft") or "по умолчанию").strip()
    entries = data.get("selected") or []
    times = sorted(data.get("times") or [])
    freq_word = "1 раз в день" if data.get("freq") == 1 else "2 раза в день"
    lines = "\n".join("• " + e["title"] for e in entries)
    when = " и ".join(times)
    return (
        "5/5. Проверьте настройки.\n\n"
        f"Профиль интересов:\n{profile}\n\nИсточники ({len(entries)}):\n{lines}\n\n"
        f"Расписание: {freq_word}, в {when}."
    )


# --- интервью (11d/D45) -------------------------------------------------------

async def _start_interview(bot, chat_id, user_id, state) -> None:
    await state.update_data(history=[], rounds=0)
    await state.set_state(Survey.interview)
    _touch(chat_id, user_id)
    await _ask_question(bot, chat_id, user_id, state)


async def _ask_question(bot, chat_id, user_id, state) -> None:
    """Один раунд интервью: вопрос → сообщение с кнопками. ГОТОВО/сбой →
    финал или fallback. Каждый раунд трогает ACTIVE (sweeper 600 с)."""
    data = await state.get_data()
    history = data.get("history") or []
    rounds = data.get("rounds") or 0
    _touch(chat_id, user_id)
    if rounds >= interview.MAX_ROUNDS:
        await _finish_interview(bot, chat_id, user_id, state)
        return
    question = await asyncio.to_thread(interview.next_question, history)
    _touch(chat_id, user_id)
    if question is None:
        if not history:  # LLM недоступна с самого старта → fallback (D45)
            await _fallback_pool(bot, chat_id, state,
                                 "Интервью не получилось — предлагаю базовый набор из каталога.")
        else:
            await _finish_interview(bot, chat_id, user_id, state)
        return
    await state.update_data(
        rounds=rounds + 1,
        history=history + [{"role": "assistant", "content": question}],
    )
    await bot.send_message(chat_id, question, reply_markup=keyboards.interview_kb())


async def _finish_interview(bot, chat_id, user_id, state) -> None:
    data = await state.get_data()
    profile = await asyncio.to_thread(interview.build_profile, data.get("history") or [])
    _touch(chat_id, user_id)
    if not profile:  # сборка не удалась → дефолт-профиль + каталог (D45)
        await _fallback_pool(bot, chat_id, state,
                             "Не удалось собрать профиль — использую базовые приоритеты и каталог.")
        return
    await state.update_data(interests_draft=profile)
    await state.set_state(Survey.profile)
    await bot.send_message(
        chat_id, "Профиль интересов:\n\n" + profile + "\n\nВсё верно?",
        reply_markup=keyboards.profile_kb(),
    )


async def _fallback_pool(bot, chat_id, state, intro: str) -> None:
    """LLM недоступна/мало кандидатов: дефолтный профиль, пул = весь каталог."""
    pool = catalog.pick()
    await state.update_data(interests_draft=llm.DEFAULT_INTERESTS, pool=pool,
                            excluded=set(), src_page=0)
    await state.set_state(Survey.sources)
    await bot.send_message(
        chat_id, intro + "\n\n" + _sources_text(pool, set()),
        reply_markup=keyboards.sources_kb(pool, set(), 0),
    )


@router.callback_query(StateFilter(Survey.interview), F.data == "i:done")
async def cq_interview_done(cb: CallbackQuery, state: FSMContext):
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.answer()
    await _finish_interview(cb.message.bot, cb.message.chat.id, cb.from_user.id, state)


@router.callback_query(StateFilter(Survey.interview), F.data == "i:skip")
async def cq_interview_skip(cb: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    await state.update_data(
        history=(data.get("history") or []) + [{"role": "user", "content": "(пропущено)"}]
    )
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.answer("Вопрос пропущен")
    await _ask_question(cb.message.bot, cb.message.chat.id, cb.from_user.id, state)


@router.message(StateFilter(Survey.interview), F.text & ~F.text.startswith("/"))
async def ms_interview_answer(message: Message, state: FSMContext):
    _touch(message.chat.id, message.from_user.id)
    data = await state.get_data()
    await state.update_data(
        history=(data.get("history") or []) + [{"role": "user", "content": message.text}]
    )
    await _ask_question(message.bot, message.chat.id, message.from_user.id, state)


@router.callback_query(StateFilter(Survey.profile), F.data == "i:ok")
async def cq_profile_ok(cb: CallbackQuery, state: FSMContext):
    """Профиль принят → LLM-подбор источников → валидация → мультивыбор.
    Колбэк Telegram живёт секунды, а подбор — минуты: cb.answer() сразу,
    до долгой работы (инцидент 2026-09-20: answer после подбора —
    «query is too old», краш до fallback, FSM висел на шаге профиля)."""
    chat_id, user_id = cb.message.chat.id, cb.from_user.id
    _touch(chat_id, user_id)
    await cb.answer()
    data = await state.get_data()
    profile = data.get("interests_draft") or llm.DEFAULT_INTERESTS
    placeholder = await cb.message.bot.send_message(
        chat_id, "Подбираю источники по профилю — пара минут…")
    try:
        candidates = await asyncio.to_thread(llm.suggest_sources, profile)
        _touch(chat_id, user_id)  # подбор до 5 мин — sweeper (600 с) не должен вмешаться
        valid = await asyncio.to_thread(
            collect.validate_candidates, candidates) if candidates else []
    except Exception as exc:
        log.error("подбор chat=%s: %r", chat_id, exc)
        valid = []
    _touch(chat_id, user_id)
    if len(valid) < MIN_VALID_SOURCES:
        log.warning("подбор chat=%s: %d валидных кандидатов — fallback", chat_id, len(valid))
        await _fallback_pool(cb.message.bot, chat_id, state,
                             "Подобрать не удалось — предлагаю базовый набор из каталога.")
        await placeholder.delete()
        return
    await state.update_data(pool=valid, excluded=set(), src_page=0)
    await state.set_state(Survey.sources)
    await placeholder.edit_text(
        _sources_text(valid, set()), reply_markup=keyboards.sources_kb(valid, set(), 0))


@router.callback_query(StateFilter(Survey.profile), F.data == "i:fix")
async def cq_profile_fix(cb: CallbackQuery, state: FSMContext):
    """«Подправить» → ещё один уточняющий вопрос интервью."""
    data = await state.get_data()
    await state.update_data(
        history=(data.get("history") or [])
        + [{"role": "user", "content":
            "(Читатель хочет подправить профиль. Задай один уточняющий вопрос.)"}],
        rounds=interview.MAX_ROUNDS - 1,  # cap не режет уточняющий раунд
    )
    await state.set_state(Survey.interview)
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.answer()
    await _ask_question(cb.message.bot, cb.message.chat.id, cb.from_user.id, state)


# --- /start и вход в повторный опрос ----------------------------------------

@router.message(Command("start"))
async def cmd_start(message: Message, state: FSMContext):
    await _drop(state)
    if not allowed(message.chat.id):
        return
    chat_id = message.chat.id
    if await asyncio.to_thread(db.is_onboarded, conn, chat_id):
        await message.answer(
            "С возвращением.", reply_markup=keyboards.menu_kb(onboarded=True)
        )
        return
    await asyncio.to_thread(db.ensure_user, conn, chat_id)
    await state.update_data(**_fresh_data("replace"))
    await message.answer(GREETING)
    await _start_interview(message.bot, chat_id, message.from_user.id, state)


@router.callback_query(F.data == "menu:resurvey")
async def cq_resurvey(cb: CallbackQuery, state: FSMContext):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    await state.set_state(Survey.rs_mode)
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.message.edit_text(
        "Пройти опрос заново.\n\n"
        "Заменить — источники прошлого опроса удалятся, ручные сохранятся.\n"
        "Добавить поверх — новый набор объединится с текущим.",
        reply_markup=keyboards.rs_mode_kb(),
    )
    await cb.answer()


@router.callback_query(StateFilter(Survey.rs_mode), F.data.startswith("r:"))
async def cq_mode(cb: CallbackQuery, state: FSMContext):
    mode = cb.data.split(":", 1)[1]
    await state.update_data(**_fresh_data(mode))
    await cb.message.edit_text("Начнём интервью.")
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.answer()
    await _start_interview(cb.message.bot, cb.message.chat.id, cb.from_user.id, state)


@router.callback_query(StateFilter(Survey.rs_mode), F.data == "c:cancel")
async def cq_cancel(cb: CallbackQuery, state: FSMContext):
    await _drop(state)
    await cb.message.edit_text("Отменено.", reply_markup=keyboards.menu_kb(onboarded=True))
    await cb.answer()


# --- шаг 2: источники (мультивыбор, пагинация 11d/D46) --------------------------

@router.callback_query(StateFilter(Survey.sources), F.data.startswith("s:"))
async def cq_source(cb: CallbackQuery, state: FSMContext):
    value = cb.data[2:]
    data = await state.get_data()
    pool = data.get("pool") or []
    excluded = set(data.get("excluded") or ())
    page = int(data.get("src_page") or 0)
    _touch(cb.message.chat.id, cb.from_user.id)
    if value == "next":
        selected = [e for i, e in enumerate(pool) if i not in excluded]
        await state.update_data(selected=selected, freq=1, times=[])
        await state.set_state(Survey.freq)
        await cb.message.edit_text("3/5. Как часто присылать сводку?",
                                   reply_markup=keyboards.freq_kb())
        await cb.answer()
        return
    if value.startswith("p:"):
        page = int(value[2:])
        await state.update_data(src_page=page)
        await cb.message.edit_text(
            _sources_text(pool, excluded, page),
            reply_markup=keyboards.sources_kb(pool, excluded, page),
        )
        await cb.answer()
        return
    idx = int(value)
    if idx in excluded:
        excluded.discard(idx)
    else:
        excluded.add(idx)
    await state.update_data(excluded=excluded)
    await cb.message.edit_text(
        _sources_text(pool, excluded, page),
        reply_markup=keyboards.sources_kb(pool, excluded, page),
    )
    await cb.answer()


# --- шаг 3: частота -----------------------------------------------------------

@router.callback_query(StateFilter(Survey.freq), F.data.startswith("f:"))
async def cq_freq(cb: CallbackQuery, state: FSMContext):
    freq = int(cb.data[2:])
    await state.update_data(freq=freq, times=[])
    await state.set_state(Survey.time)
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.message.edit_text(_time_text([], freq),
                               reply_markup=keyboards.times_kb([]))
    await cb.answer()


# --- шаг 4: время -------------------------------------------------------------

@router.callback_query(StateFilter(Survey.time), F.data.startswith("m:"))
async def cq_time(cb: CallbackQuery, state: FSMContext):
    value = cb.data[2:]
    data = await state.get_data()
    times = list(data.get("times") or [])
    freq = int(data.get("freq") or 1)
    _touch(cb.message.chat.id, cb.from_user.id)
    if value == "custom":
        await cb.answer("Отправьте время сообщением, например 09:30", show_alert=True)
        return
    if value == "next":
        if len(times) != freq:
            await cb.answer(f"Выберите ровно {freq} времени", show_alert=True)
            return
        await state.set_state(Survey.confirm)
        await cb.message.edit_text(_summary_text(data),
                                   reply_markup=keyboards.confirm_kb())
        await cb.answer()
        return
    if value in times:
        times.remove(value)
    else:
        times.append(value)
    await state.update_data(times=times)
    await cb.message.edit_text(_time_text(times, freq),
                               reply_markup=keyboards.times_kb(times))
    await cb.answer()


@router.message(StateFilter(Survey.time), F.text & ~F.text.startswith("/"))
async def ms_time_input(message: Message, state: FSMContext):
    value = message.text.strip()
    match = TIME_RE.match(value)
    if not match:
        _touch(message.chat.id, message.from_user.id)
        await message.answer(
            "Не поняла время. Отправьте в формате ЧЧ:ММ (например 09:30) или выберите кнопку."
        )
        return
    value = f"{int(match.group(1)):02d}:{match.group(2)}"
    data = await state.get_data()
    times = list(data.get("times") or [])
    freq = int(data.get("freq") or 1)
    _touch(message.chat.id, message.from_user.id)
    if value not in times:
        times.append(value)
    await state.update_data(times=times)
    await message.answer(_time_text(times, freq), reply_markup=keyboards.times_kb(times))


# --- шаг 5: подтверждение ------------------------------------------------------

@router.callback_query(StateFilter(Survey.confirm), F.data == "c:save")
async def cq_save(cb: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    entries = data.get("selected") or []
    times = sorted(data.get("times") or [])
    mode = data.get("mode") or "replace"
    interests = (data.get("interests_draft") or "").strip()
    chat_id = cb.message.chat.id
    try:
        await asyncio.to_thread(
            db.finalize_survey, conn, chat_id, entries, times, mode
        )
        if interests:  # D45: профиль — в users.interests_text, дайджест его читает
            await asyncio.to_thread(db.set_interests, conn, chat_id, interests)
    except Exception as exc:
        log.error("finalize_survey chat=%s: %s", chat_id, exc)
        await cb.answer("Ошибка сохранения — попробуйте ещё раз", show_alert=True)
        return
    await _drop(state)
    verb = "заменены" if mode == "replace" else "добавлены"
    await cb.message.edit_text(
        f"Сохранено: источники {verb}, расписание {', '.join(times)}.\n\n"
        "/sources — источники, /digest — собрать сейчас (предпросмотр).",
        reply_markup=keyboards.menu_kb(onboarded=True),
    )
    await cb.answer()
    log.info("Онбординг chat=%s: %d источников, %s, профиль %d симв.",
             chat_id, len(entries), times, len(interests))


@router.callback_query(StateFilter(Survey.confirm), F.data == "c:restart")
async def cq_restart(cb: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    mode = data.get("mode") or "replace"
    await state.update_data(**_fresh_data(mode))
    await state.set_state(Survey.interview)
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.message.edit_text("Начнём заново.")
    await cb.answer()
    await _start_interview(cb.message.bot, cb.message.chat.id, cb.from_user.id, state)


# --- посторонний ввод внутри опроса --------------------------------------------

# команды не перехватываем (план §1.3: любая команда сбрасывает состояние) —
# они уходят в свои обработчики ниже по роутерам; interview/time имеют
# собственные текстовые хендлеры
@router.message(StateFilter(Survey.rs_mode, Survey.sources,
                            Survey.freq, Survey.confirm, Survey.profile),
                ~F.text.startswith("/"))
async def ms_foreign(message: Message, state: FSMContext):
    _touch(message.chat.id, message.from_user.id)
    await message.answer(
        "Сейчас идёт опрос — используйте кнопки этого сообщения. /start — начать заново."
    )
