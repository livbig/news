"""Фоновые задачи процесса бота: FSM-таймаут sweeper (D17), планировщик
двухфазных слотов (D25) с catch-up (FR-12)."""
import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone

log = logging.getLogger("bot.scheduler")

FSM_TIMEOUT_SECONDS = int(os.environ.get("BOT_FSM_TIMEOUT", "600"))
SWEEP_INTERVAL = int(os.environ.get("BOT_FSM_SWEEP", "60"))
PREP_LEAD = int(os.environ.get("BOT_PREP_LEAD", "600"))    # подготовка за 10 мин до слота (D25)
SLOT_TICK = int(os.environ.get("BOT_SLOT_TICK", "20"))     # точность слота ±1 мин (FR-10)
SEND_RETRY = int(os.environ.get("BOT_SEND_RETRY", "600"))  # повтор доставки при сбое (D25)
# iter-11c (D44): фоновый сбор между слотами — prep остаётся только за LLM
COLLECT_INTERVAL = int(os.environ.get("BOT_COLLECT_INTERVAL", "1800"))
# iter-11e (D47): retention-проход
RETENTION_INTERVAL = int(os.environ.get("BOT_RETENTION_INTERVAL", str(6 * 3600)))

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

# слоты — локальное время Mac (D18-сужение; tz_offset_min — с FR-18, И9)
_state: dict[int, dict] = {}     # chat_id → подготовленная сводка {slot, text, ids}
_retry: dict[int, datetime] = {}  # chat_id → время повторной попытки доставки


# --- слоты: чистые функции (TC-09) ---------------------------------------------

def parse_times(send_times_json) -> list[str]:
    """send_times (JSON) → отсортированные валидные HH:MM."""
    try:
        values = json.loads(send_times_json or "[]")
    except (TypeError, ValueError):
        return []
    return sorted({v for v in values if isinstance(v, str) and _HHMM.match(v)})


def next_slot(now: datetime, times) -> datetime | None:
    """Ближайший слот строго после now (локальное время Mac, D18)."""
    best = None
    for value in times:
        hour, minute = (int(x) for x in value.split(":"))
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        if best is None or candidate < best:
            best = candidate
    return best


def is_due(now: datetime, times, anchor_local: datetime | None) -> bool:
    """Окно созрело: now ≥ следующий слот после точки отсчёта — прошлой
    отправки или онбординга (FR-12, D9). None → ждать нечего (вне расписания)."""
    if anchor_local is None:
        return False
    boundary = next_slot(anchor_local, times)
    return boundary is not None and now >= boundary


def _to_local(iso_utc: str | None) -> datetime | None:
    if not iso_utc:
        return None
    try:
        moment = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.astimezone()


def _iso_utc(local: datetime) -> str:
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- FSM-таймаут (И2) -----------------------------------------------------------

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


# --- планировщик слотов (И4, D25) ------------------------------------------------

async def _prepare(conn, chat_id, slot, now):
    """Фаза подготовки (D25, сбор убран в 11c/D44): только текст сводки
    (LLM/mock — И5); свежесть данных обеспечивает фоновый collect_loop."""
    from . import digest

    try:
        text, ids = await asyncio.to_thread(digest.build_delta, conn, chat_id)
    except Exception as exc:
        log.error("prep chat=%s: %s", chat_id, exc)
        return None
    return {"slot": slot, "text": text or digest.EMPTY_TEXT, "ids": ids}


async def _deliver(conn, chat_id, prep, now) -> bool:
    """Доставка подготовленного + транзакционная фиксация окна (FR-12)."""
    from . import db, tgsend

    if not await asyncio.to_thread(tgsend.send_chat, prep["text"], chat_id):
        log.error("deliver chat=%s: доставка не удалась", chat_id)
        return False
    await asyncio.to_thread(
        db.record_digest, conn, chat_id, prep["text"], prep["ids"], _iso_utc(now)
    )
    log.info("digest chat=%s: плановая сводка отправлена (%d пунктов)", chat_id, len(prep["ids"]))
    return True


