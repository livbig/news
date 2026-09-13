"""Итерация 3: TC-08 (ретраи HTTP), TC-11/TC-12 (свои RSS, мастер),
TC-22 (вкл/выкл), TC-23 (удаление), TC-32 (команды) — tests/TESTPLAN.md."""
import asyncio
import io
import sys
import threading
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
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
<item><title>Третья новость</title><link>http://ex.test/3</link></item>
</channel></rss>""").encode()

VALID2_XML = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Second Feed</title>
<item><title>Другая новость</title><link>http://ex2.test/1</link></item>
<item><title>Ещё новость</title><link>http://ex2.test/2</link></item>
</channel></rss>""").encode()


class Handler(BaseHTTPRequestHandler):
    HITS: dict[str, int] = {}

    def do_GET(self):
        Handler.HITS[self.path] = Handler.HITS.get(self.path, 0) + 1
        path = self.path
        if path == "/valid.xml":
            status, ctype, body = 200, "application/rss+xml", VALID_XML
        elif path == "/valid2.xml":
            status, ctype, body = 200, "application/rss+xml", VALID2_XML
        elif path == "/page.html":
            status, ctype, body = 200, "text/html", b"<html><body>not a feed</body></html>"
        elif path == "/missing":
            status, ctype, body = 404, "text/plain", b"nope"
        elif path == "/always500":
            status, ctype, body = 500, "text/plain", b"boom"
        elif path == "/always429":
            status, ctype, body = 429, "text/plain", b"slow down"
        elif path == "/flaky.xml":  # первые два запроса падают, дальше — валидный фид
            if Handler.HITS[path] <= 2:
                status, ctype, body = 500, "text/plain", b"boom"
            else:
                status, ctype, body = 200, "application/rss+xml", VALID_XML
        else:
            status, ctype, body = 404, "text/plain", b"nope"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def setUpModule():
    global SERVER, BASE, _SAVED_CONFIG
    SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=SERVER.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{SERVER.server_address[1]}"
    # реальные токены/чаты из .env не должны утекать в тесты: mock-отправка (NFR-05);
    # с И5 build_delta зовёт LLM — ключ тоже обнуляем (сводка в тестах = mock)
    from bot import config
    from pipeline import config as pconfig
    _SAVED_CONFIG = (config.TOKEN, config.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY)
    config.TOKEN = ""
    config.ALLOWED_CHAT_ID = ""
    pconfig.LLM_API_KEY = ""


def tearDownModule():
    SERVER.shutdown()
    SERVER.server_close()
    from bot import config
    from pipeline import config as pconfig
    config.TOKEN, config.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY = _SAVED_CONFIG


class TC08HttpRetries(unittest.TestCase):
    """Ретраи с нарастающим backoff; 4xx не ретраится; таймауты заданы."""

    def setUp(self):
        from bot.collectors import http as httpmod
        self.httpmod = httpmod
        self._real_sleep = httpmod._sleep
        self.pauses = []
        httpmod._sleep = self.pauses.append  # фейковые таймеры (TESTPLAN §1.5)
        Handler.HITS.clear()

    def tearDown(self):
        self.httpmod._sleep = self._real_sleep

    def test_500_retries_then_raises(self):
        import httpx
        with self.assertRaises(httpx.HTTPStatusError):
            self.httpmod.http_get(f"{BASE}/always500")
        self.assertEqual(Handler.HITS["/always500"], 4)  # 1 запрос + 3 ретрая
        self.assertEqual(self.pauses, [1, 2, 4])  # нарастающий backoff (план §3)

    def test_429_retried(self):
        import httpx
        with self.assertRaises(httpx.HTTPStatusError):
            self.httpmod.http_get(f"{BASE}/always429")
        self.assertEqual(Handler.HITS["/always429"], 4)

    def test_404_not_retried(self):
        import httpx
        with self.assertRaises(httpx.HTTPStatusError):
            self.httpmod.http_get(f"{BASE}/missing")
        self.assertEqual(Handler.HITS["/missing"], 1)
        self.assertEqual(self.pauses, [])

    def test_flaky_succeeds_after_retries(self):
        response = self.httpmod.http_get(f"{BASE}/flaky.xml")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Handler.HITS["/flaky.xml"], 3)
        self.assertEqual(self.pauses, [1, 2])

    def test_timeouts_configured(self):
        self.assertEqual(self.httpmod.TIMEOUT.connect, 15.0)
        self.assertEqual(self.httpmod.TIMEOUT.read, 30.0)


