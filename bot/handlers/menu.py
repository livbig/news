"""Меню и команды вне опроса: /sources, /digest, колбэки меню."""
import asyncio
import logging

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import collect, db, digest, keyboards, tgsend
from ..config import FEED_URL
from . import onboarding
from .onboarding import _drop, allowed

log = logging.getLogger("bot.menu")

router = Router()


def _sources_list_text(rows) -> str:
    lines = []
    for title, kind, url, origin, enabled in rows:
        mark = "" if enabled else " (выключен)"
        tag = "опрос" if origin == "survey" else "свой"
        lines.append(f"• {title} — {kind}, {tag}{mark}")
    return f"Источники ({len(rows)}):\n\n" + "\n".join(lines)


@router.message(Command("sources"))
async def cmd_sources(message: Message, state: FSMContext):
    await _drop(state)
    if not allowed(message.chat.id):
        return
    rows = await asyncio.to_thread(db.list_sources, onboarding.conn, message.chat.id)
    if rows:
        await message.answer(_sources_list_text(rows),
                             reply_markup=keyboards.sources_list_kb())
    else:
        await message.answer(
            "Источников пока нет — пройдите опрос: /start",
            reply_markup=keyboards.sources_list_kb(),
        )


@router.message(Command("digest"))
async def cmd_digest(message: Message, state: FSMContext):
    await _drop(state)
    if not allowed(message.chat.id):
        return
    source_id = db.ensure_bootstrap(onboarding.conn, FEED_URL)
    try:
        new = await asyncio.to_thread(collect.collect_source, onboarding.conn, source_id, FEED_URL)
    except Exception as exc:
        log.error("FAIL %s: %s", FEED_URL, exc)
        await message.answer(f"Источник недоступен: {exc}")
        return
    text = await asyncio.to_thread(digest.build_mock, onboarding.conn, source_id)
    if text is None:
        await message.answer("Новых статей нет.")
    else:
        await asyncio.to_thread(tgsend.send_chat, text, message.chat.id)
        log.info("/digest: +%d новых, сводка отправлена", new)


@router.callback_query(F.data == "menu:list")
async def cq_menu_list(cb: CallbackQuery, state: FSMContext):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    rows = await asyncio.to_thread(db.list_sources, onboarding.conn, cb.message.chat.id)
    text = _sources_list_text(rows) if rows else "Источников пока нет — пройдите опрос: /start"
    await cb.message.edit_text(text, reply_markup=keyboards.sources_list_kb())
    await cb.answer()


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
