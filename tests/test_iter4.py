"""Итерация 4: TC-07 (окно дельты), TC-09 (слоты/catch-up), TC-24 (/settings
и слот ±1 мин), TC-25 (невалидное время), TC-26 (без новых), TC-27 (пустой
период), TC-28 (догоняющая сводка) — tests/TESTPLAN.md (+правки сверки D18/D26)."""
import asyncio
import io
import sys
import threading
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
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
    def do_GET(self):
        body = {"/valid.xml": VALID_XML, "/valid2.xml": VALID2_XML}.get(
            self.path, b"nope"
        )
        self.send_response(200 if body != b"nope" else 404)
        self.send_header("Content-Type", "application/rss+xml")
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
    from bot import config
    from pipeline import config as pconfig
    # с И5 build_delta зовёт LLM: ключ из .env обнуляем — сводки в тестах = mock
    _SAVED_CONFIG = (config.TOKEN, config.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY)
    config.TOKEN = ""  # отправка — mock-вывод в stdout (NFR-05)
    config.ALLOWED_CHAT_ID = ""
    pconfig.LLM_API_KEY = ""


def tearDownModule():
    SERVER.shutdown()
    SERVER.server_close()
    from bot import config
    from pipeline import config as pconfig
    config.TOKEN, config.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY = _SAVED_CONFIG


# --- TC-07 (unit): окно дельты — потребление digest_items (D26) -----------------

class TC07DeltaWindow(unittest.TestCase):
    def test_consumption_window(self):
        from bot import db, digest

        conn = db.connect(":memory:")
        db.finalize_survey(
            conn, 42,
            [{"url": f"{BASE}/valid.xml", "title": "Valid Feed", "topics": []}],
            ["09:00"], "replace",
        )
        sid = conn.execute("SELECT id FROM sources WHERE chat_id=42").fetchone()[0]
        db.insert_item(conn, sid, "http://ex.test/old", "Старая до окна", "2026-09-01T00:00:00Z")
        db.insert_item(conn, sid, "http://ex.test/new", "В окне", "2026-09-12T00:00:00Z")
        # «будущая» дата и элемент без даты: published не фильтрует окно (D26),
        # элемент без даты оценивается по fetched_at-семантике (fallback)
        db.insert_item(conn, sid, "http://ex.test/future", "Будущая дата", "2030-01-01T00:00:00Z")
        db.insert_item(conn, sid, "http://ex.test/nodate", "Без даты", None)

        # первая сводка (last_sent_at NULL): все непотреблённые, свежие первыми
        # (2030-«будущая» свежее всего — published только сортирует, D26)
        rows = db.pending_items(conn, 42)
        self.assertEqual([r["url"] for r in rows],
                         ["http://ex.test/future", "http://ex.test/nodate",
                          "http://ex.test/new", "http://ex.test/old"])
        text, ids = digest.build_delta(conn, 42)
        self.assertIsNotNone(text)
        self.assertEqual(len(ids), 4)
        digest_id = db.record_digest(conn, 42, text, ids)
        self.assertTrue(digest_id)
        self.assertIsNotNone(
            conn.execute("SELECT last_sent_at FROM users WHERE chat_id=42").fetchone()[0]
        )
        # digest_items связал все элементы со сводкой
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM digest_items WHERE digest_id=%s",
                         (digest_id,)).fetchone()[0], 4
        )

        # после потребления: новых нет — дельта пуста
        self.assertEqual(db.pending_items(conn, 42), [])
        self.assertEqual(digest.build_delta(conn, 42), (None, []))

        # «старые пункты не повторяются»: новый элемент → в дельте только он
        db.insert_item(conn, sid, "http://ex.test/fresh", "Свежая", "2026-09-13T00:00:00Z")
        rows = db.pending_items(conn, 42)
        self.assertEqual([r["url"] for r in rows], ["http://ex.test/fresh"])

        # периоды зафиксированы: первая сводка — окно 24 ч (D9)
        row = conn.execute("SELECT period_from, period_to FROM digests").fetchone()
        self.assertLess(
            datetime.fromisoformat(row["period_to"].replace("Z", "+00:00"))
            - datetime.fromisoformat(row["period_from"].replace("Z", "+00:00")),
            timedelta(hours=25),
        )


