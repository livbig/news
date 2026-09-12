"""Фоновые задачи процесса бота. И2: FSM-таймаут sweeper (D17); слоты — И4."""
import asyncio
import logging
import os
import time

log = logging.getLogger("bot.scheduler")

FSM_TIMEOUT_SECONDS = int(os.environ.get("BOT_FSM_TIMEOUT", "600"))
SWEEP_INTERVAL = int(os.environ.get("BOT_FSM_SWEEP", "60"))


def _onboarding():
    from .handlers import onboarding  # лениво: разрывает цикл импортов

    return onboarding


async def sweep_once(bot, storage) -> int:
    """Один проход свипера: завершает просроченные сессии опроса."""
    onboarding = _onboarding()
    now = time.time()
    expired = [
        (chat_id, user_id)
        for (chat_id, user_id), ts in onboarding.ACTIVE.items()
        if now - ts > FSM_TIMEOUT_SECONDS
    ]
    for chat_id, user_id in expired:
        try:
            await onboarding.expire_session(bot, storage, chat_id, user_id)
        except Exception as exc:
            log.error("FSM-таймаут chat=%s: %s", chat_id, exc)
    return len(expired)


async def fsm_sweeper(bot, storage):
    log.info(
        "FSM-sweeper: таймаут %dc, интервал %dc", FSM_TIMEOUT_SECONDS, SWEEP_INTERVAL
    )
    while True:
        await asyncio.sleep(SWEEP_INTERVAL)
        try:
            await sweep_once(bot, storage)
        except Exception as exc:  # pragma: no cover — страховка цикла
            log.error("sweeper: %s", exc)
