"""Итерация 7: TC-46 (IP-пиннинг D23), TC-44 (аудит зависимостей NFR-01),
TC-37 (news.db не изменяется, NFR-07), диалоговый режим (R11/D27),
TC-41 (happy path e2e: онбординг → свой RSS → плановая сводка),
TC-45 (логи + LOG.md, NFR-06) — tests/TESTPLAN.md (+правки сверки)."""
import asyncio
import hashlib
import importlib.metadata
import importlib.util
import io
import os
import re
import subprocess
import sys
import threading
import time
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta
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


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = VALID_XML if self.path == "/rss.xml" else b"nope"
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
    # ключи/чаты .env не утекают в тесты (NFR-05)
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


# --- TC-46 (unit): IP-пиннинг api.telegram.org наследуется (D23) ----------------

class TC46Pinning(unittest.TestCase):
    def test_pinned_with_import(self):
        # тестовый процесс импортирует bot.* → импорт pipeline уже случился
        import socket

        infos = socket.getaddrinfo("api.telegram.org", 443)
        ips = {info[4][0] for info in infos}
        self.assertIn("149.154.167.220", ips)

    def test_provider_dns_without_pinning(self):
        """Информационная половина TC-46: резолв в отдельном процессе БЕЗ
        импорта pipeline — DNS-ответ провайдера (может совпасть или не быть)."""
        code = ("import socket;"
                "print(sorted({i[4][0] for i in socket.getaddrinfo('api.telegram.org', 443)}))")
        proc = subprocess.run([sys.executable, "-c", code],
                              capture_output=True, text=True, timeout=30)
        detail = proc.stdout.strip() or proc.stderr.strip().splitlines()[-1:]
        print(f"    DNS без пиннинга: {detail}")
        self.assertTrue(detail)


# --- TC-44 (unit): аудит зависимостей (NFR-01) ----------------------------------

class TC44Dependencies(unittest.TestCase):
    ALLOWED_THIRDPARTY = {"aiogram", "httpx", "feedparser", "bs4", "psycopg"}  # D11: +bs4, М2: +psycopg
    BANNED = ("telethon", "pyrogram", "django", "fastapi", "celery", "flask")

    def test_bot_imports_are_known(self):
        tops = set()
        for path in (ROOT / "bot").rglob("*.py"):
            for line in path.read_text().splitlines():
                m = re.match(r"\s*(?:from|import)\s+([.\w]+)", line)
                if m and not m.group(1).startswith("."):  # относительные — мимо
                    top = m.group(1).split(".")[0]
                    if top:
                        tops.add(top)
        for name in sorted(tops):
            if name in self.ALLOWED_THIRDPARTY or name in ("bot", "pipeline"):
                continue
            self.assertIn(name, sys.stdlib_module_names,
                          f"посторонняя зависимость в bot/: {name}")

    def test_no_mtproto_no_heavy_frameworks(self):
        for name in self.BANNED:
            self.assertIsNone(importlib.util.find_spec(name), name)
        installed = {
            (d.metadata["Name"] or "").lower() for d in importlib.metadata.distributions()
        }
        for name in self.BANNED:
            self.assertNotIn(name, installed)


# --- TC-37 (integration): news.db не изменяется ботом (NFR-07) -------------------

