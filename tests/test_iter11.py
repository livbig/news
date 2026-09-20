"""Итерация 11a (D48) + 11b (D41-D43) + 11c (D44): добавление TG-каналов —
@имя, telegram.me|dog, t.me/s/имя, query/трейлинг, invite-ссылки отдельной
ошибкой, пересланный пост канала → источник tgweb; mega-промпт GLM-5.3,
per-source бюджет дельты; непрерывный фоновый сбор. tests/TESTPLAN.md."""
import asyncio
import re
import sys
import threading
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fakes.py


def tg_html(posts: list[tuple[int, str, str]]) -> bytes:
    """Разметка веб-превью t.me/s (R6): data-post/message_text/datetime."""
    blocks = "".join(
        f'<div class="tgme_widget_message_wrap" data-post="testch/{pid}">'
        f'<div class="tgme_widget_message_text js-message_text" dir="ltr">{text}</div>'
        f'<time datetime="{dt}"></time></div>'
        for pid, dt, text in posts
    )
    return f"<html><body>{blocks}</body></html>".encode()


TG_PAGE = tg_html([
    (3, "2026-09-14T10:00:00+00:00", "Пост три: золото обновило максимум"),
    (2, "2026-09-14T09:00:00+00:00", "Пост два: обзор рынка"),
])


def rss_xml(feed: int, count: int = 2) -> bytes:
    items = "".join(
        f"<item><title>F{feed} item {m}</title>"
        f"<link>http://ex.test/f{feed}/{m}</link></item>"
        for m in range(count)
    )
    return (f'<?xml version="1.0"?><rss version="2.0"><channel>'
            f"<title>Feed {feed}</title>{items}</channel></rss>").encode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        feed = re.match(r"^/feed(\d+)\.xml$", path)
        if path == "/tgweb/BFMnews":
            status, body = 200, TG_PAGE
        elif feed:
            status, body = 200, rss_xml(int(feed.group(1)))
        else:
            status, body = 404, b"nope"
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@contextmanager
def quiet():
    """Без реальных пауз ретраев/t.me (fake-таймеры, как в test_iter6)."""
    from bot import collect
    from bot.collectors import http as httpmod

    real = (httpmod._sleep, collect._pause)
    httpmod._sleep = lambda s: None
    collect._pause = lambda s: None
    try:
        yield
    finally:
        httpmod._sleep, collect._pause = real


def setUpModule():
    global SERVER, BASE, _SAVED
    SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=SERVER.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{SERVER.server_address[1]}"
    from bot import config as bconfig
    from pipeline import config as pconfig

    _SAVED = (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY,
              bconfig.TGWEB_URL_TEMPLATE)
    bconfig.TOKEN = ""
    bconfig.ALLOWED_CHAT_ID = ""
    pconfig.LLM_API_KEY = ""
    bconfig.TGWEB_URL_TEMPLATE = f"{BASE}/tgweb/{{name}}"


def tearDownModule():
    SERVER.shutdown()
    SERVER.server_close()
    from bot import config as bconfig
    from pipeline import config as pconfig

    (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY,
     bconfig.TGWEB_URL_TEMPLATE) = _SAVED


from aiogram.types import (Chat, Message, MessageOriginChannel,  # noqa: E402
                           MessageOriginUser, Update, User)
from fakes import FakeBot, make_callback, make_message, shared_dispatcher  # noqa: E402


# --- tg_name: все форматы ввода (D48) --------------------------------------------

class TgName(unittest.TestCase):

    def test_formats(self):
        from bot import collect

        for value in (
            "@BFMnews", "BFMnews", "t.me/BFMnews", "t.me/s/BFMnews",
            "https://t.me/BFMnews", "http://t.me/BFMnews/",
            "https://telegram.me/BFMnews", "https://telegram.dog/BFMnews",
            "https://t.me/BFMnews?before=10", "https://t.me/s/BFMnews/",
            "t.me/BFMnews/5",  # ссылка на пост канала — тоже канал
        ):
            with self.subTest(value=value):
                self.assertEqual(collect.tg_name(value), "BFMnews")

    def test_invalid(self):
        from bot import collect

        for value in ("t.me/ab", "has space", "абвгд", "", "https://site.com/x"):
            with self.subTest(value=value):
                self.assertIsNone(collect.tg_name(value))

    def test_invalid_logged_with_repr(self):
        from bot import collect

        with self.assertLogs("bot.collect", level="WARNING") as captured:
            collect.tg_name("х​anj языком")  # невидимые символы не теряются
        self.assertIn("'х", "\n".join(captured.output))

    def test_invite_raises_marker(self):
        from bot import collect

        for value in ("https://t.me/+AbCd_123", "t.me/joinchat/AbCd_123",
                      "https://telegram.me/+AbCd"):
            with self.subTest(value=value):
                with self.assertRaises(collect.TgInviteError):
                    collect.tg_name(value)

    def test_preview_invite_message(self):
        from bot import collect

        with self.assertRaises(ValueError) as cm:
            collect.make_preview("tgweb", "https://t.me/+AbCd_123")
        self.assertIn("приглашение", str(cm.exception))


# --- мастер: пересланный пост канала (D48) ----------------------------------------

def make_forward(chat_id, user_id, origin) -> Message:
    return Message(
        message_id=11,
        date=datetime.now(timezone.utc),
        chat=Chat(id=chat_id, type="private"),
        from_user=User(id=user_id, is_bot=False, first_name="T"),
        forward_origin=origin,
    )


class ChatCase(unittest.TestCase):
    CHAT = 1111
    USER = 11

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

    def press(self, data):
        self.feed(callback_query=make_callback(self.CHAT, self.USER, data))

    def conn(self):
        from bot.handlers import onboarding

        return onboarding.conn

    def start_add(self, kind="tgweb"):
        self.press("add:start")
        self.press(f"a:k:{kind}")

    def channel_origin(self, username="BFMnews"):
        return MessageOriginChannel(
            type="channel", date=datetime.now(timezone.utc),
            chat=Chat(id=-100123, type="channel", username=username, title="BFM"),
            message_id=5,
        )


