"""Роутеры и долгоживущий цикл бота."""
import asyncio
import logging

from aiogram import BaseMiddleware, Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage

from .. import config
from ..scheduler import collect_loop, fsm_sweeper, retention_loop, slots_loop
from . import menu, onboarding, settings, sources

log = logging.getLogger("bot.handlers")


class _AllowedOnlyMiddleware(BaseMiddleware):
    """Внешний гейт единственного пользователя (iter-19): отсекает апдейты
    чужих чатов ДО роутеров — закрывает и FSM-хендлеры без своего allowed()
    (попасть в состояние чужому неоткуда, но точечные проверки легко
    потерять при добавлении хендлеров). Per-handler allowed() в роутерах
    остаётся вторым контуром."""

    async def __call__(self, handler, event, data):
        chat = getattr(event, "chat", None)  # Message
        if chat is None:  # CallbackQuery
            msg = getattr(event, "message", None)
            chat = msg.chat if msg is not None else None
        chat_id = chat.id if chat is not None else None
        if chat_id is None:  # колбэк без message — по отправителю
            user = getattr(event, "from_user", None)
            chat_id = user.id if user is not None else None
        if chat_id is None:  # ни чата, ни отправителя — не рискуем (fail-closed)
            log.warning("Апдейт без chat_id/from_user отклонён гейтом")
            return
        if not onboarding.allowed(chat_id):
            log.warning("Апдейт чужого чата %s отклонён гейтом", chat_id)
            return
        return await handler(event, data)


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
        _dispatcher.message.outer_middleware(_AllowedOnlyMiddleware())
        _dispatcher.callback_query.outer_middleware(_AllowedOnlyMiddleware())
        _dispatcher.include_router(onboarding.router)  # команды и FSM-опрос — раньше прочих
        _dispatcher.include_router(sources.router)  # CRUD источников и мастер добавления
        _dispatcher.include_router(settings.router)  # настройки расписания
        _dispatcher.include_router(menu.router)  # его catch-all колбэков — последним
    return _dispatcher


async def setup_commands(bot) -> None:
    """Команды в меню-кнопке Telegram (setMyCommands; запрос юзера 2026-09-14:
    значок «/» со списком команд). Сеть/Bot API не должны мешать поллингу."""
    from aiogram.types import BotCommand

    try:
        await bot.set_my_commands([
            BotCommand(command="start", description="Опрос заново и главное меню"),
            BotCommand(command="sources", description="Мои источники"),
            BotCommand(command="settings", description="Расписание сводок"),
            BotCommand(command="digest", description="Предпросмотр сводки"),
            BotCommand(command="stats", description="Статистика источников"),
        ])
        log.info("menu commands: 5 команд зарегистрированы")
    except Exception as exc:
        log.warning("setMyCommands не удался: %s", exc)


async def run():
    bot = Bot(config.TOKEN)
    dp = build_dispatcher()
    # iter-21: гейт fail-closed не должен отказывать молча — иначе бот жив
    # (status active), собирает новости и пишет в пустоту; виноват обычно
    # пустой TELEGRAM_CHAT_ID или подменённый .env при rsync.
    if config.TOKEN and not config.ALLOWED_CHAT_ID:
        log.error("Гейт закрыт: TELEGRAM_CHAT_ID пуст — ни один чат не обслужен")
    sweeper = asyncio.create_task(fsm_sweeper(bot, dp.storage))
    slots = asyncio.create_task(slots_loop(onboarding.conn))
    collector = asyncio.create_task(collect_loop(onboarding.conn))  # 11c/D44
    retention = asyncio.create_task(retention_loop(onboarding.conn))  # 11e/D47
    await setup_commands(bot)
    log.info("Бот запускается (long polling)")
    try:
        await dp.start_polling(bot)
    finally:
        sweeper.cancel()
        slots.cancel()
        collector.cancel()
        retention.cancel()