# --- TC-09 (unit): расчёт слотов и условие catch-up ------------------------------

class TC09Slots(unittest.TestCase):
    """Слоты в локальном времени Mac (D18-сужение); tz_offset_min — с FR-18 (И9)."""

    TIMES = ["09:00", "21:00"]

    def at(self, *args):
        return datetime(2026, 9, 13, *args).astimezone()

    def test_next_slot(self):
        from bot.scheduler import next_slot, parse_times

        self.assertEqual(parse_times('["21:00","09:00"]'), ["09:00", "21:00"])  # сортировка
        self.assertEqual(parse_times('["9:00","25:00","xx",null]'), [])  # мусор отфильтрован
        self.assertEqual(parse_times(None), [])
        self.assertEqual(next_slot(self.at(8, 0), self.TIMES), self.at(9, 0))
        self.assertEqual(next_slot(self.at(9, 0, 0), self.TIMES), self.at(21, 0))  # строго после
        self.assertEqual(next_slot(self.at(9, 30), self.TIMES), self.at(21, 0))
        self.assertEqual(next_slot(self.at(22, 0), self.TIMES),
                         datetime(2026, 9, 14, 9, 0).astimezone())  # через полночь
        self.assertEqual(next_slot(self.at(23, 0), ["23:59"]), self.at(23, 59))

    def test_is_due(self):
        from bot.scheduler import is_due

        yesterday_evening = datetime(2026, 9, 12, 21, 0).astimezone()
        self.assertTrue(is_due(self.at(10, 0), self.TIMES, yesterday_evening))  # catch-up нужен
        self.assertFalse(is_due(self.at(8, 0), self.TIMES, yesterday_evening))  # слот будущий
        self.assertFalse(is_due(self.at(9, 30), self.TIMES, self.at(9, 0)))  # уже отправлено
        self.assertFalse(is_due(self.at(23, 0), self.TIMES, None))  # первая сводка ждёт слота


# --- инфраструктура интеграционных кейсов (общая: tests/fakes.py) ----------------

from aiogram.types import Update  # noqa: E402
from fakes import FakeBot, make_callback, make_message, shared_dispatcher  # noqa: E402


class ChatCase(unittest.TestCase):
    CHAT = 5252
    USER = 7

    def setUp(self):
        from aiogram.fsm.storage.base import StorageKey
        from bot import db, handlers
        from bot import scheduler
        from bot.handlers import onboarding

        handlers.init(db.connect(":memory:"))
        self.db = db
        self.scheduler = scheduler
        scheduler._state.clear()
        scheduler._retry.clear()
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

    def conn(self):
        from bot.handlers import onboarding
        return onboarding.conn

    def slots_out(self, now):
        buf = io.StringIO()
        with redirect_stdout(buf):
            sent = asyncio.run(self.scheduler.slots_once(self.conn(), now))
        return buf.getvalue(), sent

    def onboard(self, urls=None, times=("09:00",)):
        urls = urls or [f"{BASE}/valid.xml"]
        self.db.finalize_survey(
            self.conn(), self.CHAT,
            [{"url": u, "title": f"Feed {i}", "topics": []} for i, u in enumerate(urls)],
            list(times), "replace",
        )

    def backdate_last_sent(self, hours):
        old = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        self.conn().execute(
            "UPDATE users SET last_sent_at=%s WHERE chat_id=%s", (old, self.CHAT)
        )
        self.conn().commit()

    def digests_count(self):
        return self.conn().execute(
            "SELECT COUNT(*) FROM digests WHERE chat_id=%s", (self.CHAT,)
        ).fetchone()[0]


# --- TC-24: /settings смена времени, слот ±1 мин, транзакция --------------------

