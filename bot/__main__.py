"""Запуск: python3 -m bot. Без токена — разовый mock-прогон (сводка в stdout)."""
import pipeline  # noqa: F401 — IP-пиннинг api.telegram.org (решение D23); первой строкой, до сети

import asyncio
import logging
import sys

from pipeline.config import setup_logging

from . import collect, config, db, digest, handlers, tgsend

log = logging.getLogger("bot")


def run_mock(conn) -> int:
    source_id = db.ensure_bootstrap(conn, config.FEED_URL)
    try:
        new = collect.collect_source(conn, source_id, config.FEED_URL)
    except Exception as exc:
        log.error("FAIL %s: %s", config.FEED_URL, exc)
        print(f"Источник недоступен: {exc}")
        return 1
    text, _ids = digest.build_delta(conn, 0)  # mock-прогон живёт под служебным chat_id=0
    if text is None:
        print(digest.EMPTY_TEXT)
    else:
        tgsend.send_chat(text, 0)  # chat_id=0 → mock-режим: stdout
        print(f"\n[+{new} новых, mock-режим]")
    return 0


def main() -> int:
    setup_logging()
    conn = db.connect()
    handlers.init(conn)
    if not config.TOKEN:
        log.warning("TELEGRAM_TOKEN(_DEV) не заданы — mock-режим: сводка в stdout")
        return run_mock(conn)
    log.info("Бот запускается (long polling)")
    asyncio.run(handlers.run())
    return 0


if __name__ == "__main__":
    sys.exit(main())
