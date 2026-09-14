"""Роутеры и долгоживущий цикл бота."""
import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage

from .. import config
from ..scheduler import fsm_sweeper, slots_loop
from . import menu, onboarding, settings, sources

log = logging.getLogger("bot.handlers")


def init(connection):
    onboarding.conn = connection


# Роутеры aiogram нельзя подключить к двум Dispatcher — на процесс один
# диспетчер (тот же принцип, что tests/fakes.shared_dispatcher).
_dispatcher = None


def build_dispatcher(storage=None):
    """Сборка Dispatcher без polling — Mac-режим (polling) вызывает её
    с MemoryStorage; storage учитывается только при первой сборке."""
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
    log.info("Бот запускается (long polling)")
    try:
        await dp.start_polling(bot)
    finally:
        sweeper.cancel()
        slots.cancel()