class TC37NewsDbUntouched(unittest.TestCase):
    def test_full_cycle_does_not_touch_news_db(self):
        from bot import collect, db, digest, llm
        from pipeline import config as pconfig

        news = Path(pconfig.DB_PATH)
        created = not news.exists()
        if created:  # свежий клон: пустой news.db — инвариант «бот не трогает» тот же
            news.touch()
            self.addCleanup(news.unlink)
        self.assertTrue(news.exists())
        before = (news.stat().st_mtime_ns, hashlib.sha256(news.read_bytes()).hexdigest())

        conn = db.connect(":memory:")  # все записи — в bot.db (здесь in-memory)
        db.finalize_survey(
            conn, 555, [{"url": f"{BASE}/rss.xml", "title": "Valid", "topics": []}],
            ["09:00"], "replace",
        )
        row = conn.execute("SELECT id, kind, url FROM sources WHERE chat_id=555").fetchone()
        collect.collect_one(conn, dict(row))
        text, ids = digest.build_delta(conn, 555)
        self.assertTrue(text and len(ids) == 3)
        self.assertTrue(db.record_digest(conn, 555, text, ids))
        # диалог тоже пишет только в bot.db (chat_history); ключ подменяем —
        # setUpModule обнулил его для NFR-05
        real_chat, real_key = llm.chat, pconfig.LLM_API_KEY
        pconfig.LLM_API_KEY = "test-key"
        llm.chat = lambda messages, context: "Ответ"
        try:
            self.assertEqual(llm.ask(conn, 555, "вопрос"), "Ответ")
        finally:
            llm.chat, pconfig.LLM_API_KEY = real_chat, real_key

        after = (news.stat().st_mtime_ns, hashlib.sha256(news.read_bytes()).hexdigest())
        self.assertEqual(before, after)


# --- диалоговый режим (R11, D27) -------------------------------------------------

from aiogram.types import Update  # noqa: E402
from fakes import FakeBot, make_callback, make_message, shared_dispatcher  # noqa: E402


class ChatCase(unittest.TestCase):
    """Общее: чистая БД, общий диспетчер, fake-поллинг; FSM-состояние сброшено."""

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
        key = StorageKey(bot_id=self.bot.id, chat_id=self.CHAT, user_id=self.USER)
        asyncio.run(self.dp.storage.set_state(key, None))
        asyncio.run(self.dp.storage.set_data(key, {}))
        onboarding.ACTIVE.clear()

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


class DialogCase(ChatCase):
    """LLM_API_KEY подменён, bot.llm.chat — фейк с записью вызовов."""

    ANSWER = 'Ответ ассистента <a href="http://ex.test/1">ссылка</a>'

    def setUp(self):
        super().setUp()
        from bot import llm
        from pipeline import config as pconfig

        self._saved = (pconfig.LLM_API_KEY, llm.chat)
        pconfig.LLM_API_KEY = "test-key"
        self.calls = []

        def fake_chat(messages, context):
            self.calls.append((list(messages), context))
            return self.ANSWER

        llm.chat = fake_chat

    def tearDown(self):
        from bot import llm
        from pipeline import config as pconfig

        pconfig.LLM_API_KEY, llm.chat = self._saved


