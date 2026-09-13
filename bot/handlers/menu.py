"""Меню и команды вне опроса/источников: /digest, колбэки меню (настройки — settings.py)."""
import asyncio
import logging

from aiogram import F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import (CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup,
                           MenuButtonDefault, MenuButtonWebApp, Message, WebAppInfo)

from .. import collect, digest, keyboards, llm, tgsend, webapp
from . import onboarding
from .onboarding import _drop, allowed

log = logging.getLogger("bot.menu")

router = Router()


async def run_digest(bot, chat_id: int) -> None:
    """Предпросмотр дельты (D8): сбор + сводка без сдвига окна.
    «Печатает…» при долгом сборе/LLM (FR-15), деградация источников —
    футером сводки (план §1.5), отказы изолированы (NFR-02)."""
    async with tgsend.with_typing(bot, chat_id):
        total, errors = await asyncio.to_thread(collect.collect_enabled, onboarding.conn, chat_id)
        text, _ids = await asyncio.to_thread(digest.build_delta, onboarding.conn, chat_id)
        text = digest.with_footer(text or digest.EMPTY_TEXT, errors)
        await asyncio.to_thread(tgsend.send_chat, text, chat_id)
    log.info("digest chat=%s: +%d новых, предпросмотр отправлен", chat_id, total)


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


@router.callback_query(F.data == "menu:main")
async def cq_menu_main(cb: CallbackQuery, state: FSMContext):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    await cb.message.edit_text("Главное меню.", reply_markup=keyboards.menu_kb(onboarded=True))
    await cb.answer()


# --- И8: Mini App (FR-17) — кнопка с fallback в бот-интерфейс ---------------------

@router.callback_query(F.data == "menu:webapp")
async def cq_webapp(cb: CallbackQuery, state: FSMContext):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    await _drop(state)
    if not webapp.running() or not webapp.URL:
        await cb.answer("Веб-панель недоступна — управление в боте", show_alert=True)
        await cb.message.edit_text("Главное меню.", reply_markup=keyboards.menu_kb(onboarded=True))
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="Открыть веб-панель", web_app=WebAppInfo(url=webapp.URL))
    ]])
    try:
        await cb.message.answer("Веб-панель: источники и расписание.", reply_markup=kb)
    except TelegramBadRequest:
        # web_app-кнопка требует https; без публичного URL (локальный путь) — текстом
        await cb.message.answer(
            f"Веб-панель: {webapp.URL} — " +
            ("откройте в браузере на этом Mac (авторизация — из Telegram Desktop)."
             if webapp.URL.startswith("http://") else
             "сервис недоступен — управление в боте."))
    await cb.answer()


# --- И8b: меню-кнопка Telegram → Mini App (FR-17: «открывается из меню») ----------

async def setup_menu_button(bot) -> None:
    """Публичный https-URL задан → меню-кнопка бота открывает Mini App (с телефона,
    в любом чате с ботом); нет — сброс на стандартное меню команд (без мёртвой
    кнопки от прошлого URL)."""
    url = webapp.public_url() if webapp.running() else None
    try:
        if url:
            await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(
                text="Новости", web_app=WebAppInfo(url=url)))
        else:
            await bot.set_chat_menu_button(menu_button=MenuButtonDefault())
        log.info("menu button: %s", url or "стандартное меню команд")
    except Exception as exc:  # сеть/Bot API — поллинг важнее кнопки
        log.warning("setChatMenuButton не удался: %s", exc)


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