class ForwardChannel(ChatCase):
    """Пересланный пост публичного канала → источник tgweb, kind форсирован."""

    def test_forward_to_preview_and_confirm(self):
        self.start_add(kind="rss")  # выбранный тип перекрывается форвардом
        self.assertIn("RSS/Atom-фид", self.bot.edited_texts()[-1])
        self.feed(message=make_forward(self.CHAT, self.USER, self.channel_origin()))
        preview = self.bot.sent_texts()[-1]
        self.assertIn("t.me/BFMnews", preview)
        self.assertIn("Пост три", preview)

        self.press("a:confirm")
        rows = self.db.list_sources(self.conn(), self.CHAT)
        self.assertEqual((rows[0]["kind"], rows[0]["url"], rows[0]["origin"]),
                         ("tgweb", "BFMnews", "manual"))

    def test_forward_without_username_rejected(self):
        self.start_add()
        self.feed(message=make_forward(
            self.CHAT, self.USER, self.channel_origin(username=None)))
        self.assertIn("не из публичного канала", self.bot.sent_texts()[-1])
        self.assertEqual(self.db.list_sources(self.conn(), self.CHAT), [])

    def test_forward_from_user_rejected(self):
        self.start_add()
        self.feed(message=make_forward(
            self.CHAT, self.USER,
            MessageOriginUser(type="user", date=datetime.now(timezone.utc),
                              sender_user=User(id=42, is_bot=False, first_name="P"))))
        self.assertIn("не из публичного канала", self.bot.sent_texts()[-1])

    def test_text_still_works_after_forward_handler(self):
        self.start_add()
        self.send_ok = False
        self.feed(message=make_message(self.CHAT, self.USER, "BFMnews"))
        self.assertIn("t.me/BFMnews", self.bot.sent_texts()[-1])

    def test_typed_invite_shows_invite_error(self):
        self.start_add()
        self.feed(message=make_message(self.CHAT, self.USER, "https://t.me/+AbCd_123"))
        self.assertIn("приглашение", self.bot.sent_texts()[-1])


# --- iter-11b (D41-D43): mega-промпт, профиль, MAX_TOKENS, per-source бюджет -----

class DigestPrompt(unittest.TestCase):
    """summarize: профиль в {INTERESTS_PROFILE}, дефолт без профиля,
    контракт промпта дословно, mock/нормализация живы."""

    def captured_call(self, interests=None):
        from pipeline import config as pconfig

        from bot import llm

        calls = {}

        def fake_call(system, messages, max_tokens, read_timeout=None):
            calls["system"] = system
            calls["messages"] = messages
            calls["max_tokens"] = max_tokens
            return "Лид.<br><b>Раздел</b>"

        real_call, real_key = llm._call, pconfig.LLM_API_KEY
        llm._call = fake_call
        pconfig.LLM_API_KEY = "test-key"
        try:
            out = llm.summarize("заголовок — http://ex.test/1", interests)
        finally:
            llm._call, pconfig.LLM_API_KEY = real_call, real_key
        return out, calls

    def test_interests_injected(self):
        _out, calls = self.captured_call("Золото, платина и WSB")
        self.assertIn("<интересы_читателя>\nЗолото, платина и WSB\n</интересы_читателя>",
                      calls["system"])
        self.assertNotIn("{INTERESTS_PROFILE}", calls["system"])

    def test_default_profile_when_none(self):
        from bot import llm

        for value in (None, "", "   "):
            with self.subTest(value=value):
                _out, calls = self.captured_call(value)
                self.assertIn(llm.DEFAULT_INTERESTS, calls["system"])

    def test_contract_markers(self):
        from bot import llm

        _out, calls = self.captured_call("x")
        for marker in ("личный аналитик одного читателя", "12000-16000",
                       "ЭМОДЗИ", "👀 НА РАДАРЕ", "🧠 СИНТЕЗ", '<a href="URL">'):
            self.assertIn(marker, calls["system"])
        self.assertEqual(calls["max_tokens"], llm.MAX_TOKENS)
        self.assertEqual(calls["messages"],
                         [{"role": "user", "content": "заголовок — http://ex.test/1"}])

    def test_output_normalized(self):
        out, _calls = self.captured_call(None)
        self.assertEqual(out, "Лид.\n<b>Раздел</b>")


class MaxTokensEnv(unittest.TestCase):
    """MAX_TOKENS = 32000 (thinking-блоки GLM-5.3), env LLM_MAX_TOKENS переопределяет."""

    def test_default_and_env(self):
        import importlib
        import os

        from bot import llm

        self.assertEqual(llm.MAX_TOKENS, 32000)
        saved = os.environ.get("LLM_MAX_TOKENS")
        os.environ["LLM_MAX_TOKENS"] = "1234"
        try:
            importlib.reload(llm)
            self.assertEqual(llm.MAX_TOKENS, 1234)
        finally:
            if saved is None:
                os.environ.pop("LLM_MAX_TOKENS", None)
            else:
                os.environ["LLM_MAX_TOKENS"] = saved
            importlib.reload(llm)
        self.assertEqual(llm.MAX_TOKENS, 32000)