async def slots_once(conn, now: datetime | None = None) -> list[int]:
    """Один тик планировщика по onboarded-чатам. Инжект now — для тестов.
    Возвращает chat_id с доставленной сводкой."""
    from . import db

    now = now or datetime.now().astimezone()
    lead = timedelta(seconds=PREP_LEAD)
    sent = []
    for row in db.scheduled_users(conn):
        chat_id = row["chat_id"]
        times = parse_times(row["send_times"])
        if not times:
            continue
        retry_at = _retry.get(chat_id)
        if retry_at is not None and now < retry_at:
            continue
        _retry.pop(chat_id, None)
        last = _to_local(row["last_sent_at"]) or _to_local(row["onboarded_at"])
        upcoming = next_slot(now, times)
        prep = _state.get(chat_id)
        # фаза 1 (D25): до ближайшего слота ≤ PREP_LEAD — подготовить и ждать
        if prep is None and upcoming is not None and timedelta(0) < upcoming - now <= lead:
            made = await _prepare(conn, chat_id, upcoming, now)
            if made is not None:
                _state[chat_id] = made
            continue
        # фаза 2: слот настал — отправить подготовленное
        if prep is not None and now >= prep["slot"]:
            _state.pop(chat_id, None)
            if is_due(now, times, last):
                if await _deliver(conn, chat_id, prep, now):
                    sent.append(chat_id)
                else:  # повтор доставки через SEND_RETRY (D25)
                    _state[chat_id] = prep
                    _retry[chat_id] = now + timedelta(seconds=SEND_RETRY)
            continue
        # catch-up (FR-12): слот давно прошёл — одна сводка за всё окно
        if prep is None and is_due(now, times, last) and (upcoming is None or upcoming - now > lead):
            made = await _prepare(conn, chat_id, upcoming, now)
            if made is None:
                continue
            if await _deliver(conn, chat_id, made, now):
                sent.append(chat_id)
            else:
                _state[chat_id] = made
                _retry[chat_id] = now + timedelta(seconds=SEND_RETRY)
    return sent


async def collect_once(conn) -> int:
    """Один проход фонового сбора (D44): включённые источники всех
    onboarded-чатов. Отказ чата/источника изолирован; возвращает total."""
    from . import collect

    total, errors = 0, 0
    for row in _scheduled(conn):
        try:
            added, errs = await asyncio.to_thread(
                collect.collect_enabled, conn, row["chat_id"])
            total += added
            errors += len(errs)
        except Exception as exc:
            log.error("collect chat=%s: %s", row["chat_id"], exc)
    log.info("collect: +%d новых, %d ошибок", total, errors)
    from . import enrich  # iter-14b: докачка текстов после сбора

    try:
        await asyncio.to_thread(enrich.enrich_once, conn)
    except Exception as exc:
        log.error("enrich: %s", exc)
    try:
        await asyncio.to_thread(enrich.map_once, conn)  # iter-14c: выжимки
    except Exception as exc:
        log.error("map: %s", exc)
    return total


def _scheduled(conn):
    from . import db

    return db.scheduled_users(conn)


async def collect_loop(conn) -> None:
    from . import db
    from .handlers import onboarding  # лениво: цикл импортов + актуальный хендл

    log.info("collect: фоновый сбор каждые %dc", COLLECT_INTERVAL)
    while True:
        try:
            await collect_once(conn)
        except Exception as exc:
            log.error("collect: %s", exc)
            fresh = db.reconnect(conn)  # обрыв сети → битый PG-коннект (2026-09-14)
            if fresh is not conn:
                conn = fresh
                onboarding.conn = fresh  # хендлеры берут соединение отсюда же
                log.info("collect: соединение с БД пересоздано")
        await asyncio.sleep(COLLECT_INTERVAL)


async def retention_once(conn) -> dict:
    """Один проход retention (D47): надгробия + чистка items/digests/
    chat_history/seen_hashes. Счётчики — в лог."""
    from . import db

    counts = await asyncio.to_thread(db.cleanup, conn)
    log.info("retention: %s", counts)
    return counts


async def retention_loop(conn) -> None:
    from . import db
    from .handlers import onboarding  # лениво: цикл импортов + актуальный хендл

    log.info("retention: проход каждые %dc", RETENTION_INTERVAL)
    while True:
        try:
            await retention_once(conn)
        except Exception as exc:
            log.error("retention: %s", exc)
            fresh = db.reconnect(conn)  # обрыв сети → битый PG-коннект (2026-09-14)
            if fresh is not conn:
                conn = fresh
                onboarding.conn = fresh  # хендлеры берут соединение отсюда же
                log.info("retention: соединение с БД пересоздано")
        await asyncio.sleep(RETENTION_INTERVAL)


async def slots_loop(conn) -> None:
    from . import db
    from .handlers import onboarding  # лениво: цикл импортов + актуальный хендл

    log.info(
        "slots: подготовка за %dc, тик %dc (точность ±1 мин), повтор доставки %dc",
        PREP_LEAD, SLOT_TICK, SEND_RETRY,
    )
    while True:
        try:
            await slots_once(conn)
        except Exception as exc:
            log.error("slots: %s", exc)
            fresh = db.reconnect(conn)  # обрыв сети → битый PG-коннект (2026-09-14)
            if fresh is not conn:
                conn = fresh
                onboarding.conn = fresh  # хендлеры берут соединение отсюда же
                log.info("slots: соединение с БД пересоздано")
        await asyncio.sleep(SLOT_TICK)
