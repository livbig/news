"""Итерация 5: TC-06 (экранирование спецсимволов), TC-29 (mock-сводка:
одно сообщение, русский, ссылки), TC-30 («печатает…»), TC-31 (LLM 500 →
2 попытки → mock, 900×2/пауза 30 c — правки сверки D25)."""
import asyncio
import io
import re
import sys
import threading
import time
import unittest
from contextlib import redirect_stdout
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fakes.py

SPECIAL_XML = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Special Feed</title>
<item><title>Q3 &lt;b&gt;drop&lt;/b&gt; &amp; layoffs</title><link>http://ex.test/s1</link></item>
<item><title>strange _italic_ [x](y) *bold*</title><link>http://ex.test/s2</link></item>
<item><title>back`tick` &amp; &lt;weird&gt;</title><link>http://ex.test/s3</link></item>
</channel></rss>""").encode()

VALID_XML = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Valid Feed</title>
<item><title>Первая новость</title><link>http://ex.test/1</link>
<pubDate>Thu, 10 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>Вторая новость</title><link>http://ex.test/2</link></item>
<item><title>Третья новость</title><link>http://ex.test/3</link></item>
</channel></rss>""").encode()

REDDIT_RSS = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>r/test</title>
<item><title>Пост сабреддита один</title><link>http://rd.test/1</link></item>
<item><title>Пост сабреддита два</title><link>http://rd.test/2</link></item>
</channel></rss>""").encode()

POSTS: list[str] = []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/slow.xml":  # замедленный сбор — для «печатает…» (TC-30)
            time.sleep(0.5)
            body = VALID_XML
        else:
            body = {"/special.xml": SPECIAL_XML, "/valid.xml": VALID_XML,
                    "/reddit.rss": REDDIT_RSS}.get(self.path, b"nope")
        status = 404 if body == b"nope" else 200
        self.send_response(status)
        self.send_header("Content-Type", "application/rss+xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # LLM-маршрут, всегда 500 (TC-31)
        POSTS.append(self.path)
        self.send_response(500)
        self.send_header("Content-Length", "4")
        self.end_headers()
        self.wfile.write(b"boom")

    def log_message(self, *args):
        pass


def setUpModule():
    global SERVER, BASE, _SAVED
    SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=SERVER.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{SERVER.server_address[1]}"
    from bot import config as bconfig
    from pipeline import config as pconfig
    # реальные ключи .env не должны утекать в тесты: mock-режим (NFR-05)
    _SAVED = (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID,
              pconfig.LLM_API_KEY, pconfig.LLM_BASE_URL)
    bconfig.TOKEN = ""
    bconfig.ALLOWED_CHAT_ID = ""
    pconfig.LLM_API_KEY = ""


def tearDownModule():
    SERVER.shutdown()
    SERVER.server_close()
    from bot import config as bconfig
    from pipeline import config as pconfig
    (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID,
     pconfig.LLM_API_KEY, pconfig.LLM_BASE_URL) = _SAVED


class StrictHTML(HTMLParser):
    """Строгий валидатор (TESTPLAN §1.1): битая разметка = ошибка;
    text — «отображаемый» текст с раскрытыми сущностями."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.errors: list[str] = []
        self.text: list[str] = []
        self.open_tags: list[str] = []

    def handle_starttag(self, tag, attrs):
        self.open_tags.append(tag)

    def handle_endtag(self, tag):
        if not self.open_tags or self.open_tags[-1] != tag:
            self.errors.append(f"незакрытый/лишний </{tag}>")
        else:
            self.open_tags.pop()

    def handle_data(self, data):
        self.text.append(data)


def validate(chunk: str) -> StrictHTML:
    parser = StrictHTML()
    parser.feed(chunk)
    parser.close()
    if parser.open_tags:
        parser.errors.append(f"незакрытые теги: {parser.open_tags}")
    return parser


# --- TC-06 (unit): спецсимволы в заголовках — экранирование, буквальный текст ----