class PendingItemsBudget(unittest.TestCase):
    """11b: per-source бюджет (BOT_DIGEST_PER_SOURCE) + общий кап вместо LIMIT 50."""

    CHAT = 77

    def setUp(self):
        from bot import db

        self.db = db
        self.conn = db.connect(":memory:")
        db.ensure_user(self.conn, self.CHAT)

    def seed_source(self, title, count, day):
        sid = self.db.add_source(self.conn, self.CHAT, "rss", f"http://x.test/{title}.xml", title)
        for m in range(count):
            self.db.insert_item(
                self.conn, sid, f"http://x.test/{title}/{m}", f"{title} {m}",
                f"2026-09-{day:02d}T00:00:{m:02d}Z")
        return sid

    def test_per_source_budget(self):
        sid_a = self.seed_source("A", 30, 10)
        sid_b = self.seed_source("B", 5, 9)
        rows = self.db.pending_items(self.conn, self.CHAT)
        self.assertEqual(len(rows), 20)  # 15 из A + все 5 из B
        urls = [r["url"] for r in rows]
        self.assertIn("http://x.test/A/29", urls)   # свежайшие на месте
        self.assertNotIn("http://x.test/A/14", urls)  # старьё за бюджетом
        self.assertIn("http://x.test/B/4", urls)
        # свежайшие 15 A — это m15..m29 (published сортирует, D26)
        a_urls = [u for u in urls if u.startswith("http://x.test/A/")]
        self.assertEqual(len(a_urls), 15)

    def test_global_cap(self):
        self.seed_source("A", 30, 10)
        self.seed_source("B", 30, 9)
        rows = self.db.pending_items(self.conn, self.CHAT, per_source=10, limit=12)
        self.assertEqual(len(rows), 12)  # кап режет объединённый топ

    def test_consumption_window_still_works(self):
        sid = self.seed_source("A", 3, 10)
        rows = self.db.pending_items(self.conn, self.CHAT)
        self.assertEqual(len(rows), 3)
        from bot import db

        db.record_digest(self.conn, self.CHAT, "text", [r["id"] for r in rows])
        self.assertEqual(self.db.pending_items(self.conn, self.CHAT), [])
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM sources WHERE id=%s", (sid,)).fetchone()[0], 1)


class BuildDeltaWrapsNews(unittest.TestCase):
    """11b: build_delta оборачивает вход в <новости> и передаёт профиль."""

    CHAT = 78

    def test_wrapper_and_default_interests(self):
        from pipeline import config as pconfig

        from bot import db, digest, llm

        conn = db.connect(":memory:")
        db.ensure_user(conn, self.CHAT)
        sid = db.add_source(conn, self.CHAT, "rss", "http://x.test/f.xml", "Feed")
        db.insert_item(conn, sid, "http://ex.test/1", "Первое & <важное>", "2026-09-10T00:00:00Z")

        calls = {}

        def fake_call(system, messages, max_tokens, read_timeout=None):
            calls["system"] = system
            calls["messages"] = messages
            return "Лид."

        real_call, real_key = llm._call, pconfig.LLM_API_KEY
        llm._call = fake_call
        pconfig.LLM_API_KEY = "test-key"
        try:
            text, ids = digest.build_delta(conn, self.CHAT)
        finally:
            llm._call, pconfig.LLM_API_KEY = real_call, real_key

        content = calls["messages"][0]["content"]
        self.assertTrue(content.startswith("<новости>\n"))
        self.assertTrue(content.endswith("\n</новости>"))
        self.assertIn("Первое &amp; &lt;важное&gt; — http://ex.test/1", content)  # FR-16
        self.assertIn(llm.DEFAULT_INTERESTS, calls["system"])  # профиля в БД ещё нет
        self.assertEqual(len(ids), 1)


class ItemTextLevel1(unittest.TestCase):
    """iter-14 (уровень 1): items.text — хранение полного текста пункта,
    выдержка «ТЕКСТ: …» во входе дайджеста (кап + экранирование), миграция."""

    CHAT = 79

    def test_migration_column_and_pending(self):
        from bot import db

        conn = db.connect(":memory:")
        db._migrate(conn)  # идемпотентность: второй прогон не падает
        db.ensure_user(conn, self.CHAT)
        sid = db.add_source(conn, self.CHAT, "tgweb", "channel", "Канал")
        self.assertTrue(db.insert_item(conn, sid, "https://t.me/c/1", "Заголовок",
                                       "2026-09-19T10:00:00Z", "Полный текст поста"))
        rows = db.pending_items(conn, self.CHAT)
        self.assertEqual(rows[0]["text"], "Полный текст поста")

    def test_digest_input_includes_text_excerpt(self):
        from pipeline import config as pconfig

        from bot import config, db, digest, llm

        conn = db.connect(":memory:")
        db.ensure_user(conn, self.CHAT)
        sid = db.add_source(conn, self.CHAT, "rss", "http://x.test/f.xml", "Feed")
        body = "Золото <b>растёт</b>. " + "х" * (config.DIGEST_TEXT_CAP + 500)
        db.insert_item(conn, sid, "http://ex.test/1", "Новость",
                       "2026-09-10T00:00:00Z", body)
        db.insert_item(conn, sid, "http://ex.test/2", "Без текста",
                       "2026-09-10T01:00:00Z")

        captured = {}

        def fake_call(system, messages, max_tokens, read_timeout=None):
            captured["user"] = messages[0]["content"]
            return "Лид."

        real_call, real_key = llm._call, pconfig.LLM_API_KEY
        llm._call = fake_call
        pconfig.LLM_API_KEY = "test-key"
        try:
            digest.build_delta(conn, self.CHAT)
        finally:
            llm._call, pconfig.LLM_API_KEY = real_call, real_key

        content = captured["user"]
        self.assertIn("ТЕКСТ: Золото &lt;b&gt;растёт&lt;/b&gt;.", content)  # FR-16
        self.assertIn("…", content)  # выдержка усечена
        self.assertNotIn("х" * (config.DIGEST_TEXT_CAP + 1), content)  # кап работает
        self.assertIn("Без текста — http://ex.test/2\n\n", content)
        self.assertNotIn("ТЕКСТ: Без текста", content)  # пункт без текста — как раньше

    def test_entry_text_from_feed(self):
        import feedparser

        from bot import collect

        xml = (
            '<?xml version="1.0"?><rss version="2.0" '
            'xmlns:content="http://purl.org/rss/1.0/modules/content/">'
            "<channel><title>T</title>"
            "<item><title>Короткий заголовок</title><link>http://ex.test/1</link>"
            "<description>Короткий заголовок</description></item>"
            "<item><title>Вторая новость</title><link>http://ex.test/2</link>"
            "<content:encoded><![CDATA[<p>Полный текст статьи, заметно длиннее "
            "заголовка — " + "смысл " * 40 + "</p>]]></content:encoded></item>"
            "</channel></rss>"
        )
        entries = feedparser.parse(xml).entries
        self.assertIsNone(collect._entry_text(entries[0]))  # summary = заголовок
        text = collect._entry_text(entries[1])
        self.assertIsNotNone(text)
        self.assertIn("смысл", text)
        self.assertNotIn("<p>", text)  # теги срезаны