class TestDialogAsk(DialogCase):
    """llm.ask: история/контекст/ответ, изоляция чатов, сбои, нет ключа."""

    def setUp(self):
        super().setUp()
        self.sid = self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/rss.xml", "Valid")
        self.db.insert_item(self.conn(), self.sid, "http://ex.test/1", "Золото растёт",
                            "2026-09-13T00:00:00Z")

    def test_ask_happy_path(self):
        from bot import llm

        # ask сам пишет историю: user-вопрос до вызова, assistant-ответ после
        text = llm.ask(self.conn(), self.CHAT, "Что по золоту?")
        self.assertEqual(text, self.ANSWER)
        (messages, context), = self.calls
        self.assertEqual(messages[-1], {"role": "user", "content": "Что по золоту?"})
        self.assertIn("Золото растёт", context)
        self.assertIn("http://ex.test/1", context)
        rows = self.conn().execute(
            "SELECT role, text FROM chat_history WHERE chat_id=%s ORDER BY id",
            (self.CHAT,),
        ).fetchall()
        self.assertEqual([r["role"] for r in rows], ["user", "assistant"])
        self.assertEqual(rows[1]["text"], self.ANSWER)

    def test_history_window_last_12(self):
        from bot import llm

        for i in range(15):
            self.db.add_chat_message(self.conn(), self.CHAT, "user", f"msg{i}")
        for i in range(3):  # чужой чат не подмешивается (D27: chat_id)
            self.db.add_chat_message(self.conn(), 777, "user", f"other{i}")
        llm.ask(self.conn(), self.CHAT, "вопрос")
        messages = self.calls[-1][0]
        self.assertEqual(len(messages), 12)  # msg4..msg14 + вопрос
        self.assertEqual(messages[0]["content"], "msg4")
        self.assertTrue(all("other" not in m["content"] for m in messages))

    def test_context_isolated_per_chat(self):
        from bot import llm

        other = self.db.add_source(self.conn(), 777, "rss", f"{BASE}/rss.xml", "Other")
        self.db.insert_item(self.conn(), other, "http://ex.test/9", "Чужой источник",
                            "2026-09-13T00:00:00Z")
        llm.ask(self.conn(), self.CHAT, "вопрос")
        context = self.calls[-1][1]
        self.assertIn("Золото растёт", context)
        self.assertNotIn("Чужой источник", context)

    def test_llm_error_no_assistant_row(self):
        from bot import llm

        def boom(messages, context):
            raise RuntimeError("сеть недоступна")

        llm.chat = boom
        text = llm.ask(self.conn(), self.CHAT, "вопрос")
        self.assertIn("LLM недоступен", text)
        self.assertIn("сеть недоступна", text)
        roles = [r["role"] for r in self.conn().execute(
            "SELECT role FROM chat_history WHERE chat_id=%s", (self.CHAT,)).fetchall()]
        self.assertEqual(roles, ["user"])  # сбой не пишется в историю

    def test_empty_answer_no_assistant_row(self):
        from bot import llm

        llm.chat = lambda messages, context: "   "
        text = llm.ask(self.conn(), self.CHAT, "вопрос")
        self.assertIn("пустой ответ", text)
        roles = [r["role"] for r in self.conn().execute(
            "SELECT role FROM chat_history WHERE chat_id=%s", (self.CHAT,)).fetchall()]
        self.assertEqual(roles, ["user"])

    def test_no_key_no_api_call_no_history(self):
        from bot import llm
        from pipeline import config as pconfig

        pconfig.LLM_API_KEY = ""
        text = llm.ask(self.conn(), self.CHAT, "вопрос")
        self.assertIn("LLM_API_KEY", text)
        self.assertEqual(self.calls, [])  # в API не ходим
        self.assertEqual(self.conn().execute(
            "SELECT COUNT(*) FROM chat_history WHERE chat_id=%s", (self.CHAT,)).fetchone()[0], 0)


class TestDialogHandler(DialogCase):
    """Хендлер: свободный текст → диалог; команды и FSM-состояния — мимо."""

    def test_plain_text_goes_to_dialog(self):
        self.db.add_source(self.conn(), self.CHAT, "rss", f"{BASE}/rss.xml", "Valid")
        self.db.insert_item(self.conn(), 1, "http://ex.test/1", "Золото растёт", None)
        out = self.stdout_of(lambda: self.send("Что по золоту?"))
        self.assertIn("Ответ ассистента", out)
        self.assertEqual(len(self.calls), 1)

    def test_commands_do_not_reach_dialog(self):
        self.send("/unknowncmd")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.bot.sent_texts(), [])

    def test_fsm_state_text_not_dialog(self):
        self.send("/start")  # Survey.topics
        self.send("привет")  # посторонний текст в опросе — подсказка шага
        self.assertEqual(self.calls, [])
        self.assertIn("тем", " ".join(self.bot.sent_texts() + self.bot.edited_texts()))


# --- TC-41 (e2e): онбординг → свой RSS → плановая сводка (FR-10, FR-11, FR-13) ---

