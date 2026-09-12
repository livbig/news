"""Онбординг и повторный опрос (FR-01..FR-03). ACTIVE — карта неактивности для sweeper."""
import asyncio
import logging
import re
import time

from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import catalog, config, db, keyboards
from ..states import Survey

log = logging.getLogger("bot.onboarding")

router = Router()
conn = None

# (chat_id, user_id) -> timestamp последнего апдейта внутри опроса; sweeper по нему
# решает, какую сессию завершать (порог — scheduler.FSM_TIMEOUT_SECONDS, D17)
ACTIVE: dict[tuple[int, int], float] = {}

TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")

GREETING = (
    "Персональный новостной ассистент.\n\n"
    "Короткий опрос — и я сам буду читать ваши источники и в заданное время "
    "присылать выжимку всего нового. Источники и настройки можно менять позже."
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

def _topics_text(selected) -> str:
    if selected:
        chosen = "\n".join("✓ " + catalog.TOPIC_LABELS[t] for t in sorted(selected))
    else:
        chosen = "Если ничего не выбирать — соберу набор по вашим приоритетам."
    return "1/5. Какие темы читаем глубоко? Можно выбрать несколько.\n\n" + chosen


def _sources_text(pool, excluded) -> str:
    titles = "\n".join(
        ("  " if i in excluded else "✓ ") + e["title"] for i, e in enumerate(pool)
    )
    return f"2/5. Источники по выбранным темам ({len(pool) - len(excluded)} выбрано).\n\n{titles}"


def _time_text(times, freq) -> str:
    need = int(freq)
    chosen = ", ".join(times) if times else "ничего"
    word = "время" if need == 1 else "времени"
    return (
        f"4/5. Во сколько присылать сводку? Нужно ровно {need} {word}. Выбрано: {chosen}.\n\n"
        "Кнопка — выбрать/снять, «Ввести своё» — отправьте сообщение вида 09:30."
    )


def _summary_text(data) -> str:
    topics = ", ".join(catalog.TOPIC_LABELS[t] for t in data.get("topics") or []) or "по умолчанию"
    entries = data.get("selected") or []
    times = sorted(data.get("times") or [])
    freq_word = "1 раз в день" if data.get("freq") == 1 else "2 раза в день"
    lines = "\n".join("• " + e["title"] for e in entries)
    when = " и ".join(times)
    return (
        "5/5. Проверьте настройки.\n\n"
        f"Темы: {topics}\n\nИсточники ({len(entries)}):\n{lines}\n\n"
        f"Расписание: {freq_word}, в {when}."
    )


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
    await state.update_data(mode="replace", topics=set())
    await state.set_state(Survey.topics)
    _touch(chat_id, message.from_user.id)
    await message.answer(GREETING + "\n\n" + _topics_text(set()),
                         reply_markup=keyboards.topics_kb(set()))


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
    await state.update_data(mode=mode, topics=set())
    await state.set_state(Survey.topics)
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.message.edit_text(
        _topics_text(set()), reply_markup=keyboards.topics_kb(set())
    )
    await cb.answer()


@router.callback_query(StateFilter(Survey.rs_mode), F.data == "c:cancel")
async def cq_cancel(cb: CallbackQuery, state: FSMContext):
    await _drop(state)
    await cb.message.edit_text("Отменено.", reply_markup=keyboards.menu_kb(onboarded=True))
    await cb.answer()


# --- шаг 1: темы ------------------------------------------------------------

@router.callback_query(StateFilter(Survey.topics), F.data.startswith("t:"))
async def cq_topic(cb: CallbackQuery, state: FSMContext):
    value = cb.data[2:]
    data = await state.get_data()
    selected = set(data.get("topics") or [])
    _touch(cb.message.chat.id, cb.from_user.id)
    if value == "next":
        pool = catalog.pick(selected)
        await state.update_data(topics=sorted(selected), pool=pool, excluded=set())
        await state.set_state(Survey.sources)
        await cb.message.edit_text(
            _sources_text(pool, set()), reply_markup=keyboards.sources_kb(pool, set())
        )
        await cb.answer()
        return
    if value in selected:
        selected.discard(value)
    else:
        selected.add(value)
    await state.update_data(topics=selected)
    await cb.message.edit_text(
        _topics_text(selected), reply_markup=keyboards.topics_kb(selected)
    )
    await cb.answer()


# --- шаг 2: источники ---------------------------------------------------------

@router.callback_query(StateFilter(Survey.sources), F.data.startswith("s:"))
async def cq_source(cb: CallbackQuery, state: FSMContext):
    value = cb.data[2:]
    data = await state.get_data()
    pool = data.get("pool") or []
    excluded = set(data.get("excluded") or ())
    _touch(cb.message.chat.id, cb.from_user.id)
    if value == "next":
        selected = [e for i, e in enumerate(pool) if i not in excluded]
        await state.update_data(selected=selected, freq=1, times=[])
        await state.set_state(Survey.freq)
        await cb.message.edit_text("3/5. Как часто присылать сводку?",
                                   reply_markup=keyboards.freq_kb())
        await cb.answer()
        return
    idx = int(value)
    if idx in excluded:
        excluded.discard(idx)
    else:
        excluded.add(idx)
    await state.update_data(excluded=excluded)
    await cb.message.edit_text(
        _sources_text(pool, excluded), reply_markup=keyboards.sources_kb(pool, excluded)
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
    chat_id = cb.message.chat.id
    try:
        await asyncio.to_thread(
            db.finalize_survey, conn, chat_id, entries, times, mode
        )
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
    log.info("Онбординг chat=%s: %d источников, %s", chat_id, len(entries), times)


@router.callback_query(StateFilter(Survey.confirm), F.data == "c:restart")
async def cq_restart(cb: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    await state.update_data(topics=set(), excluded=set(), times=[], freq=1)
    await state.set_state(Survey.topics)
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.message.edit_text(
        _topics_text(set()), reply_markup=keyboards.topics_kb(set())
    )
    await cb.answer()


# --- посторонний ввод внутри опроса --------------------------------------------

# команды не перехватываем (план §1.3: любая команда сбрасывает состояние) —
# они уходят в свои обработчики ниже по роутерам
@router.message(StateFilter(Survey.rs_mode, Survey.topics, Survey.sources,
                            Survey.freq, Survey.confirm), ~F.text.startswith("/"))
async def ms_foreign(message: Message, state: FSMContext):
    _touch(message.chat.id, message.from_user.id)
    await message.answer(
        "Сейчас идёт опрос — используйте кнопки этого сообщения. /start — начать заново."
    )
