"""Итерация 2 → 11d: TC-01/TC-02 (каталог — fallback-пул, D45), TC-33
(финализация A/B), TC-10 (FSM-таймаут sweeper) — tests/TESTPLAN.md."""
import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("BOT_FSM_TIMEOUT", "1")  # порог таймаута для TC-10 (секунды)


class TC01CatalogFallback(unittest.TestCase):
    """11d/D45: каталог — fallback-пул целиком; темы/лимит подбора удалены."""

    def test_pick_returns_whole_catalog(self):
        from bot import catalog

        self.assertEqual(catalog.pick(["metals_fx"]), catalog.CATALOG)  # темы игнорируются
        self.assertEqual(catalog.pick([]), catalog.CATALOG)
        # порядок = порядок файла
        self.assertEqual([e["id"] for e in catalog.pick()],
                         [e["id"] for e in catalog.CATALOG])


class TC02CatalogEntries(unittest.TestCase):
    """Записи каталога пригодны для мультивыбора и финализации (kind обязателен)."""

    def test_entries_structure(self):
        from bot import catalog

        self.assertTrue(catalog.CATALOG)
        for entry in catalog.CATALOG:
            self.assertTrue(entry["title"] and entry["url"], entry)
            self.assertIn(entry["kind"], ("rss", "tgweb", "html"))
            self.assertIsInstance(entry.get("topics"), list)


class TC33FinalizeModes(unittest.TestCase):
    """Семантика финализации повторного опроса на уровне БД (сценарии 6.2/6.3)."""

    def setUp(self):
        from bot import catalog, db

        self.db = db
        self.conn = db.connect(":memory:")
        db.ensure_user(self.conn, 42)
        s1 = catalog.pick(["metals_fx"])
        db.finalize_survey(self.conn, 42, s1, ["09:00"], "replace")
        self.conn.execute(
            "INSERT INTO sources (chat_id, kind, url, title, origin, added_at)"
            " VALUES (42, 'rss', 'http://ex.test/my', 'Мой RSS', 'manual', '2026-01-01T00:00:00Z')"
        )
        self.conn.execute(
            "UPDATE users SET last_sent_at='2026-09-12T00:00:00Z' WHERE chat_id=42"
        )
        self.conn.commit()
        self.s1_urls = {e["url"] for e in s1}
        self.s2 = catalog.pick(["ipo_ai_bio"])
        self.s2_urls = {e["url"] for e in self.s2}

    def _urls(self, origin=None):
        sql = "SELECT url FROM sources WHERE chat_id=42"
        if origin:
            sql += f" AND origin='{origin}'"
        return {r[0] for r in self.conn.execute(sql)}

    def test_mode_a_replace(self):
        self.db.finalize_survey(self.conn, 42, self.s2, ["21:00"], "replace")
        urls = self._urls()
        self.assertEqual(urls, self.s2_urls | {"http://ex.test/my"})  # S1 удалены, manual жив
        last = self.conn.execute(
            "SELECT last_sent_at, send_times, onboarded_at FROM users WHERE chat_id=42"
        ).fetchone()
        self.assertEqual(last[0], "2026-09-12T00:00:00Z")  # окно не сброшено
        self.assertEqual(last[1], '["21:00"]')

    def test_mode_b_add(self):
        self.db.finalize_survey(self.conn, 42, self.s2, ["09:00", "21:00"], "add")
        urls = self._urls()
        self.assertEqual(urls, self.s1_urls | self.s2_urls | {"http://ex.test/my"})
        # повторное объединение с тем же набором — дублей не появляется
        self.db.finalize_survey(self.conn, 42, self.s2, ["09:00", "21:00"], "add")
        self.assertEqual(len(self._urls()), len(urls))
        last = self.conn.execute(
            "SELECT last_sent_at FROM users WHERE chat_id=42"
        ).fetchone()[0]
        self.assertEqual(last, "2026-09-12T00:00:00Z")


class TC10FsmTimeout(unittest.TestCase):
    """Таймаут неактивности: сообщение + сброс состояния + вывод из ACTIVE."""

    def test_sweep_expires_stale_session(self):
        import asyncio

        from aiogram.fsm.storage.base import StorageKey
        from aiogram.fsm.storage.memory import MemoryStorage

        from bot import scheduler
        from bot.handlers import onboarding
        from bot.states import Survey

        class FakeBot:
            id = 123

            def __init__(self):
                self.sent = []

            async def send_message(self, chat_id, text, **kwargs):
                self.sent.append((chat_id, text))

        async def scenario():
            bot = FakeBot()
            storage = MemoryStorage()
            key = StorageKey(bot_id=bot.id, chat_id=42, user_id=42)
            await storage.set_state(key, Survey.interview)
            await storage.set_data(key, {"history": []})
            onboarding.ACTIVE.clear()
            onboarding.ACTIVE[(42, 42)] = time.time() - 10  # давно

            fresh = (43, 43)
            onboarding.ACTIVE[fresh] = time.time()
            await storage.set_state(
                StorageKey(bot_id=bot.id, chat_id=43, user_id=43), Survey.time
            )

            expired = await scheduler.sweep_once(bot, storage)
            return bot.sent, expired, await storage.get_state(key), (43, 43) in onboarding.ACTIVE

        sent, expired, state, fresh_alive = asyncio.run(scenario())
        self.assertEqual(expired, 1)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], 42)
        self.assertIn("/start", sent[0][1])  # подсказка продолжения
        self.assertIsNone(state)  # состояние сброшено
        self.assertNotIn((42, 42), onboarding.ACTIVE)
        self.assertTrue(fresh_alive)  # активная сессия не тронута
        onboarding.ACTIVE.clear()


if __name__ == "__main__":
    unittest.main()