class TC11ValidRSS(unittest.TestCase):
    """Валидный RSS: элементы в items, повторный сбор без дублей, status ok."""

    def test_collect_idempotent(self):
        from bot import collect, db

        conn = db.connect(":memory:")
        sid = db.add_source(conn, 42, "rss", f"{BASE}/valid.xml", "Valid Feed")
        self.assertTrue(sid)
        self.assertEqual(collect.collect_source(conn, sid, f"{BASE}/valid.xml"), 3)
        rows = conn.execute(
            "SELECT title, url, published FROM items WHERE source_id=%s ORDER BY id", (sid,)
        ).fetchall()
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["title"], "Первая новость")
        self.assertTrue(all(len(r["published"]) == 20 and r["published"].endswith("Z") for r in rows))
        self.assertEqual(
            conn.execute("SELECT status FROM sources WHERE id=%s", (sid,)).fetchone()[0], "ok"
        )
        # повторный сбор — дублей нет (NFR-03)
        self.assertEqual(collect.collect_source(conn, sid, f"{BASE}/valid.xml"), 0)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM items WHERE source_id=%s", (sid,)).fetchone()[0], 3
        )


# --- инфраструктура интеграционных кейсов: fake-обновления + FakeBot -----------

from aiogram.types import Update  # noqa: E402
from fakes import FakeBot, make_callback, make_message, shared_dispatcher  # noqa: E402


class ChatCase(unittest.TestCase):
    """Общее: чистая БД, общий диспетчер, fake-поллинг; FSM-состояние сбрасывается."""

    CHAT = 4242
    USER = 7

    def setUp(self):
        from aiogram.fsm.storage.base import StorageKey
        from bot import db, handlers
        from bot.handlers import onboarding

        handlers.init(db.connect(":memory:"))
        self.db = db
        self.dp = shared_dispatcher()
        self.bot = FakeBot()
        self._update_id = 0
        Handler.HITS.clear()
        key = StorageKey(bot_id=self.bot.id, chat_id=self.CHAT, user_id=self.USER)
        asyncio.run(self.dp.storage.set_state(key, None))
        asyncio.run(self.dp.storage.set_data(key, {}))
        onboarding.ACTIVE.clear()
        self._onboarding = onboarding

    def feed(self, **event):
        self._update_id += 1
        asyncio.run(self.dp.feed_update(self.bot, Update(update_id=self._update_id, **event)))

    def send(self, text):
        self.feed(message=make_message(self.CHAT, self.USER, text))

    def press(self, data):
        self.feed(callback_query=make_callback(self.CHAT, self.USER, data))

    def stdout_of(self, fn):
        buf = io.StringIO()
        with redirect_stdout(buf):
            fn()
        return buf.getvalue()

    def _add_fixture_sources(self):
        """Два включённых источника чата; возвращает (id_valid, id_valid2)."""
        id1 = self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/valid.xml", "Valid Feed")
        id2 = self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/valid2.xml", "Second Feed")
        return id1, id2

    def conn(self):
        from bot.handlers import onboarding
        return onboarding.conn


class TC12MasterInvalidURL(ChatCase):
    """Мастер: невалидные входы не ломают FSM; не-XML и 404 — понятная ошибка."""

    def test_master_flow(self):
        self.send("/sources")
        self.assertIn("Источников пока нет", self.bot.sent_texts()[-1])
        self.press("add:start")  # шаг типа
        self.assertIn("Какой тип источника", self.bot.edited_texts()[-1])
        self.press("a:k:rss")  # → ввод адреса (ветка «тип в разработке» снята в И6)
        self.assertIn("ссылку на RSS/Atom-фид", self.bot.edited_texts()[-1])
        for bad in ("htp:/bad-url", "not-a-url"):  # формат URL
            self.send(bad)
            self.assertIn("не похоже на ссылку", self.bot.sent_texts()[-1])
        self.send(f"{BASE}/page.html")  # HTML вместо XML
        self.assertIn("Не удалось прочитать фид", self.bot.sent_texts()[-1])
        self.send(f"{BASE}/missing")  # 404 — ошибка источника, не зависание
        self.assertIn("Не удалось прочитать фид", self.bot.sent_texts()[-1])
        # состояние AsUrl сохранено: валидный адрес всё ещё принимается
        self.send(f"{BASE}/valid.xml")
        preview = self.bot.sent_texts()[-1]
        self.assertIn("Valid Feed", preview)
        self.assertIn("Первая новость", preview)
        self.press("a:confirm")
        rows = self.db.list_sources(self.conn(), self.CHAT)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["kind"], rows[0]["origin"], rows[0]["url"]),
                         ("rss", "manual", f"{BASE}/valid.xml"))
        self.assertIn("добавлено", self.bot.edited_texts()[-1])
        # повторное добавление того же URL — не дубликат
        self.press("add:start")
        self.press("a:k:rss")
        self.send(f"{BASE}/valid.xml")
        self.press("a:confirm")
        self.assertEqual(len(self.db.list_sources(self.conn(), self.CHAT)), 1)


