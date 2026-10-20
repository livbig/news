"""Итерация 18 (2026-09-23): обрезанный по max_tokens ответ LLM — сбой с
ретраем, а не «короткая сводка» (инцидент: пользователю ушло 613 символов);
gist/chat без thinking (thinking съедал малый max_tokens → пустые выжимки);
кодификация ошибок сбора (HTTP_403/TIMEOUT/…); Reddit OAuth API вместо .rss
(сетевой блок датацентр/VPN-IP). tests/TESTPLAN.md."""
import re
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fakes.py


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/blocked"):
            status, body = 403, b"Blocked"
        else:
            status, body = 404, b"nope"
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
    from pipeline import config as pconfig

    _SAVED = pconfig.LLM_API_KEY
    pconfig.LLM_API_KEY = ""


def tearDownModule():
    SERVER.shutdown()
    SERVER.server_close()
    from pipeline import config as pconfig

    pconfig.LLM_API_KEY = _SAVED


# --- обрезанный ответ = сбой (LLMTruncatedError), не сводка ------------------------

class TruncatedIsFailure(unittest.TestCase):

    def _run(self, side_effects):
        from pipeline import config as pconfig
        from bot import llm

        calls = []

        def fake_call(system, messages, max_tokens, read_timeout=None, thinking=None,
                      effort=None):
            calls.append(effort)
            effect = side_effects[len(calls) - 1]
            if isinstance(effect, Exception):
                raise effect
            return effect

        real_call, real_key, real_sleep = llm._call, pconfig.LLM_API_KEY, llm._sleep
        llm._call, pconfig.LLM_API_KEY = fake_call, "test-key"
        llm._sleep = lambda s: None
        try:
            return llm.summarize("заголовок — http://ex.test/1"), len(calls)
        finally:
            llm._call, pconfig.LLM_API_KEY, llm._sleep = real_call, real_key, real_sleep

    def test_truncated_retries_then_raises(self):
        from pipeline.llm import LLMTruncatedError
        from bot import llm

        with self.assertRaises(llm.LLMError) as ctx:
            self._run([LLMTruncatedError("обрезан"), LLMTruncatedError("обрезан")])
        self.assertIn("обрезан", str(ctx.exception))

    def test_truncated_then_success(self):
        from pipeline.llm import LLMTruncatedError

        text, attempts = self._run([LLMTruncatedError("обрезан"), "Лид.\nПункт."])
        self.assertEqual(attempts, 2)
        self.assertIn("Лид.", text)


# --- gist идёт без thinking (thinking съедал MAP_MAX_TOKENS=2500 → пусто) ---------

class GistNoThinking(unittest.TestCase):

    def test_make_gist_disables_thinking(self):
        from pipeline import config as pconfig
        from bot import llm

        captured = {}

        def fake_call(system, messages, max_tokens, read_timeout=None, thinking=None,
                      effort=None):
            captured["thinking"] = thinking
            return "Выжимка сути."

        real_call, real_key = llm._call, pconfig.LLM_API_KEY
        llm._call, pconfig.LLM_API_KEY = fake_call, "test-key"
        try:
            out = llm.make_gist("Полный текст новости.")
        finally:
            llm._call, pconfig.LLM_API_KEY = real_call, real_key
        self.assertEqual(out, "Выжимка сути.")
        self.assertIs(captured["thinking"], False)


# --- кодификация ошибок ------------------------------------------------------------

class ErrCode(unittest.TestCase):

    def test_mapping(self):
        import httpx

        from bot.collectors.http import err_code

        req = httpx.Request("GET", "http://ex.test/")
        resp = httpx.Response(403, request=req)
        self.assertEqual(
            err_code(httpx.HTTPStatusError("HTTP 403", request=req, response=resp)),
            "HTTP_403")
        self.assertEqual(err_code(httpx.ReadTimeout("t", request=req)), "TIMEOUT")
        self.assertEqual(err_code(httpx.ConnectError("x", request=req)), "NETWORK")
        self.assertEqual(err_code(RuntimeError("некорректный фид")), "RUNTIMEERROR")


class CollectFailCoded(unittest.TestCase):
    CHAT = 182

    def test_status_carries_code(self):
        from bot import collect, db

        conn = db.connect(":memory:")
        db.ensure_user(conn, self.CHAT)
        sid = db.add_source(conn, self.CHAT, "rss", f"{BASE}/blocked", "Blocked")
        real_sleep = __import__("bot.collectors.http", fromlist=["_sleep"])._sleep
        __import__("bot.collectors.http", fromlist=["_sleep"])._sleep = lambda s: None
        try:
            _total, errors = collect.collect_enabled(conn, self.CHAT)
        finally:
            __import__("bot.collectors.http", fromlist=["_sleep"])._sleep = real_sleep
        self.assertEqual(len(errors), 1)
        row = conn.execute(
            "SELECT status, status_msg FROM sources WHERE id=%s", (sid,)).fetchone()
        self.assertEqual(row["status"], "error")
        self.assertTrue(row["status_msg"].startswith("[HTTP_403]"), row["status_msg"])


# --- Reddit OAuth (iter-18) ---------------------------------------------------------

class RedditApi(unittest.TestCase):

    def test_entries_mapping(self):
        from bot import collect

        data = {"data": {"children": [
            {"data": {"title": "Пост один", "permalink": "/r/wsb/comments/abc/x/",
                      "created_utc": 1758600000, "selftext": "тело поста"}},
            {"data": {"title": "", "permalink": "/r/wsb/comments/def/y/"}},
            {"data": {"title": "Без пермалинка"}},
        ]}}
        entries = collect._reddit_entries(data)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["title"], "Пост один")
        self.assertEqual(entry["link"], "https://www.reddit.com/r/wsb/comments/abc/x/")
        self.assertEqual(entry["summary"], "тело поста")
        self.assertIsNotNone(entry["published_parsed"])

    def test_url_re(self):
        from bot import collect

        for url, name, sort in (
            ("https://www.reddit.com/r/wallstreetbets/.rss", "wallstreetbets", None),
            ("https://www.reddit.com/r/investing/new/.rss", "investing", "new"),
        ):
            m = collect.REDDIT_URL_RE.search(url)
            self.assertEqual((m.group(1), m.group(2)), (name, sort))

    def test_fetch_feed_routes_to_api_with_creds(self):
        from bot import collect, config

        seen = {}

        def fake_api(url):
            seen["url"] = url
            return "r/wallstreetbets", [{"title": "t", "link": "http://x"}]

        real_api, real_id, real_secret = (collect.fetch_reddit_api,
                                          config.REDDIT_CLIENT_ID,
                                          config.REDDIT_CLIENT_SECRET)
        collect.fetch_reddit_api = fake_api
        config.REDDIT_CLIENT_ID, config.REDDIT_CLIENT_SECRET = "id", "secret"
        try:
            title, entries = collect.fetch_feed(
                "https://www.reddit.com/r/wallstreetbets/.rss")
        finally:
            collect.fetch_reddit_api = real_api
            config.REDDIT_CLIENT_ID, config.REDDIT_CLIENT_SECRET = real_id, real_secret
        self.assertEqual(title, "r/wallstreetbets")
        self.assertEqual(seen["url"], "https://www.reddit.com/r/wallstreetbets/.rss")


if __name__ == "__main__":
    unittest.main()
