"""Итерация 6: TC-13/TC-14 (html-коллектор), TC-15/TC-16 (tgweb через t.me/s),
TC-17/TC-18 (reddit .rss — правка D28), TC-19/TC-20 (мост X, деградация D3),
TC-21 (изоляция мёртвого URL) — tests/TESTPLAN.md."""
import asyncio
import io
import sys
import threading
import unittest
from contextlib import contextmanager, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fakes.py

RSS3_XML = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Valid Feed</title>
<item><title>Первая новость</title><link>http://ex.test/1</link></item>
<item><title>Вторая новость</title><link>http://ex.test/2</link></item>
<item><title>Третья новость</title><link>http://ex.test/3</link></item>
</channel></rss>""").encode()

OTHER_XML = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Other Feed</title>
<item><title>Другая новость один</title><link>http://ex2.test/1</link></item>
<item><title>Другая новость два</title><link>http://ex2.test/2</link></item>
</channel></rss>""").encode()

REDDIT_XML = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>r/testsub</title>
<item><title>Пост сабреддита один</title><link>http://rd.test/1</link></item>
<item><title>Пост сабреддита два</title><link>http://rd.test/2</link></item>
</channel></rss>""").encode()

BRIDGE_XML = ("""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>durov</title>
<item><title>Твит один: рынок растёт на новостях</title><link>https://x.com/durov/1</link></item>
<item><title>Твит два: металлы снова в фокусе</title><link>https://x.com/durov/2</link></item>
</channel></rss>""").encode()

HTML_LIST = """<html><body>
<nav><a href="/about">О сайте</a> <a href="https://twitter.com/share">Поделиться в соцсети X</a></nav>
<main>
<a href="/articles/one">Первая статья: драгметаллы и валюта за неделю</a>
<a href="/articles/two">Вторая статья: рынок США закрылся в плюсе</a>
<a href="/articles/three">Третья статья: итоги квартала ведущих компаний</a>
<a href="/articles/one">Первая статья: драгметаллы и валюта за неделю</a>
</main>
</body></html>""".encode()

HTML_GARBAGE = "<html><body><p>Страница без списка новостей и ссылок</p></body></html>".encode()


def tg_html(posts: list[tuple[int, str, str]]) -> bytes:
    """Имитация разметки веб-превью t.me/s (R6: data-post/message_text/datetime)."""
    blocks = "".join(
        f'<div class="tgme_widget_message_wrap" data-post="testch/{pid}">'
        f'<div class="tgme_widget_message_text js-message_text" dir="ltr">{text}</div>'
        f'<time datetime="{dt}"></time></div>'
        for pid, dt, text in posts
    )
    return f"<html><body>{blocks}</body></html>".encode()


TG_PAGE1 = tg_html([
    (10, "2026-09-12T10:00:00+00:00", "Пост десять: драгметаллы прибавили на слабом долларе"),
    (9, "2026-09-12T09:00:00+00:00", "Пост девять: рынок США закрылся ростом"),
    (8, "2026-09-12T08:00:00+00:00", "Пост восемь: краткие итоги недели"),
])
# после первого сбора (last_post_id=10) «появились» посты 12, 11 — первая страница
# целиком свежая → пагинация уходит назад до знакомого поста (R6)
TG_PAGE1B = tg_html([
    (12, "2026-09-13T10:00:00+00:00", "Пост двенадцать: новая сводка канала"),
    (11, "2026-09-13T09:00:00+00:00", "Пост одиннадцать: анонс эфира"),
])
TG_OLD = tg_html([
    (10, "2026-09-12T10:00:00+00:00", "Пост десять: драгметаллы прибавили на слабом долларе"),
    (9, "2026-09-12T09:00:00+00:00", "Пост девять: рынок США закрылся ростом"),
])
TG_EMPTY = "<html><body><div>Channel preview</div></body></html>".encode()


class Handler(BaseHTTPRequestHandler):
    HITS: dict[str, int] = {}
    UA: dict[str, str] = {}
    TG_RUN = 0  # заходы на первую страницу канала: превью/первый сбор — посты 8..10, далее 11..12

    def do_GET(self):
        Handler.HITS[self.path] = Handler.HITS.get(self.path, 0) + 1
        path = self.path.split("?")[0]
        Handler.UA.setdefault(path, self.headers.get("User-Agent", ""))
        route = {
            "/rss3.xml": (200, RSS3_XML),
            "/other.xml": (200, OTHER_XML),
            "/html_list.html": (200, HTML_LIST),
            "/html_garbage.html": (200, HTML_GARBAGE),
            "/r/testsub/new/.rss": (200, REDDIT_XML),
            "/bridge/durov/rss": (200, BRIDGE_XML),
        }.get(self.path)
        if path == "/tgweb/testch":
            if "before=11" in self.path:
                route = (200, TG_OLD)
            else:
                Handler.TG_RUN += 1
                route = (200, TG_PAGE1 if Handler.TG_RUN <= 2 else TG_PAGE1B)
        elif path == "/tgweb/empty":
            route = (200, TG_EMPTY)
        elif path == "/tgweb/closed":
            route = (403, b"forbidden")
        elif path == "/r/slow/new/.rss":
            route = (429, b"slow down")
        elif path == "/bridge503/durov/rss":
            route = (503, b"bridge down")
        if route is None:
            route = (404, b"nope")
        status, body = route
        self.send_response(status)
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
    # ключи/чаты .env не утекают в тесты (NFR-05); шаблоны типов — на fixture (§1.3)
    _SAVED = (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY,
              bconfig.TWITTER_BRIDGE_URL_TEMPLATE, bconfig.TGWEB_URL_TEMPLATE,
              bconfig.REDDIT_RSS_TEMPLATE)
    bconfig.TOKEN = ""
    bconfig.ALLOWED_CHAT_ID = ""
    pconfig.LLM_API_KEY = ""
    bconfig.TGWEB_URL_TEMPLATE = f"{BASE}/tgweb/{{name}}"
    bconfig.REDDIT_RSS_TEMPLATE = f"{BASE}/r/{{name}}/new/.rss"
    bconfig.TWITTER_BRIDGE_URL_TEMPLATE = f"{BASE}/bridge/{{name}}/rss"


def tearDownModule():
    SERVER.shutdown()
    SERVER.server_close()
    from bot import config as bconfig
    from pipeline import config as pconfig
    (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY,
     bconfig.TWITTER_BRIDGE_URL_TEMPLATE, bconfig.TGWEB_URL_TEMPLATE,
     bconfig.REDDIT_RSS_TEMPLATE) = _SAVED


# --- инфраструктура: fake-обновления + FakeBot (как test_iter3) ----------------

from aiogram.types import Update  # noqa: E402
from fakes import FakeBot, make_callback, make_message, shared_dispatcher  # noqa: E402


class ChatCase(unittest.TestCase):
    """Общее: чистая БД, общий диспетчер, fake-поллинг; FSM-состояние сбрасывается."""

    CHAT = 6464
    USER = 9

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

    def conn(self):
        from bot.handlers import onboarding
        return onboarding.conn

    @contextmanager
    def quiet(self):
        """Без реальных пауз ретраев/t.me — тесты быстрые (fake-таймеры §1.5)."""
        from bot import collect
        from bot.collectors import http as httpmod
        real = (httpmod._sleep, collect._pause)
        httpmod._sleep = lambda s: None
        collect._pause = lambda s: None
        try:
            yield httpmod, collect
        finally:
            httpmod._sleep, collect._pause = real

    def item_count(self, source_id=None):
        sql = "SELECT COUNT(*) FROM items" + (" WHERE source_id=%s" if source_id else "")
        return self.conn().execute(sql, ((source_id,) if source_id else ())).fetchone()[0]


class TC13HtmlCollect(unittest.TestCase):
    """FR-06: страница со списком ссылок приносит элементы; дедуп; status ok."""

    def test_html(self):
        from bot import collect, db

        conn = db.connect(":memory:")
        sid = db.add_source(conn, 9, "html", f"{BASE}/html_list.html", "Site News")
        row = {"id": sid, "kind": "html", "url": f"{BASE}/html_list.html", "last_post_id": 0}
        self.assertEqual(collect.collect_one(conn, row), 3)
        rows = conn.execute(
            "SELECT url, title, published FROM items WHERE source_id=%s ORDER BY id", (sid,)
        ).fetchall()
        self.assertEqual([r["url"] for r in rows],
                         [f"{BASE}/articles/one", f"{BASE}/articles/two", f"{BASE}/articles/three"])
        self.assertEqual(rows[0]["title"], "Первая статья: драгметаллы и валюта за неделю")
        # даты на странице нет → fetched_at-семантика (план §1.2)
        self.assertTrue(all(r["published"].endswith("Z") for r in rows))
        self.assertEqual(conn.execute(
            "SELECT status FROM sources WHERE id=%s", (sid,)).fetchone()[0], "ok")
        # повторный сбор — дедуп по (source_id, url_hash)
        self.assertEqual(collect.collect_one(conn, row), 0)
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM items WHERE source_id=%s", (sid,)).fetchone()[0], 3)


class TC14GarbagePage(ChatCase):
    """FR-06 негатив: неразбираемая страница — ошибка источника, прогон жив."""

    def test_garbage_isolated(self):
        sid_g = self.db.add_source(self.conn(), self.CHAT, "html",
                                   f"{BASE}/html_garbage.html", "Garbage")
        sid_r = self.db.add_source(self.conn(), self.CHAT, "rss",
                                   f"{BASE}/rss3.xml", "Valid Feed")
        with self.assertLogs("bot.collect", level="ERROR") as captured:
            out = self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("Первая новость", out)  # валидный RSS собран, сводка доставлена
        self.assertIn("html_garbage.html", "\n".join(captured.output))  # лог с URL страницы
        row = self.db.get_source(self.conn(), sid_g)
        self.assertIn(row["status"], ("error", "degraded"))
        self.assertIn("не найдено ссылок", row["status_msg"])
        self.assertEqual(self.db.get_source(self.conn(), sid_r)["status"], "ok")


class TC15TgwebMaster(ChatCase):
    """FR-07: канал добавляется мастером, посты в items; запросы с паузами."""

    def test_master_and_collect(self):
        self.press("add:start")
        self.press("a:k:tgweb")
        self.assertIn("@имя канала", self.bot.edited_texts()[-1])
        self.send("testch")  # имя канала → превью
        preview = self.bot.sent_texts()[-1]
        self.assertIn("t.me/testch", preview)
        self.assertIn("Пост", preview)
        self.press("a:confirm")
        rows = self.db.list_sources(self.conn(), self.CHAT)
        self.assertEqual((rows[0]["kind"], rows[0]["url"], rows[0]["origin"]),
                         ("tgweb", "testch", "manual"))

        pauses = []
        Handler.HITS.clear()
        with self.quiet() as (_httpmod, collect):
            collect._pause = pauses.append
            out = self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("Пост десять", out)  # посты канала — в сводке
        self.assertEqual(self.item_count(rows[0]["id"]), 3)  # первый сбор: посты 8..10
        self.assertEqual(
            self.conn().execute("SELECT last_post_id FROM sources WHERE id=%s",
                                (rows[0]["id"],)).fetchone()[0], 10)
        self.assertEqual(list(Handler.HITS), ["/tgweb/testch"])  # одна страница (R6)
        self.assertEqual(self.db.get_source(self.conn(), rows[0]["id"])["status"], "ok")

        # появились новые посты (12, 11): первая страница целиком свежая →
        # пагинация уходит назад до знакомого поста; старые не дублируются
        Handler.HITS.clear()
        pauses.clear()
        with self.quiet() as (_httpmod, collect):
            collect._pause = pauses.append
            self.stdout_of(lambda: self.send("/digest"))
        self.assertEqual(list(Handler.HITS),
                         ["/tgweb/testch", "/tgweb/testch?before=11"])  # последовательно
        self.assertEqual(pauses, [collect.TGWEB_PAUSE])  # щадящая пауза (FR-07)
        self.assertEqual(self.item_count(rows[0]["id"]), 5)  # +12, +11; 10, 9 не дублированы
        self.assertEqual(
            self.conn().execute("SELECT last_post_id FROM sources WHERE id=%s",
                                (rows[0]["id"],)).fetchone()[0], 12)


class TC16TgwebClosed(ChatCase):
    """FR-07 негатив: превью закрыто (403 / пустая страница) — деградация."""

    def test_closed_and_empty(self):
        with self.quiet():
            sid = self.db.add_source(self.conn(), self.CHAT, "tgweb", "closedch", "t.me/closedch")
            out = self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("Не удалось собрать 1 источник(ов)", out)
        self.assertIn("/tgweb/closed", out)
        row = self.db.get_source(self.conn(), sid)
        self.assertEqual(row["status"], "degraded")
        self.assertIn("превью", row["status_msg"])
        self.send("/sources")  # предупреждение видно, без стектрейса
        text = self.bot.sent_texts()[-1]
        self.assertIn("⚠", text)
        self.assertIn("превью", text)
        self.assertNotIn("Traceback", text)

        with self.quiet():  # 200 без постов — как redirect на страницу логина
            sid2 = self.db.add_source(self.conn(), self.CHAT, "tgweb", "empty", "t.me/empty")
            self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("закрыто или пусто", self.db.get_source(self.conn(), sid2)["status_msg"])


class TC17RedditMaster(ChatCase):
    """FR-08 (правка D28): сабреддит через .rss-эндпоинт как rss-источник."""

    def test_master_and_collect(self):
        self.press("add:start")
        self.press("a:k:reddit")
        self.assertIn("сабреддит", self.bot.edited_texts()[-1])
        self.send("r/testsub")  # имя с префиксом — валидно
        preview = self.bot.sent_texts()[-1]
        self.assertIn("r/testsub", preview)
        self.assertIn("Пост сабреддита один", preview)
        self.press("a:confirm")
        rows = self.db.list_sources(self.conn(), self.CHAT)
        self.assertEqual((rows[0]["kind"], rows[0]["url"]),
                         ("rss", f"{BASE}/r/testsub/new/.rss"))  # D28: это rss-источник

        with self.quiet():
            out = self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("Пост сабреддита один", out)  # посты в сводке
        self.assertIn("Mozilla", Handler.UA["/r/testsub/new/.rss"])  # User-Agent обязателен
        self.assertEqual(self.db.get_source(self.conn(), rows[0]["id"])["status"], "ok")
        with self.quiet():
            self.stdout_of(lambda: self.send("/digest"))  # дедуп
        self.assertEqual(self.item_count(rows[0]["id"]), 2)


class TC18Reddit429(ChatCase):
    """FR-08 негатив: 429 → ретраи с backoff, прогон завершён, RSS собран."""

    def test_429_backoff(self):
        self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/r/slow/new/.rss", "r/slow")
        self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/rss3.xml", "Valid Feed")
        pauses = []
        with self.quiet() as (httpmod, _collect):
            httpmod._sleep = pauses.append
            out = self.stdout_of(lambda: self.send("/digest"))
        self.assertEqual(Handler.HITS["/r/slow/new/.rss"], 4)  # 1 запрос + 3 ретрая
        self.assertEqual(pauses, [1, 2, 4])  # нарастающий backoff
        self.assertIn("Первая новость", out)  # валидный RSS собран, сводка отправлена
        status = self.conn().execute(
            "SELECT status, status_msg FROM sources WHERE url=%s", (f"{BASE}/r/slow/new/.rss",)
        ).fetchone()
        self.assertEqual(status["status"], "error")
        self.assertTrue(status["status_msg"])


class TC19TwitterMaster(ChatCase):
    """FR-09: аккаунт X через RSS-мост; при работающем мосте — посты в сводке."""

    def test_master_and_collect(self):
        self.press("add:start")
        self.press("a:k:twitter")
        self.assertIn("аккаунта X", self.bot.edited_texts()[-1])
        self.send("@durov")
        preview = self.bot.sent_texts()[-1]
        self.assertIn("@durov", preview)
        self.assertIn("Твит один", preview)
        self.press("a:confirm")
        rows = self.db.list_sources(self.conn(), self.CHAT)
        self.assertEqual((rows[0]["kind"], rows[0]["url"]), ("twitter", "durov"))

        with self.quiet():
            out = self.stdout_of(lambda: self.send("/digest"))
        self.assertIn("Твит один: рынок растёт", out)  # твиты в сводке
        self.assertEqual(self.db.get_source(self.conn(), rows[0]["id"])["status"], "ok")


class TC20BridgeDown(ChatCase):
    """FR-09 негатив + NFR-02: мост недоступен — деградация, не блокер."""

    def test_bridge_degradation(self):
        from bot import config as bconfig
        saved = bconfig.TWITTER_BRIDGE_URL_TEMPLATE
        bconfig.TWITTER_BRIDGE_URL_TEMPLATE = f"{BASE}/bridge503/{{name}}/rss"
        try:
            sid_tw = self.db.add_source(self.conn(), self.CHAT, "twitter", "durov", "@durov")
            sid_rd = self.db.add_source(self.conn(), self.CHAT, "rss",
                                        f"{BASE}/r/testsub/new/.rss", "r/testsub")
            self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/rss3.xml", "Valid Feed")
            with self.quiet():
                out = self.stdout_of(lambda: self.send("/digest"))
                self.send("/sources")
            # прогон не прерван: остальные источники собраны, сводка отправлена
            self.assertIn("Первая новость", out)
            self.assertIn("Пост сабреддита один", out)
            # предупреждение — в футере сводки и в /sources (§1.5, TC-20)
            self.assertIn("Не удалось собрать 1 источник(ов)", out)
            self.assertIn("/bridge503/durov/rss", out)
            self.assertIn("⚠", self.bot.sent_texts()[-1])
            row = self.db.get_source(self.conn(), sid_tw)
            self.assertEqual(row["status"], "degraded")
            self.assertTrue(row["status_msg"])
            self.assertEqual(self.db.get_source(self.conn(), sid_rd)["status"], "ok")
            self.assertEqual(Handler.HITS["/bridge503/durov/rss"], 4)  # ретраи были
        finally:
            bconfig.TWITTER_BRIDGE_URL_TEMPLATE = saved


class TC21DeadURL(ChatCase):
    """NFR-02: мёртвый URL — лог с URL и исключением, сводка из живых, код успешный."""

    def test_dead_url_isolated(self):
        self.db.add_source(self.conn(), self.CHAT, "rss", "http://127.0.0.1:1/dead.xml", "Dead")
        self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/rss3.xml", "Valid Feed")
        self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/other.xml", "Other Feed")
        with self.assertLogs("bot.collect", level="ERROR") as captured, self.quiet():
            out = self.stdout_of(lambda: self.send("/digest"))
        logged = "\n".join(captured.output)
        self.assertIn("http://127.0.0.1:1/dead.xml", logged)  # URL мёртвого источника
        self.assertIn("ConnectError", logged)  # тип исключения
        self.assertEqual(self.item_count(), 5)  # оба живых собраны
        self.assertIn("Первая новость", out)  # сводка построена и доставлена
        self.assertIn("Другая новость один", out)
        status = self.conn().execute(
            "SELECT status FROM sources WHERE url='http://127.0.0.1:1/dead.xml'"
        ).fetchone()[0]
        self.assertEqual(status, "error")


if __name__ == "__main__":
    unittest.main()