class EnrichLevel2(unittest.TestCase):
    """iter-14b: фоновая докачка текстов — таргеты, успех/неудача, без повторов."""

    CHAT = 80

    def _setup(self):
        from bot import db

        conn = db.connect(":memory:")
        db.ensure_user(conn, self.CHAT)
        rss = db.add_source(conn, self.CHAT, "rss", "http://x.test/f.xml", "Feed")
        tg = db.add_source(conn, self.CHAT, "tgweb", "chan", "Канал")
        db.insert_item(conn, rss, "http://ex.test/a1", "Статья без текста",
                       "2026-09-19T10:00:00Z")
        db.insert_item(conn, tg, "https://t.me/chan/2",
                       "Читай https://ex.test/a2 подробно", "2026-09-19T11:00:00Z")
        db.insert_item(conn, rss, "http://ex.test/a3", "С текстом",
                       "2026-09-19T12:00:00Z", "Уже есть текст")
        return conn

    def test_extract_url_skips_messengers(self):
        from bot import enrich

        self.assertEqual(enrich.extract_url("Читай https://example.com/a?t=1 и t.me/foo"),
                         "https://example.com/a?t=1")
        self.assertIsNone(enrich.extract_url("только t.me/foo и https://t.me/x"))
        self.assertIsNone(enrich.extract_url(""))

    def test_enrich_once_success_and_no_retry(self):
        from unittest import mock

        from bot import db, enrich

        conn = self._setup()
        fetched = []

        def fake_fetch(url):
            fetched.append(url)
            return "Полный текст статьи. " * 30

        with mock.patch.object(enrich, "fetch_article", side_effect=fake_fetch):
            done, tried = enrich.enrich_once(conn)
        self.assertEqual((done, tried), (2, 2))
        # tgweb — цель из первой внешней ссылки заголовка, rss — сама ссылка записи
        self.assertEqual(sorted(u.rsplit("/", 1)[-1] for u in fetched), ["a1", "a2"])
        rows = {r["url"]: r for r in db.pending_items(conn, self.CHAT)}
        self.assertTrue(rows["http://ex.test/a1"]["text"].startswith("Полный текст"))
        self.assertTrue(rows["https://t.me/chan/2"]["text"].startswith("Полный текст"))
        self.assertEqual(rows["http://ex.test/a3"]["text"], "Уже есть текст")
        with mock.patch.object(enrich, "fetch_article", side_effect=fake_fetch):
            done2, tried2 = enrich.enrich_once(conn)
        self.assertEqual((done2, tried2), (0, 0))  # повторных попыток нет
        self.assertEqual(len(fetched), 2)

    def test_enrich_failure_no_retry(self):
        from unittest import mock

        from bot import enrich

        conn = self._setup()
        with mock.patch.object(enrich, "fetch_article", return_value=None):
            done, tried = enrich.enrich_once(conn)
        self.assertEqual((done, tried), (0, 2))
        with mock.patch.object(enrich, "fetch_article", return_value="Текст " * 100):
            done2, tried2 = enrich.enrich_once(conn)
        self.assertEqual((done2, tried2), (0, 0))  # провал не ретраится


class MapLevel3(unittest.TestCase):
    """iter-14c: map-стадия — LLM-выжимки; дайджест предпочитает ВЫЖИМКУ."""

    CHAT = 81

    def test_map_once_and_digest_prefers_gist(self):
        from unittest import mock

        from bot import db, digest, enrich

        conn = db.connect(":memory:")
        db.ensure_user(conn, self.CHAT)
        sid = db.add_source(conn, self.CHAT, "rss", "http://x.test/f.xml", "Feed")
        db.insert_item(conn, sid, "http://ex.test/g1", "Новость с текстом",
                       "2026-09-19T10:00:00Z", "Длинный полный текст статьи. " * 10)
        with mock.patch("bot.llm.make_gist",
                        return_value="ЦБ signal: ставка вниз"):
            done, tried = enrich.map_once(conn)
        self.assertEqual((done, tried), (1, 1))
        rows = db.pending_items(conn, self.CHAT)
        self.assertEqual(rows[0]["gist"], "ЦБ signal: ставка вниз")

        captured = {}

        def fake_call(system, messages, max_tokens, read_timeout=None):
            captured["user"] = messages[0]["content"]
            return "Лид."

        real_call, real_key = digest.llm._call, digest.llm.pconfig.LLM_API_KEY
        digest.llm._call = fake_call
        digest.llm.pconfig.LLM_API_KEY = "test-key"
        try:
            digest.build_delta(conn, self.CHAT)
        finally:
            digest.llm._call, digest.llm.pconfig.LLM_API_KEY = real_call, real_key
        content = captured["user"]
        self.assertIn("ВЫЖИМКА: ЦБ signal: ставка вниз", content)
        self.assertNotIn("ТЕКСТ:", content)  # выжимка заменяет сырой текст

    def test_map_empty_gist_falls_back_to_text(self):
        from unittest import mock

        from bot import db, digest, enrich

        conn = db.connect(":memory:")
        db.ensure_user(conn, self.CHAT)
        sid = db.add_source(conn, self.CHAT, "rss", "http://x.test/f.xml", "Feed")
        db.insert_item(conn, sid, "http://ex.test/g2", "Новость",
                       "2026-09-19T10:00:00Z", "Полный осмысленный текст новости. " * 5)
        with mock.patch("bot.llm.make_gist", return_value=""):
            done, tried = enrich.map_once(conn)
        self.assertEqual((done, tried), (0, 1))  # пустышка: '' записан, не NULL
        from bot import db as _db
        self.assertEqual(_db.map_targets(conn, 25), [])  # повторно не выбирается
        captured = {}

        def fake_call(system, messages, max_tokens, read_timeout=None):
            captured["user"] = messages[0]["content"]
            return "Лид."

        real_call, real_key = digest.llm._call, digest.llm.pconfig.LLM_API_KEY
        digest.llm._call = fake_call
        digest.llm.pconfig.LLM_API_KEY = "test-key"
        try:
            digest.build_delta(conn, self.CHAT)
        finally:
            digest.llm._call, digest.llm.pconfig.LLM_API_KEY = real_call, real_key
        self.assertIn("ТЕКСТ: Полный осмысленный текст", captured["user"])

    def test_map_no_llm_key(self):
        from pipeline import config as pconfig

        from bot import llm

        saved = pconfig.LLM_API_KEY
        pconfig.LLM_API_KEY = ""
        try:
            self.assertEqual(llm.make_gist("любой текст"), "")
        finally:
            pconfig.LLM_API_KEY = saved