class TC22ToggleSource(ChatCase):
    """Выключенный источник не участвует в сборе; включённый — участвует."""

    def test_toggle(self):
        id1, id2 = self._add_fixture_sources()
        Handler.HITS.clear()
        out = self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("Первая новость", out)
        self.assertIn("Другая новость", out)
        self.assertEqual(Handler.HITS.get("/valid.xml"), 1)
        self.assertEqual(Handler.HITS.get("/valid2.xml"), 1)

        self.press(f"src:t:{id1}")  # выключить первый
        self.assertIn("(выключен)", self.bot.edited_texts()[-1])
        Handler.HITS.clear()
        self.stdout_of(lambda: self.send("/digest"))
        self.assertIsNone(Handler.HITS.get("/valid.xml"))  # 0 запросов к маршруту
        self.assertEqual(Handler.HITS.get("/valid2.xml"), 1)

        self.press(f"src:t:{id1}")  # включить обратно
        self.assertNotIn("(выключен)", self.bot.edited_texts()[-1].split("•")[1])
        Handler.HITS.clear()
        self.stdout_of(lambda: self.send("/digest"))
        self.assertEqual(Handler.HITS.get("/valid.xml"), 1)


class TC23DeleteSource(ChatCase):
    """Удаление: источник исчезает, items каскадно удаляются, сводка без него."""

    def test_delete(self):
        sid, _ = self._add_fixture_sources()
        self.stdout_of(lambda: self.send("/digest"))  # у источника есть items
        self.assertGreater(
            self.conn().execute("SELECT COUNT(*) FROM items WHERE source_id=%s", (sid,)).fetchone()[0], 0
        )
        self.press(f"src:d:{sid}")
        self.assertIn("Удалить", self.bot.edited_texts()[-1])
        self.press(f"src:dy:{sid}")
        self.assertIn("Удалено", self.bot.edited_texts()[-1])
        self.assertIsNone(self.db.get_source(self.conn(), sid))
        self.assertEqual(
            self.conn().execute("SELECT COUNT(*) FROM items WHERE source_id=%s", (sid,)).fetchone()[0],
            0,
        )  # каскад ON DELETE CASCADE
        # сводка строится без него; второй источник ещё жив
        out = self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("Другая новость", out)


class NFR02Isolation(ChatCase):
    """Отказ источника не валит прогон: ошибка в лог со статусом, сводка идёт."""

    def test_dead_source_isolated(self):
        from bot.collectors import http as httpmod
        real_sleep = httpmod._sleep
        httpmod._sleep = lambda s: None  # ретраи без реальных пауз — тест быстрый
        try:
            dead = self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/always500", "Dead")
            self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/valid.xml", "Valid Feed")
            out = self.stdout_of(lambda: self.send("/digest"))
            self.assertIn("Первая новость", out)  # сводка построена и доставлена
            self.assertEqual(Handler.HITS.get("/always500"), 4)  # ретраи были
            # с И5 деградация — футером сводки (план §1.5, TC-20), не отдельным сообщением
            self.assertIn("Не удалось собрать 1 источник(ов)", out)
            self.assertIn(f"{BASE}/always500", out)
            row = self.db.get_source(self.conn(), dead)
            self.assertEqual(row["status"], "error")
            self.assertTrue(row["status_msg"])
        finally:
            httpmod._sleep = real_sleep


class TC32Commands(ChatCase):
    """Все команды отвечают меню/осмысленным сообщением; мусор не валит бота."""

    def test_commands(self):
        self.db.finalize_survey(
            self.conn(), self.CHAT,
            [{"url": f"{BASE}/valid.xml", "title": "Valid Feed", "topics": []}],
            ["09:00"], "replace",
        )
        self.send("/start")
        self.assertIn("С возвращением", self.bot.sent_texts()[-1])
        self.send("/sources")
        self.assertIn("Источники (1)", self.bot.sent_texts()[-1])
        self.send("/settings")
        self.assertIn("09:00", self.bot.sent_texts()[-1])
        out = self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("http://ex.test/1", out)  # пункт со ссылкой (mock)
        self.send("просто текст")  # без состояния — молча игнорируется, без ошибок
        self.assertEqual(self.bot.calls[-1][0], "SendMessage")  # бот жив, отвечал последним /digest-циклом


if __name__ == "__main__":
    unittest.main()
