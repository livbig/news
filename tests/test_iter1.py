"""Итерация 1: TC-03, TC-04, TC-05, TC-42 (tests/TESTPLAN.md + «Правки после сверки»)."""
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

RSS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>fixture</title>
<item><title>Alpha &amp; Alpha</title><link>http://ex.test/1</link>
<pubDate>Mon, 07 Nov 2022 10:00:00 GMT</pubDate></item>
<item><title>Beta _italic_ [x](y) *bold*</title><link>http://ex.test/2</link>
<pubDate>Tue, 08 Nov 2022 10:00:00 GMT</pubDate></item>
<item><title>Gamma</title><link>http://ex.test/3</link></item>
</channel></rss>"""


class _RSSHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = RSS_XML.encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/rss+xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def start_rss_server() -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _RSSHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class TC03UrlHash(unittest.TestCase):
    """Формула url_hash (D19): стабильность, нормализация, различимость."""

    def test_formula(self):
        from pipeline.db import url_hash

        self.assertEqual(url_hash("http://a/x", "T"), url_hash("http://a/x", "T"))
        # нормализация: query-параметр и хвостовой слэш URL не меняют хэш
        self.assertEqual(url_hash("http://a/x?utm=1", "T"), url_hash("http://a/x", "T"))
        self.assertEqual(url_hash("http://a/x/", "T"), url_hash("http://a/x", "T"))
        # нормализация: регистр и пробелы заголовка не меняют хэш
        self.assertEqual(url_hash("http://a/x", "Title  Text"), url_hash("http://a/x", "title text"))
        # различимость входов
        self.assertNotEqual(url_hash("http://a/x", "t1"), url_hash("http://a/y", "t1"))
        self.assertNotEqual(url_hash("http://a/x", "t1"), url_hash("http://a/x", "t2"))
        # sha256-длина
        self.assertEqual(len(url_hash("u", "t")), 64)


class TC04Idempotent(unittest.TestCase):
    """Повторный сбор не создаёт дублей (UNIQUE(source_id, url_hash), INSERT OR IGNORE)."""

    def test_insert_and_collect(self):
        from bot import collect, db

        conn = db.connect(":memory:")
        sid = db.ensure_bootstrap(conn, "http://ex.test/feed")
        self.assertTrue(db.insert_item(conn, sid, "http://ex.test/1", "A", "2026-01-01T00:00:00Z"))
        self.assertFalse(db.insert_item(conn, sid, "http://ex.test/1", "A", "2026-01-01T00:00:00Z"))
        self.assertFalse(
            db.insert_item(conn, sid, "http://ex.test/1?utm=x", "A", "2026-01-01T00:00:00Z")
        )  # query-вариант — тоже дубликат (правка после сверки)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM items").fetchone()[0], 1)

        srv = start_rss_server()
        feed = f"http://127.0.0.1:{srv.server_port}/rss"
        try:
            sid2 = db.ensure_bootstrap(conn, feed)
            self.assertEqual(collect.collect_source(conn, sid2, feed), 3)
            self.assertEqual(collect.collect_source(conn, sid2, feed), 0)  # повтор — 0 дублей
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM items WHERE source_id=%s", (sid2,)).fetchone()[0],
                3,
            )
            # published нормализован в ISO у элементов с датой и без
            pubs = [r[0] for r in conn.execute("SELECT published FROM items WHERE source_id=%s", (sid2,))]
            self.assertTrue(all(len(p) == 20 and p.endswith("Z") for p in pubs), pubs)
        finally:
            srv.shutdown()
            srv.server_close()


class TC05Split(unittest.TestCase):
    """Разбиение >4000 по абзацам, каждый чанк ≤4000, порядок пунктов сохранён."""

    def test_chunk_text(self):
        from pipeline.telegram import chunk_text

        paras = [f"Пункт {i}: " + ("слово " * 150) for i in range(50)]  # ~26 тыс. символов
        text = "\n\n".join(paras)
        self.assertGreater(len(text), 4000)
        chunks = chunk_text(text)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertLessEqual(len(c), 4000)
        joined = "\n\n".join(chunks)
        positions = [joined.find(f"Пункт {i}:") for i in range(50)]
        self.assertTrue(all(p >= 0 for p in positions))
        self.assertEqual(positions, sorted(positions))  # порядок не потерян и не перемешан


class TC42NoTokens(unittest.TestCase):
    """Полный прогон без токенов: mock-сводка в stdout, exit 0, без трейсбэков."""

    def test_mock_e2e(self):
        srv = start_rss_server()
        feed = f"http://127.0.0.1:{srv.server_port}/rss"
        env = dict(
            os.environ,
            TELEGRAM_TOKEN="",
            TELEGRAM_TOKEN_DEV="",
            TELEGRAM_CHAT_ID="",
            LLM_API_KEY="",  # с И5 build_delta зовёт LLM: пустой ключ = mock (NFR-05)
            BOT_FEED_URL=feed,
            BOT_DB_PATH="/tmp/iter1_tc42_bot.db",
        )
        if os.path.exists(env["BOT_DB_PATH"]):
            os.unlink(env["BOT_DB_PATH"])
        try:
            p = subprocess.run(
                [sys.executable, "-m", "bot"],
                capture_output=True,
                text=True,
                env=env,
                cwd=ROOT,
                timeout=120,
            )
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("MOCK-сводка", p.stdout)
            self.assertIn("http://ex.test/1", p.stdout)  # пункт со ссылкой на первоисточник
            self.assertNotIn("Traceback", p.stderr)
            self.assertNotIn("Traceback", p.stdout)
            # повторный прогон той же БД: items не растут, сводка всё ещё собирается
            p2 = subprocess.run(
                [sys.executable, "-m", "bot"],
                capture_output=True,
                text=True,
                env=env,
                cwd=ROOT,
                timeout=120,
            )
            self.assertEqual(p2.returncode, 0, p2.stderr)
            self.assertIn("[+0 новых", p2.stdout)  # дубликатов нет
        finally:
            srv.shutdown()
            srv.server_close()
            if os.path.exists(env["BOT_DB_PATH"]):
                os.unlink(env["BOT_DB_PATH"])


if __name__ == "__main__":
    unittest.main()