# --- iter-11c (D44): параллельный сбор, фоновый цикл, prep без сбора -------------

class CollectParallel(unittest.TestCase):
    CHAT = 88

    def setUp(self):
        from bot import db

        self.db = db
        self.conn = db.connect(":memory:")
        now = db.now_iso()
        self.conn.execute(
            "INSERT INTO users (chat_id, tz_offset_min, send_times, created_at,"
            " onboarded_at) VALUES (%s, 180, '[\"09:00\"]', %s, %s)",
            (self.CHAT, now, now))
        self.conn.commit()

    def add_feed(self, n, chat=None):
        return self.db.add_source(
            self.conn, chat or self.CHAT, "rss", f"{BASE}/feed{n}.xml", f"Feed {n}")

    def test_parallel_matches_expected_items(self):
        from bot import collect

        for n in range(4):
            self.add_feed(n)
        with quiet():
            total, errors = collect.collect_enabled(self.conn, self.CHAT)
        self.assertEqual((total, errors), (8, []))
        urls = {r["url"] for r in self.conn.execute("SELECT url FROM items").fetchall()}
        self.assertEqual(
            urls, {f"http://ex.test/f{n}/{m}" for n in range(4) for m in range(2)})
        statuses = self.conn.execute("SELECT status FROM sources").fetchall()
        self.assertTrue(all(s["status"] == "ok" for s in statuses))

    def test_dead_feed_isolated_in_pool(self):
        from bot import collect

        self.add_feed(0)
        dead = self.add_feed(9)
        self.conn.execute("UPDATE sources SET url=%s WHERE id=%s",
                          ("http://127.0.0.1:1/dead.xml", dead))
        self.conn.commit()
        self.add_feed(1)
        with quiet():
            total, errors = collect.collect_enabled(self.conn, self.CHAT)
        self.assertEqual(total, 4)  # два живых фида собраны
        self.assertEqual([url for url, _exc in errors], ["http://127.0.0.1:1/dead.xml"])
        self.assertEqual(self.db.get_source(self.conn, dead)["status"], "error")
        statuses = {r["id"]: r["status"]
                    for r in self.conn.execute("SELECT id, status FROM sources").fetchall()}
        self.assertEqual(statuses[dead], "error")

    def test_tgweb_not_in_pool(self):
        """tgweb-источники не идут через пул: только последовательная ветка."""
        from unittest import mock

        from bot import collect

        self.add_feed(0)
        self.db.add_source(self.conn, self.CHAT, "tgweb", "BFMnews", "t.me/BFMnews")
        with quiet(), mock.patch.object(
                collect, "TGWEB_PAUSE", 0, create=True) as _p, \
                mock.patch.object(collect, "collect_one", wraps=collect.collect_one) as spy:
            collect.collect_enabled(self.conn, self.CHAT)
        kinds = [c.args[1]["kind"] for c in spy.call_args_list]
        self.assertEqual(kinds.count("rss"), 1)
        self.assertEqual(kinds.count("tgweb"), 1)


class CollectOnce(unittest.TestCase):
    """Фоновый цикл (D44): один проход — все onboarded-чаты, только они."""

    def test_collects_onboarded_chats_only(self):
        from bot import collect, db
        from bot.scheduler import collect_once

        conn = db.connect(":memory:")
        for chat, onboarded in ((91, True), (92, False)):
            db.ensure_user(conn, chat)
            db.add_source(conn, chat, "rss", f"{BASE}/feed{chat % 10}.xml", f"Feed {chat}")
            if onboarded:
                conn.execute("UPDATE users SET onboarded_at=%s WHERE chat_id=%s",
                             (db.now_iso(), chat))
        conn.commit()
        with quiet():
            total = asyncio.run(collect_once(conn))
        self.assertEqual(total, 2)  # только onboarded-чат 91
        rows = conn.execute("SELECT s.chat_id, COUNT(*) AS n FROM items i"
                            " JOIN sources s ON s.id=i.source_id GROUP BY s.chat_id"
                            ).fetchall()
        self.assertEqual([r["chat_id"] for r in rows], [91])


class PrepareSkipsCollect(unittest.TestCase):
    """11c: prep-фаза — только LLM; collect из _prepare убран (D44)."""

    def test_prepare_does_not_collect(self):
        from bot import collect, db, scheduler

        conn = db.connect(":memory:")
        db.ensure_user(conn, 93)
        sid = db.add_source(conn, 93, "rss", f"{BASE}/feed3.xml", "Feed 3")
        db.insert_item(conn, sid, "http://ex.test/1", "Новость раз", "2026-09-10T00:00:00Z")

        def boom(_conn, _chat_id):
            raise AssertionError("collect_enabled вызван из _prepare")

        real = collect.collect_enabled
        collect.collect_enabled = boom
        try:
            prep = asyncio.run(scheduler._prepare(
                conn, 93, datetime.now(timezone.utc), datetime.now(timezone.utc)))
        finally:
            collect.collect_enabled = real
        self.assertIsNotNone(prep)
        self.assertIn("MOCK", prep["text"])  # без ключа LLM — mock-сводка (NFR-05)
        self.assertEqual(len(prep["ids"]), 1)


class PipelineMaxArticles(unittest.TestCase):

    def test_limit_raised_to_60(self):
        from pipeline import config

        self.assertEqual(config.MAX_ARTICLES_PER_FEED, 60)


