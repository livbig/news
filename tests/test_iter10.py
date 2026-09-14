"""Итерация 10 (фаза доводки 2026-09-14): TC-35 — «сводка сейчас» фиксирует
окно (FR-19/D10), TC-36 — /stats (FR-20); <br> от LLM → перенос строки
(инцидент 2026-09-14); setMyCommands — меню-кнопка с командами.
tests/TESTPLAN.md §2.3 и §5 (строка 8/9/10)."""
import asyncio
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fakes.py

VALID_XML = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Valid Feed</title>
<item><title>Первая новость</title><link>http://ex.test/1</link>
<pubDate>Thu, 10 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>Вторая новость</title><link>http://ex.test/2</link>
<pubDate>Fri, 11 Sep 2026 10:00:00 GMT</pubDate></item>
</channel></rss>""").encode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = VALID_XML if self.path.endswith(".xml") else b"nope"
        self.send_response(200 if body != b"nope" else 404)
        self.send_header("Content-Type", "application/rss+xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def setUpModule():
    global SERVER, BASE, _SAVED
    SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=SERVER.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{SERVER.server_address[1]}"
    from bot import config as bconfig
    from pipeline import config as pconfig
    _SAVED = (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY)
    bconfig.TOKEN = ""
    bconfig.ALLOWED_CHAT_ID = ""
    pconfig.LLM_API_KEY = ""


def tearDownModule():
    SERVER.shutdown()
    SERVER.server_close()
    from bot import config as bconfig
    from pipeline import config as pconfig
    bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY = _SAVED


# --- интеграционная инфраструктура (как в test_iter5: fake-обновления + FakeBot) --

from aiogram.types import Update  # noqa: E402
from fakes import FakeBot, make_callback, make_message, shared_dispatcher  # noqa: E402


class ChatCase(unittest.TestCase):
    CHAT = 1010
    USER = 10

    def setUp(self):
        from aiogram.fsm.storage.base import StorageKey
        from bot import db, handlers, tgsend
        from bot.handlers import onboarding

        handlers.init(db.connect(":memory:"))
        self.db = db
        self.dp = shared_dispatcher()
        self.bot = FakeBot()
        self._update_id = 0
        key = StorageKey(bot_id=self.bot.id, chat_id=self.CHAT, user_id=self.USER)
        asyncio.run(self.dp.storage.set_state(key, None))
        asyncio.run(self.dp.storage.set_data(key, {}))
        onboarding.ACTIVE.clear()
        self.sent: list[tuple] = []
        self._real_post = tgsend._post
        tgsend._post = lambda text, chat_id, parse_mode: (
            self.sent.append((text, parse_mode)), True)[1]
        tgsend.config.TOKEN = "test"

    def tearDown(self):
        from bot import tgsend
        tgsend._post = self._real_post
        tgsend.config.TOKEN = ""

    def feed(self, **event):
        self._update_id += 1
        asyncio.run(self.dp.feed_update(
            self.bot, Update(update_id=self._update_id, **event)))

    def send(self, text):
        self.feed(message=make_message(self.CHAT, self.USER, text))

    def press(self, data):
        self.feed(callback_query=make_callback(self.CHAT, self.USER, data))

    def conn(self):
        from bot.handlers import onboarding
        return onboarding.conn

    def seed(self, sources=1, items_per=2):
        """Onboarded-чат + источники с элементами; возвращает sids."""
        from bot import db

        now = db.now_iso()
        self.conn().execute(
            "INSERT INTO users (chat_id, tz_offset_min, send_times, created_at,"
            " onboarded_at) VALUES (%s, 180, '[\"09:00\"]', %s, %s)",
            (self.CHAT, now, now))
        self.conn().commit()
        sids = []
        for n in range(sources):
            sid = self.db.add_source(
                self.conn(), self.CHAT, "rss", f"{BASE}/feed{n}.xml", f"Feed {n}")
            for m in range(items_per):
                self.db.insert_item(
                    self.conn(), sid, f"http://ex.test/{sid}/{m}",
                    f"Новость {sid}.{m}", now)
            sids.append(sid)
        return sids


# --- TC-35 (integration): «сводка сейчас» фиксирует окно (FR-19/D10) -------------

class TC35SummaryNow(ChatCase):

    def test_button_records_window(self):
        self.seed()
        self.press("menu:digest")

        self.assertEqual(len(self.sent), 1)
        rows = self.conn().execute(
            "SELECT COUNT(*) FROM digests WHERE chat_id=%s", (self.CHAT,)).fetchall()
        self.assertEqual(rows[0][0], 1)  # сводка зафиксирована
        last = self.conn().execute(
            "SELECT last_sent_at FROM users WHERE chat_id=%s", (self.CHAT,)).fetchone()
        self.assertIsNotNone(last[0])  # окно сдвинуто (D10)

        self.sent.clear()
        self.press("menu:digest")  # повтор: дельта уже потреблена
        self.assertEqual(self.sent[0][0], "Новых новостей с прошлой сводки нет.")

    def test_command_digest_is_preview(self):
        self.seed()
        self.send("/digest")

        self.assertEqual(len(self.sent), 1)  # сводка пришла…
        rows = self.conn().execute(
            "SELECT COUNT(*) FROM digests WHERE chat_id=%s", (self.CHAT,)).fetchall()
        self.assertEqual(rows[0][0], 0)  # …но окно НЕ сдвинуто (D8)
        last = self.conn().execute(
            "SELECT last_sent_at FROM users WHERE chat_id=%s", (self.CHAT,)).fetchone()
        self.assertIsNone(last[0])


# --- TC-36 (integration): /stats — счётчики per источник (FR-20) -----------------

class TC36Stats(ChatCase):

    def test_stats_counts_per_source(self):
        sid_a, sid_b = self.seed(sources=2, items_per=2)
        # у второго источника один элемент «старый» (вне 24 ч)
        self.conn().execute(
            "UPDATE items SET fetched_at=%s WHERE source_id=%s AND url=%s",
            (self.db.minus_iso(self.db.now_iso(), 48), sid_b,
             f"http://ex.test/{sid_b}/1"))
        self.conn().commit()

        self.send("/stats")

        self.assertEqual(len(self.sent), 1)
        text = self.sent[0][0]
        self.assertIn("за 24 часа", text)
        self.assertIn("Feed 0", text)
        self.assertIn("2 за 24 ч, всего 2", text)
        self.assertIn("Feed 1", text)
        self.assertIn("1 за 24 ч, всего 2", text)

    def test_stats_without_sources(self):
        self.send("/stats")
        self.assertEqual(self.sent[0][0], "Источников пока нет — добавьте через /sources.")


# --- <br> от LLM → перенос строки (инцидент 2026-09-14) ---------------------------

class BRNormalization(unittest.TestCase):

    def test_normalize_variants(self):
        from bot import llm

        self.assertEqual(llm._normalize("a<br>b"), "a\nb")
        self.assertEqual(llm._normalize("a<br/>b"), "a\nb")
        self.assertEqual(llm._normalize("a<br />b"), "a\nb")
        self.assertEqual(llm._normalize("a<BR>b"), "a\nb")
        self.assertEqual(llm._normalize("a <b>жирный</b>"), "a <b>жирный</b>")  # теги a/b/i не трогаем

    def test_summarize_normalizes(self):
        from pipeline import config as pconfig

        from bot import llm
        real_call, real_key = llm._call, pconfig.LLM_API_KEY
        llm._call = lambda *a, **k: "Лид<br>Пункт два<br/>Итог."
        pconfig.LLM_API_KEY = "test-key"
        try:
            out = llm.summarize("заголовок — http://ex.test/1")
        finally:
            llm._call, pconfig.LLM_API_KEY = real_call, real_key
        self.assertEqual(out, "Лид\nПункт два\nИтог.")


# --- setMyCommands: команды в меню-кнопке (запрос юзера 2026-09-14) ---------------

class SetupCommands(unittest.TestCase):

    def test_registers_command_list(self):
        from bot import handlers

        bot = FakeBot()
        asyncio.run(handlers.setup_commands(bot))
        calls = [v for t, v in bot.calls if t == "SetMyCommands"]
        self.assertEqual(len(calls), 1)
        names = [c["command"] for c in calls[0]["commands"]]
        self.assertEqual(names, ["start", "sources", "settings", "digest", "stats"])


# --- reconnect: битое PG-соединение после обрыва сети (инцидент 2026-09-14) -------

class Reconnect(unittest.TestCase):

    def test_sqlite_and_none_passthrough(self):
        from bot import db

        conn = db.connect(":memory:")
        self.assertIs(db.reconnect(conn), conn)  # sqlite — живое всегда
        self.assertFalse(db.is_broken(conn))
        self.assertFalse(db.is_broken(None))

    def test_broken_conn_replaced(self):
        from unittest import mock

        from bot import db

        old = mock.MagicMock()  # close() есть, execute() падать не должен — мокаем is_broken
        fresh = object()
        with mock.patch.object(db, "is_broken", return_value=True), \
                mock.patch.object(db, "connect", return_value=fresh):
            self.assertIs(db.reconnect(old), fresh)
        old.close.assert_called_once()

    def test_connect_failure_keeps_old(self):
        from unittest import mock

        from bot import db

        old = mock.MagicMock()
        with mock.patch.object(db, "is_broken", return_value=True), \
                mock.patch.object(db, "connect", side_effect=RuntimeError("сеть недоступна")):
            self.assertIs(db.reconnect(old), old)  # повтор на следующем тике


if __name__ == "__main__":
    unittest.main()