class TC06SpecialChars(unittest.TestCase):

    def setUp(self):
        from bot import tgsend
        self.tgsend = tgsend
        self.sent: list[tuple] = []
        self._real_post = tgsend._post
        tgsend._post = lambda text, chat_id, parse_mode: (
            self.sent.append((text, parse_mode)), True)[1]
        tgsend.config.TOKEN = "test"  # доставка — через рекордер, сеть не трогаем

    def tearDown(self):
        self.tgsend._post = self._real_post
        self.tgsend.config.TOKEN = ""

    def test_special_chars_survive_delivery(self):
        from bot import collect, db, digest

        conn = db.connect(":memory:")
        sid = db.add_source(conn, 42, "rss", f"{BASE}/special.xml", "Special Feed")
        collect.collect_source(conn, sid, f"{BASE}/special.xml")
        # «худший» заголовок напрямую: feedparser вычищает известные HTML-теги
        # из title фида, а FR-16 требует буквальной доставки любого внешнего текста
        db.insert_item(conn, sid, "http://ex.test/s4", "Q3 <b>drop</b> & layoffs", None)
        titles = [r[0] for r in conn.execute(
            "SELECT title FROM items WHERE source_id=%s", (sid,))]
        self.assertIn("Q3 <b>drop</b> & layoffs", titles)
        text, _ids = digest.build_delta(conn, 42)
        self.assertIn("MOCK", text)
        self.tgsend.send_chat(text, 42)

        self.assertTrue(self.sent)  # доставка состоялась в HTML-режиме
        for chunk, parse_mode in self.sent:
            self.assertEqual(parse_mode, "HTML")  # plain-фолбэк не понадобился
            self.assertLessEqual(len(chunk), 4000)
            parser = validate(chunk)
            self.assertEqual(parser.errors, [], chunk)  # битой разметки нет
            display = "".join(parser.text)
            for title in titles:
                self.assertIn(title, display)  # символы выведены буквально
            self.assertNotIn("<b>", [t for t in parser.open_tags])

    def test_markdown_not_interpreted(self):
        """Markdown-символы не превращаются в разметку: в валидном HTML
        Telegram нет тегов кроме a/b/i — здесь их быть не должно вовсе."""
        from bot import collect, db, digest

        conn = db.connect(":memory:")
        sid = db.add_source(conn, 42, "rss", f"{BASE}/special.xml", "Special Feed")
        collect.collect_source(conn, sid, f"{BASE}/special.xml")
        text, _ = digest.build_delta(conn, 42)
        parser = validate(self.tgsend._sanitize_html(self.tgsend._unwrap_tags(text)))
        self.assertEqual(parser.open_tags, [])
        self.assertIn("_italic_", "".join(parser.text))
        self.assertIn("[x](y)", "".join(parser.text))


# --- интеграционная инфраструктура (fake-обновления + FakeBot, tests/fakes.py) ----

from aiogram.types import Update  # noqa: E402
from fakes import FakeBot, make_message, shared_dispatcher  # noqa: E402


class ChatCase(unittest.TestCase):
    CHAT = 5353
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
        key = StorageKey(bot_id=self.bot.id, chat_id=self.CHAT, user_id=self.USER)
        asyncio.run(self.dp.storage.set_state(key, None))
        asyncio.run(self.dp.storage.set_data(key, {}))
        onboarding.ACTIVE.clear()

    def feed(self, **event):
        self._update_id += 1
        asyncio.run(self.dp.feed_update(
            self.bot, Update(update_id=self._update_id, **event)))

    def send(self, text):
        self.feed(message=make_message(self.CHAT, self.USER, text))

    def conn(self):
        from bot.handlers import onboarding
        return onboarding.conn


# --- TC-29 (integration): сборка mock-сводки — одно сообщение, русский, ссылки ---

class TC29MockDigest(ChatCase):

    def setUp(self):
        super().setUp()
        from bot import tgsend
        self.tgsend = tgsend
        self.sent: list[tuple] = []
        self._real_post = tgsend._post
        tgsend._post = lambda text, chat_id, parse_mode: (
            self.sent.append((text, parse_mode)), True)[1]
        tgsend.config.TOKEN = "test"

    def tearDown(self):
        self.tgsend._post = self._real_post
        self.tgsend.config.TOKEN = ""

    def test_one_message_russian_links(self):
        self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/valid.xml", "Valid Feed")
        self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/reddit.rss", "r/test")
        self.send("/digest")

        self.assertEqual(len(self.sent), 1)  # ОДНО сообщение
        chunk, parse_mode = self.sent[0]
        self.assertEqual(parse_mode, "HTML")
        self.assertLessEqual(len(chunk), 4000)
        parser = validate(chunk)
        self.assertEqual(parser.errors, [])
        self.assertIn("MOCK", chunk)  # пометка mock
        self.assertTrue(re.search(r"[а-яА-Я]", chunk))  # язык русский
        for url in ("http://ex.test/1", "http://ex.test/2", "http://ex.test/3",
                    "http://rd.test/1", "http://rd.test/2"):
            self.assertIn(url, chunk)  # каждому пункту — ссылка из items
        # промпт содержит top-N ограничение (правка сверки к TC-29)
        from bot import llm
        self.assertIn("не более 25 пунктов", llm.SYSTEM_PROMPT)