# --- iter-11d (D45/D46): интервью, подбор источников, лимиты, пагинация -----------

class SuggestSourcesUnit(unittest.TestCase):
    """suggest_sources: JSON-извлечение, фильтр полей/kind, кап 60, без ключа — []."""

    def test_extract_json_array(self):
        from bot import llm

        self.assertEqual(llm._extract_json_array('пояснение [{"a": 1}] конец'), [{"a": 1}])
        self.assertEqual(llm._extract_json_array("нет массива"), [])
        self.assertEqual(llm._extract_json_array("[сломанный"), [])
        self.assertEqual(llm._extract_json_array('{"тоже": "не массив"}'), [])

    def test_filters_and_cap(self):
        import json
        from unittest import mock

        from pipeline import config as pconfig

        from bot import llm

        raw = [{"title": f"T{i}", "kind": "rss", "url": f"https://x/{i}.xml"}
               for i in range(70)]
        raw += [{"title": "tg", "kind": "tgweb", "url": "durov"},   # за капом
                {"title": "bad kind", "kind": "vk", "url": "x"},     # чужой kind
                {"title": "", "kind": "rss", "url": "x"},            # пустой title
                {"title": "no url", "kind": "rss"},                  # нет url
                "мусор"]                                             # не dict
        captured = {}

        def fake_call(system, messages, max_tokens, read_timeout=None):
            captured["user"] = messages[0]["content"]
            return "Вот источники: " + json.dumps(raw)

        real_call, real_key = llm._call, pconfig.LLM_API_KEY
        llm._call, pconfig.LLM_API_KEY = fake_call, "test-key"
        try:
            out = llm.suggest_sources("Золото и WSB")
        finally:
            llm._call, pconfig.LLM_API_KEY = real_call, real_key
        self.assertEqual(len(out), llm.SUGGEST_MAX_CANDIDATES)  # кап 60
        self.assertTrue(all(e["kind"] == "rss" for e in out))
        self.assertIn("Золото и WSB", captured["user"])  # профиль подставлен

    def test_no_key_empty(self):
        from pipeline import config as pconfig

        from bot import llm

        real_key = pconfig.LLM_API_KEY
        pconfig.LLM_API_KEY = ""
        try:
            self.assertEqual(llm.suggest_sources("профиль"), [])
        finally:
            pconfig.LLM_API_KEY = real_key


class ValidateCandidates(unittest.TestCase):
    """Валидация кандидатов LLM: мёртвые rss/tgweb отсечены, выжившие канонизированы."""

    def test_validation_filters_dead(self):
        from bot import collect

        candidates = [
            {"title": "Feed 5", "kind": "rss", "url": f"{BASE}/feed5.xml"},
            {"title": "Мёртвый", "kind": "rss", "url": f"{BASE}/nofeed.xml"},
            {"title": "BFM", "kind": "tgweb", "url": "BFMnews"},
            {"title": "Закрыт", "kind": "tgweb", "url": "closedch"},
        ]
        with self.assertLogs("bot.collect", level="WARNING"):
            valid = collect.validate_candidates(candidates)
        self.assertEqual([(v["kind"], v["url"]) for v in valid],
                         [("rss", f"{BASE}/feed5.xml"), ("tgweb", "BFMnews")])
        self.assertEqual(valid[0]["title"], "Feed 5")  # канонизация по ответу
        self.assertEqual(valid[1]["title"], "t.me/BFMnews")


class FinalizeKindLimit(unittest.TestCase):
    """finalize_survey с kind каждого entry; BOT_MAX_SOURCES; interests_text."""

    CHAT = 131

    def setUp(self):
        from bot import db

        self.db = db
        self.conn = db.connect(":memory:")
        db.ensure_user(self.conn, self.CHAT)

    def test_finalize_with_tgweb_kind(self):
        from bot import db

        db.finalize_survey(self.conn, self.CHAT, [
            {"title": "t.me/durovcats", "kind": "tgweb", "url": "durovcats"},
            {"title": "Legacy", "url": "https://x.test/legacy.xml"},  # kind по умолчанию rss
        ], ["09:00"], "replace")
        rows = {r["title"]: r["kind"] for r in self.db.list_sources(self.conn, self.CHAT)}
        self.assertEqual(rows, {"t.me/durovcats": "tgweb", "Legacy": "rss"})

    def test_max_sources_limit(self):
        from unittest import mock

        from bot import config

        with mock.patch.object(config, "MAX_SOURCES", 2):
            self.assertIsNotNone(self.db.add_source(self.conn, self.CHAT, "rss", "https://a/1", "A1"))
            self.assertIsNotNone(self.db.add_source(self.conn, self.CHAT, "rss", "https://a/2", "A2"))
            self.assertEqual(
                self.db.add_source(self.conn, self.CHAT, "rss", "https://a/3", "A3"), "limit")
            with self.assertRaises(ValueError):
                self.db.finalize_survey(
                    self.conn, self.CHAT,
                    [{"title": "x", "kind": "rss", "url": "https://x/9"}], ["09:00"], "add")

    def test_interests_roundtrip(self):
        from bot import db

        self.assertIsNone(db.get_interests(self.conn, self.CHAT))
        db.set_interests(self.conn, self.CHAT, "Золото и USD/RUB")
        self.assertEqual(db.get_interests(self.conn, self.CHAT), "Золото и USD/RUB")
        self.assertIsNone(db.get_interests(self.conn, 999))  # строки чата нет