class TC41HappyPath(ChatCase):
    def test_onboarding_own_rss_scheduled_digest(self):
        from aiogram.fsm.storage.base import StorageKey
        from bot import db, scheduler

        scheduler._state.clear()
        scheduler._retry.clear()
        conn = self.conn()
        key = StorageKey(bot_id=self.bot.id, chat_id=self.CHAT, user_id=self.USER)

        # 1. онбординг (как TC-38): тема → исключить весь каталог → 1 раз/день → время
        self.send("/start")
        self.press("t:metals_fx")
        self.press("t:next")
        data = asyncio.run(self.dp.storage.get_data(key))
        pool = data["pool"]
        for i in range(len(pool)):
            self.press(f"s:{i}")
        self.press("s:next")
        self.press("f:1")
        self.press("m:09:00")
        self.press("m:next")
        self.press("c:save")
        self.assertIsNotNone(conn.execute(
            "SELECT onboarded_at FROM users WHERE chat_id=%s", (self.CHAT,)).fetchone()[0])
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM sources WHERE chat_id=%s", (self.CHAT,)).fetchone()[0], 0)

        # 2. свой источник через мастер (валидный RSS с fixture)
        self.press("add:start")
        self.press("a:k:rss")
        self.send(f"{BASE}/rss.xml")
        self.press("a:confirm")
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM sources WHERE chat_id=%s AND origin='manual'",
            (self.CHAT,)).fetchone()[0], 1)

        # 3. плановая сводка: слот через ~70 с (prep успевает по D25)
        slot = datetime.now() + timedelta(seconds=70)
        db.set_send_times(conn, self.CHAT, [slot.strftime("%H:%M")])
        deadline = time.time() + 180
        out = ""
        while time.time() < deadline:
            out += self.stdout_of(lambda: asyncio.run(scheduler.slots_once(conn)))
            if conn.execute("SELECT COUNT(*) FROM digests WHERE chat_id=%s",
                            (self.CHAT,)).fetchone()[0]:
                break
            time.sleep(5)

        self.assertIn("Первая новость", out)  # элементы своего RSS в сводке
        digest_row = conn.execute(
            "SELECT id, item_count FROM digests WHERE chat_id=%s", (self.CHAT,)).fetchone()
        self.assertEqual(digest_row["item_count"], 3)
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM digest_items WHERE digest_id=%s",
            (digest_row["id"],)).fetchone()[0], 3)
        self.assertIsNotNone(conn.execute(
            "SELECT last_sent_at FROM users WHERE chat_id=%s", (self.CHAT,)).fetchone()[0])
        # повторный тик без доставки — дублей нет (FR-12)
        self.stdout_of(lambda: asyncio.run(scheduler.slots_once(conn)))
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM digests WHERE chat_id=%s", (self.CHAT,)).fetchone()[0], 1)


# --- TC-45 (e2e): логи прогона и журнал (NFR-06) ---------------------------------

class TC45Logging(unittest.TestCase):
    def test_logs_and_journal(self):
        # NFR-06 самодостаточно (критерий М1 «свежий клон»): боевой mock-прогон
        # с недоступным фидом сам пишет ошибку источника с URL в logs/run.log
        env = dict(
            os.environ,
            TELEGRAM_TOKEN="",
            TELEGRAM_TOKEN_DEV="",
            TELEGRAM_CHAT_ID="",
            LLM_API_KEY="",
            BOT_FEED_URL="http://127.0.0.1:1/rss",
            BOT_DB_PATH="/tmp/iter7_tc45_bot.db",
        )
        if os.path.exists(env["BOT_DB_PATH"]):
            os.unlink(env["BOT_DB_PATH"])
        proc = subprocess.run([sys.executable, "-m", "bot"], capture_output=True,
                              text=True, env=env, cwd=ROOT, timeout=120)
        self.assertIn("Источник недоступен", proc.stdout)  # ветка FAIL в run_mock
        run_log = ROOT / "logs" / "run.log"
        self.assertTrue(run_log.exists())
        content = run_log.read_text(errors="replace")
        self.assertIn("FAIL", content)  # ошибки источников с URL (NFR-02, TC-21)
        self.assertIn("http://127.0.0.1:1/rss", content)
        log_md = ROOT / "LOG.md"
        if log_md.exists():  # публичный снапшот журнала не содержит — проверка локальная
            self.assertIn("Итерация 7", log_md.read_text())


if __name__ == "__main__":
    unittest.main()