# --- TC-30 (integration): «печатает…» при долгой /digest, не при быстрой /sources -

class TC30Typing(ChatCase):

    def setUp(self):
        super().setUp()
        from bot import tgsend
        self.tgsend = tgsend
        self._real_delay = tgsend.TYPING_DELAY
        tgsend.TYPING_DELAY = 0.15  # порог снижен для теста (TESTPLAN §1.5)

    def tearDown(self):
        self.tgsend.TYPING_DELAY = self._real_delay

    def test_typing_on_slow_digest_not_on_sources(self):
        self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/slow.xml", "Slow")
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.send("/digest")  # сбор ~0.5 c > порога 0.15 c
        self.assertIn("Первая новость", buf.getvalue())  # сводка доставлена
        actions = [v for t, v in self.bot.calls if t == "SendChatAction"]
        self.assertGreaterEqual(len(actions), 1)  # «печатает…» был
        self.assertEqual(actions[0]["action"], "typing")
        self.assertEqual(actions[0]["chat_id"], self.CHAT)

        self.bot.calls.clear()
        self.send("/sources")  # быстрая операция — без индикатора
        self.assertFalse(any(t == "SendChatAction" for t, _v in self.bot.calls))
        self.assertTrue(any(t == "SendMessage" for t, _v in self.bot.calls))  # бот жив


# --- TC-31 (integration): отказ LLM → ретраи → mock-fallback (D25) -----------------

class TC31LLMRetries(unittest.TestCase):

    def setUp(self):
        from bot import llm as botllm
        from pipeline import config as pconfig
        self.llm = botllm
        self.pconfig = pconfig
        self._saved = (pconfig.LLM_API_KEY, pconfig.LLM_BASE_URL)
        self._real_sleep = botllm._sleep
        self.pauses: list[float] = []
        botllm._sleep = self.pauses.append
        POSTS.clear()

    def tearDown(self):
        self.pconfig.LLM_API_KEY, self.pconfig.LLM_BASE_URL = self._saved
        self.llm._sleep = self._real_sleep

    def test_500_retried_then_mock(self):
        """Маршрут LLM всегда 500: 2 попытки, пауза 30 с, mock с пометкой."""
        self.pconfig.LLM_BASE_URL = BASE
        self.pconfig.LLM_API_KEY = "test-key"
        text = self.llm.summarize("Первая — http://ex.test/1")
        self.assertEqual(len(POSTS), 2)  # ровно 2 попытки
        self.assertEqual(POSTS, ["/v1/messages"] * 2)
        self.assertEqual(self.pauses, [30.0])  # пауза только между попытками
        self.assertIn("MOCK", text)  # mock-фолбэк доставлен
        self.assertIn("2 попыток", text)
        self.assertIn("http://ex.test/1", text)

    def test_timeout_params_and_attempts(self):
        """Боевые параметры (D25): read-timeout 900 c, 2 попытки, затем mock."""
        import httpx
        self.pconfig.LLM_API_KEY = "test-key"  # без ключа summarize не дойдёт до _call
        seen: list[tuple] = []

        def fake_call(system, messages, max_tokens, read_timeout=None):
            seen.append((max_tokens, read_timeout))
            raise httpx.ConnectTimeout("no route")

        real_call = self.llm._call
        self.llm._call = fake_call
        try:
            text = self.llm.summarize("Новость — http://ex.test/9")
        finally:
            self.llm._call = real_call
        self.assertEqual(len(seen), 2)  # 2 попытки
        self.assertEqual(seen[0][1], 900.0)  # read-timeout 900 c
        self.assertEqual(self.pauses, [30.0])
        self.assertIn("MOCK", text)
        self.assertIn("2 попыток", text)

    def test_no_key_is_mock(self):
        self.pconfig.LLM_API_KEY = ""
        text = self.llm.summarize("Новость — http://ex.test/1")
        self.assertIn("MOCK", text)
        self.assertEqual(POSTS, [])  # сети не было вовсе


if __name__ == "__main__":
    unittest.main()
