"""Запуск: python3 -m bot. Без токена — разовый mock-прогон (сводка в stdout)."""
import pipeline  # noqa: F401 — IP-пиннинг api.telegram.org (решение D23); первой строкой, до сети

import asyncio
import logging
import os
import sys
import threading

from pipeline.config import setup_logging

from . import collect, config, db, digest, handlers, scheduler, tgsend

log = logging.getLogger("bot")


def start_health(port: int):
    """HTTP-маяк для Docker-хостинга (HF Space требует живой порт, иначе
    рестартует контейнер; keep-alive-пинг бьёт сюда же). Только stdlib,
    никаких данных наружу. Возвращает сервер (тесты)."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True,
                     name="bot-health").start()
    log.info("health: 0.0.0.0:%s", port)
    return server


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
    if os.environ.get("BOT_HEALTH_PORT"):
        start_health(int(os.environ["BOT_HEALTH_PORT"]))
    conn = db.connect()
    handlers.init(conn)
    try:
        asyncio.run(scheduler.retention_once(conn))  # 11e/D47; fix 14b: это корутина
    except Exception as exc:
        log.error("retention на старте: %s", exc)
    if not config.TOKEN:
        log.warning("TELEGRAM_TOKEN(_DEV) не заданы — mock-режим: сводка в stdout")
        return run_mock(conn)
    log.info("Бот запускается (long polling)")
    asyncio.run(handlers.run())
    return 0


if __name__ == "__main__":
    sys.exit(main())