class KeyboardsPagination(unittest.TestCase):
    """Пагинация (D46): sources_kb >30 — страницы; sources_manage_kb — тоже."""

    def pool(self, n):
        return [{"title": f"S{i:02d}", "kind": "rss", "url": f"https://x/{i}"}
                for i in range(n)]

    def test_sources_kb_pages(self):
        from bot import keyboards

        pool = self.pool(75)
        kb0 = keyboards.sources_kb(pool, set(), 0)
        texts0 = [b.text for row in kb0.inline_keyboard for b in row]
        self.assertEqual(len(kb0.inline_keyboard), 32)  # 30 источников + нав-строка + Далее
        self.assertIn("Ещё › (45)", texts0)
        cb0 = [b.callback_data for row in kb0.inline_keyboard for b in row]
        self.assertIn("s:0", cb0)
        self.assertIn("s:29", cb0)
        kb2 = keyboards.sources_kb(pool, set(), 2)
        texts2 = [b.text for row in kb2.inline_keyboard for b in row]
        cb2 = [b.callback_data for row in kb2.inline_keyboard for b in row]
        self.assertEqual(len(kb2.inline_keyboard), 17)  # 15 источников + Далее
        self.assertTrue(any("‹ Назад" in t for t in texts2))
        self.assertFalse(any(t.startswith("Ещё") for t in texts2))
        self.assertIn("s:74", cb2)  # глобальные индексы пула

    def test_manage_kb_pages(self):
        from bot import keyboards

        rows = [(i, f"T{i}", "rss", "u", "manual", 1, "ok", None) for i in range(65)]
        kb = keyboards.sources_manage_kb(rows, 1)
        self.assertEqual(len(kb.inline_keyboard), 30 + 1 + 3)  # 30 строк + нав + 3 статичных
        texts = [b.text for row in kb.inline_keyboard for b in row]
        self.assertTrue(any(t.startswith("Ещё › (5)") for t in texts))


class InterviewFlow(ChatCase):
    """Полный онбординг-интервью с fake-LLM: вопросы → профиль → подбор → save."""

    CHAT = 1212
    USER = 12

    def patched_llm(self, profile):
        from unittest import mock

        from bot import interview, llm

        questions = ["Вопрос 1: что интересно?", "Вопрос 2: глубина?", "Вопрос 3: языки?"]
        candidates = [{"title": f"Feed {n}", "kind": "rss", "url": f"{BASE}/feed{n}.xml"}
                      for n in range(20)]  # ≥ MIN_VALID_SOURCES, иначе fallback
        candidates += [
            {"title": "BFM", "kind": "tgweb", "url": "BFMnews"},
            {"title": "Мёртвый", "kind": "rss", "url": f"{BASE}/nofeed.xml"},
            {"title": "Закрыт", "kind": "tgweb", "url": "closedch"},
        ]
        suggest = mock.patch.object(llm, "suggest_sources", return_value=candidates)
        p_next = mock.patch.object(interview, "next_question",
                                   side_effect=questions + [None])
        p_prof = mock.patch.object(interview, "build_profile", return_value=profile)
        return suggest, p_next, p_prof

    def test_full_flow_saves_profile_and_sources(self):
        profile = "Профиль: золото, рынок США; анти-интересы: крипта"
        suggest, p_next, p_prof = self.patched_llm(profile)
        with suggest, p_next, p_prof:
            self.send("/start")
            self.assertIn("Вопрос 1", self.bot.sent_texts()[-1])
            self.send("Золото и WSB")
            self.assertIn("Вопрос 2", self.bot.sent_texts()[-1])
            self.press("i:skip")  # «Пропустить вопрос» → следующий вопрос
            self.assertIn("Вопрос 3", self.bot.sent_texts()[-1])
            self.press("i:done")  # «Достаточно» → черновик профиля
            self.assertIn("Профиль: золото", self.bot.sent_texts()[-1])
            self.press("i:ok")  # профиль принят → подбор + валидация
            self.assertIn("2/5", self.bot.edited_texts()[-1])  # выжившие кандидаты
            self.press("s:next")
            self.press("f:1")
            self.press("m:09:00")
            self.press("m:next")
            self.assertIn("Профиль интересов", self.bot.edited_texts()[-1])
            self.press("c:save")

        rows = self.db.list_sources(self.conn(), self.CHAT)
        self.assertEqual({(r["kind"], r["url"]) for r in rows},
                         {("rss", f"{BASE}/feed{n}.xml") for n in range(20)}
                         | {("tgweb", "BFMnews")})
        self.assertEqual(len(rows), 21)
        row = self.conn().execute(
            "SELECT interests_text, send_times, onboarded_at FROM users WHERE chat_id=%s",
            (self.CHAT,)).fetchone()
        self.assertEqual(row["interests_text"], profile)  # D45: профиль в БД
        self.assertEqual(row["send_times"], '["09:00"]')
        self.assertIsNotNone(row["onboarded_at"])

    def test_fallback_pool_when_few_valid(self):
        from unittest import mock

        from bot import interview, llm

        with mock.patch.object(interview, "next_question", side_effect=["Вопрос 1", None]), \
                mock.patch.object(interview, "build_profile", return_value="П: золото"), \
                mock.patch.object(llm, "suggest_sources", return_value=[
                    {"title": "Мёртвый", "kind": "rss", "url": f"{BASE}/nofeed.xml"}]):
            self.send("/start")
            self.press("i:done")
            self.press("i:ok")
        text = self.bot.sent_texts()[-1]
        self.assertIn("Подобрать не удалось", text)
        self.assertIn("базовый набор", text)
        self.press("s:next")  # fallback-пул каталога проходит по флоу дальше
        self.assertIn("3/5", self.bot.edited_texts()[-1])

    def test_fallback_when_suggest_fails(self):
        from unittest import mock

        from bot import interview, llm

        with mock.patch.object(interview, "next_question", side_effect=["Вопрос 1", None]), \
                mock.patch.object(interview, "build_profile", return_value="П: физический AI"), \
                mock.patch.object(llm, "suggest_sources",
                                  side_effect=RuntimeError("LLM сломалась")):
            self.send("/start")
            self.press("i:done")
            self.press("i:ok")  # сбой подбора не роняет хендлер (инцидент 2026-09-20)
        text = self.bot.sent_texts()[-1]
        self.assertIn("Подобрать не удалось", text)
        self.press("s:next")  # флоу продолжается
        self.assertIn("3/5", self.bot.edited_texts()[-1])

    def test_fallback_at_start_when_llm_off(self):
        self.send("/start")  # ключа нет: интервью недоступно сразу
        text = self.bot.sent_texts()[-1]
        self.assertIn("Интервью не получилось", text)
        self.assertIn("2/5", text)
        self.press("s:next")
        self.assertIn("3/5", self.bot.edited_texts()[-1])

    def test_profile_fix_round(self):
        from unittest import mock

        from bot import interview

        with mock.patch.object(interview, "next_question",
                               side_effect=["Вопрос 1", "Уточнение: какие Metalы?"]), \
                mock.patch.object(interview, "build_profile",
                                  return_value="П: драгметаллы"):
            self.send("/start")
            self.press("i:done")  # рано закончить → черновик
            self.assertIn("П: драгметаллы", self.bot.sent_texts()[-1])
            self.press("i:fix")  # «Подправить» → ещё один вопрос
            self.assertIn("Уточнение", self.bot.sent_texts()[-1])
            self.send("Золото и платина")
            self.press("i:done")  # cap раундов не режет уточняющий
            self.assertIn("П: драгметаллы", self.bot.sent_texts()[-1])


