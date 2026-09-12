"""Меню и команды вне опроса/источников: /digest, /settings, колбэки меню."""
import asyncio
import json
import logging

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import collect, db, digest, keyboards, tgsend
from . import onboarding
from .onboarding import _drop, allowed

log = logging.getLogger("bot.menu")

router = Router()


async def run_digest(bot, chat_id: int) -> None:
    """Сбор включённых источников чата → сводка (И3 — mock; LLM — И5).
    Отказы источников изолированы (NFR-02), предупреждение — отдельным
    сообщением (футер сводки — И5)."""
    total, errors = await asyncio.to_thread(collect.collect_enabled, onboarding.conn, chat_id)
    text = await asyncio.to_thread(digest.build_mock, onboarding.conn, chat_id)
    if text is None:
        await bot.send_message(chat_id, "Новых статей нет.")
    else:
        await asyncio.to_thread(tgsend.send_chat, text, chat_id)
        log.info("digest chat=%s: +%d новых, сводка отправлена", chat_id, total)
    if errors:
        await bot.send_message(
            chat_id, f"⚠ Не удалось собрать {len(errors)} источник(ов) — подробности в /sources."
        )


@router.message(Command("digest"))
async def cmd_digest(message: Message, state: FSMContext):
    await _drop(state)
    if not allowed(message.chat.id):
        return
    await run_digest(message.bot, message.chat.id)


@router.callback_query(F.data == "menu:digest")
async def cq_menu_digest(cb: CallbackQuery, state: FSMContext):
    await _drop(state)
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    await cb.answer("Собираю сводку…")
    await run_digest(cb.bot, cb.message.chat.id)


@router.message(Command("settings"))
async def cmd_settings(message: Message, state: FSMContext):
    await _drop(state)
    if not allowed(message.chat.id):
        return
    row, count = await asyncio.to_thread(db.user_settings, onboarding.conn, message.chat.id)
    if row is None:
        await message.answer("Вы ещё не настраивали бота — /start.")
        return
    times = json.loads(row["send_times"])
    when = " и ".join(sorted(times)) if times else "не задано"
    await message.answer(
        f"Настройки\n\nРасписание сводок: {when} (по времени Mac).\nИсточников: {count}.\n\n"
        "Изменить расписание: /start — опрос заново (режим «Добавить поверх» "
        "сохранит текущие источники)."
    )


@router.callback_query(F.data == "menu:main")
async def cq_menu_main(cb: CallbackQuery, state: FSMContext):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    await cb.message.edit_text("Главное меню.", reply_markup=keyboards.menu_kb(onboarded=True))
    await cb.answer()


# последний обработчик всех колбэков: устаревшие кнопки не должны «висеть»
@router.callback_query()
async def cq_stale(cb: CallbackQuery):
    await cb.answer("Кнопка устарела — откройте меню заново (/start)")
