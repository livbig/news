"""Меню и команды вне опроса/источников: /digest, /stats, колбэки меню (настройки — settings.py)."""
import asyncio
import html
import logging

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import collect, db, digest, keyboards, llm, tgsend
from . import onboarding
from .onboarding import _drop, allowed

log = logging.getLogger("bot.menu")

router = Router()


async def run_digest(bot, chat_id: int, record: bool = False) -> None:
    """Предпросмотр дельты (D8: /digest — окно не сдвигается) или «сводка
    сейчас» (FR-19/D10: кнопка меню — отправка + транзакционная фиксация
    окна, как у плановой сводки: повтор не пришлёт то же самое).
    «Печатает…» при долгом сборе/LLM (FR-15), деградация источников —
    футером сводки (план §1.5), отказы изолированы (NFR-02)."""
    async with tgsend.with_typing(bot, chat_id):
        total, errors = await asyncio.to_thread(collect.collect_enabled, onboarding.conn, chat_id)
        text, ids = await asyncio.to_thread(digest.build_delta, onboarding.conn, chat_id)
        text = digest.with_footer(text or digest.EMPTY_TEXT, errors)
        sent = await asyncio.to_thread(tgsend.send_chat, text, chat_id)
        if record and sent:  # окно сдвигаем только при доставке (как _deliver)
            await asyncio.to_thread(
                db.record_digest, onboarding.conn, chat_id, text, ids)
    log.info("digest chat=%s: +%d новых, %s", chat_id, total,
             "сводка зафиксирована" if record and sent else "предпросмотр отправлен")


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
    await run_digest(cb.bot, cb.message.chat.id, record=True)


@router.callback_query(F.data == "menu:main")
async def cq_menu_main(cb: CallbackQuery, state: FSMContext):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    await cb.message.edit_text("Главное меню.", reply_markup=keyboards.menu_kb(onboarded=True))
    await cb.answer()


@router.message(Command("stats"))
async def cmd_stats(message: Message, state: FSMContext):
    """Статистика источников (FR-20/TC-36): элементы per источник за 24 ч."""
    await _drop(state)
    if not allowed(message.chat.id):
        return
    rows = await asyncio.to_thread(db.source_stats, onboarding.conn, message.chat.id)
    if not rows:
        await asyncio.to_thread(
            tgsend.send_chat, "Источников пока нет — добавьте через /sources.",
            message.chat.id)
        return
    labels = dict(keyboards.KIND_LABELS)
    lines = ["📊 Источники за 24 часа:"]
    for title, kind, fresh, total in rows:
        lines.append(f"• {html.escape(title)} [{labels.get(kind, kind)}] — "
                     f"{fresh} за 24 ч, всего {total}")
    await asyncio.to_thread(tgsend.send_chat, "\n".join(lines), message.chat.id)


# --- И7: диалоговый режим (R11, D27) ---------------------------------------------
# Свободный текст без команды и вне FSM-состояний: роутер меню подключён
# последним, все текстовые хендлеры выше сидят на StateFilter.

async def run_chat(bot, chat_id: int, text: str) -> None:
    async with tgsend.with_typing(bot, chat_id):  # LLM думает до 240 с (М4: потолок функции 300 с)
        answer = await asyncio.to_thread(llm.ask, onboarding.conn, chat_id, text)
    if answer:
        await asyncio.to_thread(tgsend.send_chat, answer, chat_id)


@router.message(F.text & ~F.text.startswith("/"))
async def ms_chat(message: Message, state: FSMContext):
    await _drop(state)
    if not allowed(message.chat.id):
        return
    await run_chat(message.bot, message.chat.id, message.text.strip())


# последний обработчик всех колбэков: устаревшие кнопки не должны «висеть»
@router.callback_query()
async def cq_stale(cb: CallbackQuery):
    await cb.answer("Кнопка устарела — откройте меню заново (/start)")