class InterestsReachPrompt(unittest.TestCase):
    """Приёмка D45: профиль из users.interests_text попадает в промпт дайджеста."""

    def test_profile_in_digest_prompt(self):
        from pipeline import config as pconfig

        from bot import db, digest, llm

        conn = db.connect(":memory:")
        db.ensure_user(conn, 141)
        db.set_interests(conn, 141, "Платина и робототехника")
        sid = db.add_source(conn, 141, "rss", "http://x.test/f.xml", "Feed")
        db.insert_item(conn, sid, "http://ex.test/1", "Новость", "2026-09-10T00:00:00Z")
        captured = {}

        def fake_call(system, messages, max_tokens, read_timeout=None):
            captured["system"] = system
            return "Лид."

        real_call, real_key = llm._call, pconfig.LLM_API_KEY
        llm._call, pconfig.LLM_API_KEY = fake_call, "test-key"
        try:
            digest.build_delta(conn, 141)
        finally:
            llm._call, pconfig.LLM_API_KEY = real_call, real_key
        self.assertIn("Платина и робототехника", captured["system"])


# --- iter-11e (D47): retention — надгробия, окна 10/30 дней ----------------------

class Retention(unittest.TestCase):
    CHAT = 151

    def setUp(self):
        from bot import db

        self.db = db
        self.conn = db.connect(":memory:")
        db.ensure_user(self.conn, self.CHAT)
        self.sid = db.add_source(
            self.conn, self.CHAT, "rss", "http://x.test/feed.xml", "Feed")

    def seed(self, url, title, published, fetched=None, digest_record=False):
        from bot import db

        ok = db.insert_item(self.conn, self.sid, url, title, published)
        if fetched:
            self.conn.execute("UPDATE items SET fetched_at=%s WHERE url=%s",
                              (fetched, url))
        self.conn.commit()
        if digest_record and ok:
            row = self.conn.execute("SELECT id FROM items WHERE url=%s", (url,)).fetchone()
            self.db.record_digest(self.conn, self.CHAT, "t", [row[0]])
        return ok

    def test_old_items_tombstoned_and_deleted(self):
        from bot import db

        self.seed("http://ex.test/old", "Старая", "2026-09-01T00:00:00Z",
                  fetched=db.minus_iso(db.now_iso(), 24 * 20))
        self.seed("http://ex.test/fresh", "Свежая", "2026-09-17T00:00:00Z",
                  fetched=db.now_iso())
        counts = db.cleanup(self.conn)
        self.assertGreaterEqual(counts["items_deleted"], 1)
        urls = {r["url"] for r in self.conn.execute("SELECT url FROM items").fetchall()}
        self.assertEqual(urls, {"http://ex.test/fresh"})  # старая удалена
        hashes = self.conn.execute("SELECT url_hash FROM seen_hashes").fetchall()
        self.assertEqual(len(hashes), 1)  # надгробие на старую
        # повторная вставка старой записи фида отбивается надгробием (False, как дубль)
        self.assertFalse(self.db.insert_item(
            self.conn, self.sid, "http://ex.test/old", "Старая", "2026-09-01T00:00:00Z"))
        self.assertTrue(self.db.insert_item(
            self.conn, self.sid, "http://ex.test/fresh2", "Новая", None))

    def test_digests_history_seen_hashes_30d(self):
        from bot import db

        old = db.minus_iso(db.now_iso(), 24 * 40)
        self.seed("http://ex.test/old", "Старая", "2026-09-01T00:00:00Z",
                  fetched=db.minus_iso(db.now_iso(), 24 * 20), digest_record=True)
        self.conn.execute("UPDATE digests SET created_at=%s", (old,))  # сводка 40-дневная
        self.db.add_chat_message(self.conn, self.CHAT, "user", "вопрос")
        self.conn.execute("UPDATE chat_history SET created_at=%s", (old,))
        self.conn.execute(
            "INSERT INTO seen_hashes (source_id, url_hash, created_at)"
            " VALUES (%s, 'antique', %s)", (self.sid, old))
        self.conn.commit()
        counts = self.db.cleanup(self.conn)
        self.assertGreaterEqual(counts["digests_deleted"], 1)
        self.assertGreaterEqual(counts["chat_history_deleted"], 1)
        self.assertGreaterEqual(counts["seen_hashes_deleted"], 1)  # только 'antique'
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM digests WHERE chat_id=%s", (self.CHAT,)).fetchone()[0], 0)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM chat_history WHERE chat_id=%s",
            (self.CHAT,)).fetchone()[0], 0)
        # свежие данные не тронуты: свежее надгробие (created_at=now) живёт
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM seen_hashes WHERE url_hash='antique'",
        ).fetchone()[0], 0)

    def test_retention_once_logs_counts(self):
        from bot import db
        from bot.scheduler import retention_once

        self.seed("http://ex.test/old", "Старая", "2026-09-01T00:00:00Z",
                  fetched=db.minus_iso(db.now_iso(), 24 * 20))
        counts = asyncio.run(retention_once(self.conn))
        self.assertIn("items_deleted", counts)


if __name__ == "__main__":
    unittest.main()