class TC24SettingsSlot(ChatCase):
    def test_settings_and_slot(self):
        now = datetime.now().astimezone()
        slot = (now + timedelta(minutes=2)).replace(second=0, microsecond=0)
        if slot.date() != now.date():
            self.skipTest("граница суток — слот ушёл бы на завтра")
        slot_str = slot.strftime("%H:%M")
        self.onboard(times=("09:00",))

        # /settings → невалидный ввод не принимается, валидное время — да (TC-25 тут же)
        self.send("/settings")
        self.assertIn("Расписание сводок", self.bot.sent_texts()[-1])
        self.send("25:00")
        self.assertIn("Не поняла время", self.bot.sent_texts()[-1])
        self.send(slot_str)
        self.assertIn(slot_str, self.bot.sent_texts()[-1])
        self.press("m:next")
        self.assertIn("Расписание обновлено", self.bot.edited_texts()[-1])
        times = self.conn().execute(
            "SELECT send_times FROM users WHERE chat_id=%s", (self.CHAT,)
        ).fetchone()[0]
        self.assertIn(slot_str, times)  # БД обновлена (FR-10)

        # до слота: подготовка (сбор), без отправки
        out, sent = self.slots_out(slot - timedelta(seconds=90))
        self.assertEqual(sent, [])
        self.assertEqual(self.digests_count(), 0)
        # за 30 с до слота: подготовленное не отправляется (точность ±1 мин)
        out, sent = self.slots_out(slot - timedelta(seconds=30))
        self.assertEqual(sent, [])
        self.assertEqual(self.digests_count(), 0)
        # слот (+30 с): отправка одной записью — digests + digest_items + last_sent_at
        out, sent = self.slots_out(slot + timedelta(seconds=30))
        self.assertEqual(sent, [self.CHAT])
        self.assertIn("Первая новость", out)  # элементы собраны в фазе подготовки
        self.assertEqual(self.digests_count(), 1)
        self.assertEqual(
            self.conn().execute(
                "SELECT COUNT(*) FROM digest_items di JOIN digests d ON d.id=di.digest_id"
                " WHERE d.chat_id=%s", (self.CHAT,)
            ).fetchone()[0], 3
        )
        # повторный тик на том же слоте — дублей нет (одна транзакция, одна запись)
        out, sent = self.slots_out(slot + timedelta(seconds=40))
        self.assertEqual(sent, [])
        self.assertEqual(self.digests_count(), 1)


# --- TC-25: невалидное время/частота ----------------------------------------------

class TC25InvalidTime(ChatCase):
    def test_settings_invalid(self):
        self.onboard()
        self.send("/settings")
        for bad in ("25:00", "9:99", "abc"):
            self.send(bad)
            self.assertIn("Не поняла время", self.bot.sent_texts()[-1])
        # пустой выбор → сохранение не проходит, состояние живёт
        self.press("m:next")
        self.assertTrue(any(t == "AnswerCallbackQuery" and v.get("show_alert")
                            for t, v in self.bot.calls))
        self.send("09:30")  # валидное принято тем же состоянием
        self.assertIn("09:30", self.bot.sent_texts()[-1])
        self.press("m:next")
        self.assertIn("Расписание обновлено", self.bot.edited_texts()[-1])

    def test_freq_text_instead_of_button(self):
        """Шаг частоты онбординга: текст вместо кнопки — подсказка, FSM цел."""
        self.send("/start")  # чат не onboarded → опрос
        self.assertIn("Какие темы", self.bot.sent_texts()[-1])
        self.press("t:next")  # темы → источники (дефолт)
        self.press("s:next")  # источники → частота
        self.send("два раза в день")
        self.assertIn("Сейчас идёт опрос", self.bot.sent_texts()[-1])
        self.press("f:1")  # состояние частоты живо — кнопка принята
        self.assertIn("Во сколько", self.bot.edited_texts()[-1])


# --- TC-26: источник без новых новостей -------------------------------------------

