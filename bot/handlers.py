import asyncio
import logging

from aiogram import Bot, Dispatcher, Router
from aiogram.filters import Command
from aiogram.types import Message

from . import collect, db, digest, tgsend
from .config import ALLOWED_CHAT_ID, FEED_URL, TOKEN

log = logging.getLogger("bot.handlers")

router = Router()
conn = None  # назначается init() из __main__

WELCOME = (
    "Персональный новостной ассистент — в разработке (итерация 1).\n\n"
    "/digest — собрать захардкоженный RSS и прислать mock-сводку"
)


def init(connection):
    global conn
    conn = connection


def _allowed(message: Message) -> bool:
    return not ALLOWED_CHAT_ID or str(message.chat.id) == ALLOWED_CHAT_ID


@router.message(Command("start"))
async def cmd_start(message: Message):
    if not _allowed(message):
        return
    await message.answer(WELCOME)


@router.message(Command("digest"))
async def cmd_digest(message: Message):
    if not _allowed(message):
        return
    source_id = db.ensure_bootstrap(conn, FEED_URL)
    try:
        new = await asyncio.to_thread(collect.collect_source, conn, source_id, FEED_URL)
    except Exception as exc:
        log.error("FAIL %s: %s", FEED_URL, exc)
        await message.answer(f"Источник недоступен: {exc}")
        return
    text = await asyncio.to_thread(digest.build_mock, conn, source_id)
    if text is None:
        await message.answer("Новых статей нет.")
    else:
        await asyncio.to_thread(tgsend.send_chat, text, message.chat.id)
        log.info("/digest: +%d новых, сводка отправлена", new)


async def run():
    bot = Bot(TOKEN)
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(bot)
