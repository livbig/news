"""Настройки расписания (FR-10): /settings → мультивыбор времён слотов."""
import asyncio
import logging

from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import db, keyboards, scheduler
from ..states import Settings
from . import onboarding
from .onboarding import TIME_RE, _drop, _touch, allowed

log = logging.getLogger("bot.settings")

router = Router()

MIN_SLOTS, MAX_SLOTS = 1, 2


def _text(times, current=None) -> str:
    chosen = ", ".join(times) if times else "ничего"
    now_line = f"Текущее расписание: {', '.join(current)}.\n\n" if current else "\n"
    return (
        f"{now_line}"
        f"Расписание сводок. Выберите {MIN_SLOTS}–{MAX_SLOTS} времени — сколько времён, "
        f"столько сводок в день.\n\nВыбрано: {chosen}.\n"
        "Кнопка — выбрать/снять, «Ввести своё» — отправьте сообщение вида 09:30."
    )


@router.message(Command("settings"))
async def cmd_settings(message: Message, state: FSMContext):
    await _drop(state)
    if not allowed(message.chat.id):
        return
    row, _count = await asyncio.to_thread(db.user_settings, onboarding.conn, message.chat.id)
    if row is None:
        await message.answer("Вы ещё не настраивали бота — /start.")
        return
    current = scheduler.parse_times(row["send_times"])
    await state.set_state(Settings.time)
    await state.update_data(times=[])
    _touch(message.chat.id, message.from_user.id)
    await message.answer(_text([], current), reply_markup=keyboards.times_kb([]))


@router.callback_query(StateFilter(Settings.time), F.data.startswith("m:"))
async def cq_time(cb: CallbackQuery, state: FSMContext):
    value = cb.data[2:]
    data = await state.get_data()
    times = list(data.get("times") or [])
    _touch(cb.message.chat.id, cb.from_user.id)
    if value == "custom":
        await cb.answer("Отправьте время сообщением, например 09:30", show_alert=True)
        return
    if value == "next":
        if not MIN_SLOTS <= len(times) <= MAX_SLOTS:
            await cb.answer(f"Выберите {MIN_SLOTS}–{MAX_SLOTS} времени", show_alert=True)
            return
        await asyncio.to_thread(db.set_send_times, onboarding.conn, cb.message.chat.id, times)
        await _drop(state)
        log.info("Настройки chat=%s: расписание %s", cb.message.chat.id, sorted(times))
        await cb.message.edit_text(
            f"Расписание обновлено: {', '.join(sorted(times))} (по времени Mac).",
            reply_markup=keyboards.menu_kb(onboarded=True),
        )
        await cb.answer()
        return
    if value in times:
        times.remove(value)
    else:
        times.append(value)
    await state.update_data(times=times)
    await cb.message.edit_text(_text(times), reply_markup=keyboards.times_kb(times))
    await cb.answer()


@router.message(StateFilter(Settings.time), F.text & ~F.text.startswith("/"))
async def ms_time_input(message: Message, state: FSMContext):
    value = message.text.strip()
    match = TIME_RE.match(value)
    _touch(message.chat.id, message.from_user.id)
    if not match:
        await message.answer(
            "Не поняла время. Отправьте в формате ЧЧ:ММ (например 09:30) или выберите кнопку."
        )
        return
    value = f"{int(match.group(1)):02d}:{match.group(2)}"
    data = await state.get_data()
    times = list(data.get("times") or [])
    if value not in times:
        times.append(value)
    await state.update_data(times=times)
    await message.answer(_text(times), reply_markup=keyboards.times_kb(times))
