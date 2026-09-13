"""Роутеры и долгоживущий цикл бота."""
import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage

from .. import config, webapp
from ..scheduler import fsm_sweeper, slots_loop
from . import menu, onboarding, settings, sources

log = logging.getLogger("bot.handlers")


def init(connection):
    onboarding.conn = connection


# М4: роутеры aiogram нельзя подключить к двум Dispatcher — на процесс один
# диспетчер (тот же принцип, что tests/fakes.shared_dispatcher); Mac-режим
# вызывает build_dispatcher() (MemoryStorage), webhook Vercel — с PgStorage.
_dispatcher = None


def build_dispatcher(storage=None):
    """Сборка Dispatcher без polling — общая для Mac-режима (polling) и
    webhook-режима Vercel; storage учитывается только при первой сборке."""
    global _dispatcher
    if _dispatcher is None:
        _dispatcher = Dispatcher(storage=storage or MemoryStorage())
        _dispatcher.include_router(onboarding.router)  # команды и FSM-опрос — раньше прочих
        _dispatcher.include_router(sources.router)  # CRUD источников и мастер добавления
        _dispatcher.include_router(settings.router)  # настройки расписания
        _dispatcher.include_router(menu.router)  # его catch-all колбэков — последним
    return _dispatcher


async def run():
    bot = Bot(config.TOKEN)
    dp = build_dispatcher()
    sweeper = asyncio.create_task(fsm_sweeper(bot, dp.storage))
    slots = asyncio.create_task(slots_loop(onboarding.conn))
    webapp.start(onboarding.conn)  # И8: Mini App; не поднялся → fallback-кнопка (FR-17)
    await menu.setup_menu_button(bot)  # И8b: https-URL → меню-кнопка открывает Mini App с телефона
    log.info("Бот запускается (long polling)")
    try:
        await dp.start_polling(bot)
    finally:
        webapp.stop()
        sweeper.cancel()
        slots.cancel()
