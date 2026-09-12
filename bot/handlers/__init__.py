"""Роутеры и долгоживущий цикл бота."""
import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage

from .. import config
from ..scheduler import fsm_sweeper
from . import menu, onboarding

log = logging.getLogger("bot.handlers")


def init(connection):
    onboarding.conn = connection


async def run():
    bot = Bot(config.TOKEN)
    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(onboarding.router)  # команды и FSM-опрос — раньше прочих
    dp.include_router(menu.router)
    sweeper = asyncio.create_task(fsm_sweeper(bot, dp.storage))
    log.info("Бот запускается (long polling)")
    try:
        await dp.start_polling(bot)
    finally:
        sweeper.cancel()