class TC26NoNewItems(ChatCase):
    def test_only_new_in_digest(self):
        self.onboard(urls=[f"{BASE}/valid.xml", f"{BASE}/valid2.xml"])
        self.backdate_last_sent(30)
        now = datetime.now().astimezone() + timedelta(hours=2)
        now = now.replace(second=0, microsecond=0)
        out, sent = self.slots_out(now)  # catch-up: сводка 1 — сбор принёс A(3) + B(2)
        self.assertEqual(sent, [self.CHAT])
        self.assertIn("Первая новость", out)
        self.assertIn("Другая новость", out)
        self.assertEqual(self.digests_count(), 1)
        items_before = self.conn().execute("SELECT COUNT(*) FROM items").fetchone()[0]

        # A не отдаёт нового (тот же фид); B принёс один новый элемент
        sid_b = self.conn().execute(
            "SELECT id FROM sources WHERE chat_id=%s AND url=%s", (self.CHAT, f"{BASE}/valid2.xml")
        ).fetchone()[0]
        self.db.insert_item(self.conn(), sid_b, "http://it.test/2/new", "Новая от B",
                            "2026-09-13T10:00:00Z")
        self.backdate_last_sent(30)
        out, sent = self.slots_out(now + timedelta(minutes=3))
        self.assertEqual(sent, [self.CHAT])
        self.assertIn("Новая от B", out)
        self.assertNotIn("Первая новость", out)  # старые пункты A/B не повторяются
        self.assertNotIn("Другая новость", out)
        row = self.conn().execute(
            "SELECT item_count FROM digests WHERE chat_id=%s ORDER BY id DESC LIMIT 1",
            (self.CHAT,),
        ).fetchone()
        self.assertEqual(row[0], 1)
        # повторный сбор тех же фидов не растит items (NFR-03)
        items_after = self.conn().execute("SELECT COUNT(*) FROM items").fetchone()[0]
        self.assertEqual(items_after, items_before + 1)  # +1 вставленный вручную


# --- TC-27: полностью пустой период -------------------------------------------------

class TC27EmptyPeriod(ChatCase):
    def test_empty_digest(self):
        from bot.digest import EMPTY_TEXT

        self.onboard()
        self.backdate_last_sent(30)
        now = datetime.now().astimezone() + timedelta(hours=2)
        now = now.replace(second=0, microsecond=0)
        self.slots_out(now)  # сводка 1: всё потреблено

        self.backdate_last_sent(30)
        out, sent = self.slots_out(now + timedelta(minutes=3))  # новых нет
        self.assertEqual(sent, [self.CHAT])
        self.assertEqual(out.count(EMPTY_TEXT), 1)  # ровно одно короткое сообщение (D7)
        self.assertNotIn("Первая новость", out)  # дублей старых пунктов нет
        self.assertNotIn("MOCK", out)  # и нет «пустой» mock-сводки без пунктов
        row = self.conn().execute(
            "SELECT item_count, last_sent_at FROM digests d"
            " JOIN users u ON u.chat_id=d.chat_id WHERE u.chat_id=%s"
            " ORDER BY d.id DESC LIMIT 1", (self.CHAT,)
        ).fetchone()
        self.assertEqual(row["item_count"], 0)
        self.assertIsNotNone(row["last_sent_at"])  # окно сдвинуто — слот не повторится


# --- TC-28: догоняющая сводка после пропуска слотов ----------------------------------

class TC28CatchUp(ChatCase):
    def test_one_digest_after_gap(self):
        self.onboard(urls=[f"{BASE}/valid.xml", f"{BASE}/valid2.xml"], times=("09:00", "21:00"))
        self.backdate_last_sent(36)  # пропущено 2+ слота
        now = datetime.now().astimezone()
        upcoming = self.scheduler.next_slot(now, ["09:00", "21:00"])
        probe = upcoming - timedelta(hours=2)  # далеко от границ слота
        out, sent = self.slots_out(probe)
        self.assertEqual(sent, [self.CHAT])  # ОДНА сводка за всё окно
        self.assertEqual(out.count("Первая новость"), 1)
        self.assertEqual(self.digests_count(), 1)
        last = self.conn().execute(
            "SELECT last_sent_at FROM users WHERE chat_id=%s", (self.CHAT,)
        ).fetchone()[0]
        # last_sent_at сдвинут ровно один раз (= моменту прогона)
        self.assertEqual(
            last, self.scheduler._iso_utc(probe)
        )
        # элементы прошлой сводки не повторяются; дублей нет
        self.assertEqual(
            self.conn().execute(
                "SELECT COUNT(*) FROM digest_items di JOIN digests d ON d.id=di.digest_id"
                " WHERE d.chat_id=%s", (self.CHAT,)
            ).fetchone()[0], 5
        )
        out, sent = self.slots_out(probe + timedelta(minutes=1))
        self.assertEqual(sent, [])
        self.assertEqual(self.digests_count(), 1)


if __name__ == "__main__":
    unittest.main()
