"""М4: webhook Telegram — FSM на БД (bot/pgstorage.py), build_dispatcher(),
эндпоинт /api/telegram (secret + дедуп update_id), LLM chat timeout 240 с.
БД — fresh ':memory:' (в PG-режиме — временная схема), инжектируется через
api.telegram._set_resources; feed_update мокается."""
import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# discover грузит test_iter10 раньше test_iter2 — порог должен быть в env
# до первого импорта bot.scheduler (см. test_iter2, TC-10)
os.environ.setdefault("BOT_FSM_TIMEOUT", "1")

from starlette.testclient import TestClient  # noqa: E402
from aiogram import Bot  # noqa: E402

from api import index as api_index  # noqa: E402
from api import telegram as api_telegram  # noqa: E402
from bot import db  # noqa: E402
from bot import config as bconfig  # noqa: E402
from bot.handlers import build_dispatcher  # noqa: E402
from bot.pgstorage import PgStorage  # noqa: E402
from aiogram.fsm.storage.base import StorageKey  # noqa: E402
from aiogram.fsm.storage.memory import MemoryStorage  # noqa: E402

SECRET = "s3cret"
BOT_ID, CHAT, USER = 42, 77, 5


def make_key(chat=CHAT, user=USER, bot_id=BOT_ID):
    return StorageKey(bot_id=bot_id, chat_id=chat, user_id=user)


CONN = db.connect(":memory:")
client = TestClient(api_index.app)


def post_webhook(update, secret=SECRET):
    headers = {"X-Telegram-Bot-Api-Secret-Token": secret} if secret is not None else {}
    return client.post("/api/telegram", json=update, headers=headers)


class WebhookBase(unittest.TestCase):
    def setUp(self):
        for t in ("processed_updates", "fsm", "sources", "items",
                  "digest_items", "digests", "chat_history"):
            CONN.execute(f"DELETE FROM {t}")
        CONN.commit()
        self.dp = mock.MagicMock()
        self.dp.feed_update = mock.AsyncMock()
        api_telegram._set_resources(conn=CONN, bot=object(), dp=self.dp)
        patcher = mock.patch.object(bconfig, "TELEGRAM_WEBHOOK_SECRET", SECRET)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        api_telegram._set_resources(conn=None, bot=None, dp=None)

    @staticmethod
    def update(update_id=1, text="/start"):
        return {"update_id": update_id,
                "message": {"message_id": update_id, "text": text,
                            "chat": {"id": CHAT}, "from": {"id": USER}}}


class TestWebhookAuth(WebhookBase):
    def test_no_secret_configured_rejects(self):
        with mock.patch.object(bconfig, "TELEGRAM_WEBHOOK_SECRET", ""):
            r = post_webhook(self.update())
        self.assertEqual(r.status_code, 401)

    def test_wrong_secret_rejects(self):
        r = post_webhook(self.update(), secret="wrong-secret")
        self.assertEqual(r.status_code, 401)
        self.dp.feed_update.assert_not_called()

    def test_missing_header_rejects(self):
        r = client.post("/api/telegram", json=self.update())
        self.assertEqual(r.status_code, 401)
        self.dp.feed_update.assert_not_called()

    def test_bad_body_rejected(self):
        self.assertEqual(client.post(
            "/api/telegram", content="не-json",
            headers={"X-Telegram-Bot-Api-Secret-Token": SECRET}).status_code, 400)
        self.assertEqual(post_webhook({"no_update_id": 1}).status_code, 400)
        self.assertEqual(post_webhook(["список"]).status_code, 400)


class TestWebhookDedup(WebhookBase):
    def test_first_update_processed(self):
        r = post_webhook(self.update(1))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True})
        self.dp.feed_update.assert_awaited_once()

    def test_duplicate_not_processed(self):
        self.assertEqual(post_webhook(self.update(7)).status_code, 200)
        r = post_webhook(self.update(7))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["duplicate"])
        self.dp.feed_update.assert_awaited_once()  # только первая доставка

    def test_seen_marks_table(self):
        self.assertTrue(db.mark_update_seen(CONN, 10))
        self.assertFalse(db.mark_update_seen(CONN, 10))
        self.assertTrue(db.mark_update_seen(CONN, 11))

    def test_cleanup_drops_old_only(self):
        db.mark_update_seen(CONN, 1)
        CONN.execute("UPDATE processed_updates SET at=%s WHERE update_id=1",
                     ("2020-01-01T00:00:00Z",))
        db.cleanup_processed_updates(CONN)
        left = CONN.execute("SELECT COUNT(*) FROM processed_updates").fetchone()[0]
        self.assertEqual(left, 0)
        db.mark_update_seen(CONN, 2)
        db.cleanup_processed_updates(CONN)  # свежая запись жива
        left = CONN.execute("SELECT COUNT(*) FROM processed_updates").fetchone()[0]
        self.assertEqual(left, 1)

    def test_processing_error_is_500(self):
        self.dp.feed_update = mock.AsyncMock(side_effect=RuntimeError("бум"))
        r = post_webhook(self.update(3))
        self.assertEqual(r.status_code, 500)
        # упавший апдейт уже помечен — повторная доставка не задвоит ответ
        self.dp.feed_update = mock.AsyncMock(side_effect=RuntimeError("бум"))
        r = post_webhook(self.update(3))
        self.assertEqual(r.json()["duplicate"], True)
        self.dp.feed_update.assert_not_awaited()


class TestDispatcher(unittest.TestCase):
    def test_singleton_default_memory_storage(self):
        dp = build_dispatcher()
        self.assertIs(dp, build_dispatcher())  # роутеры нельзя переподключать
        self.assertIsInstance(dp.storage, MemoryStorage)

    def test_router_order(self):
        dp = build_dispatcher()
        self.assertEqual(len(dp.sub_routers), 4)  # onboarding, sources, settings, menu

    def test_resources_lazy_wiring(self):
        # прод-сборка webhook: ленивые conn+Bot+dp, handlers.init(conn);
        # build_dispatcher и db.connect мокаем: синглтон диспетчера не трогаем
        # (его storage собирается первым вызвавшим — в Vercel это PgStorage),
        # а тест не должен открывать продовой коннект Supabase
        fake_dp, fake_conn = object(), object()
        with mock.patch.object(bconfig, "TOKEN", "1:TEST"), \
             mock.patch.object(api_telegram, "_conn", None), \
             mock.patch.object(api_telegram, "_bot", None), \
             mock.patch.object(api_telegram, "_dp", None), \
             mock.patch.object(api_telegram, "build_dispatcher",
                               return_value=fake_dp) as build, \
             mock.patch.object(api_telegram.db, "connect", return_value=fake_conn), \
             mock.patch("bot.handlers.init") as init:
            conn, bot, dp = api_telegram._resources()
        build.assert_called_once()
        self.assertIsInstance(build.call_args.args[0], PgStorage)
        init.assert_called_once_with(fake_conn)
        self.assertIs(conn, fake_conn)
        self.assertIs(dp, fake_dp)
        self.assertIsInstance(bot, Bot)


class TestPgStorage(unittest.TestCase):
    def setUp(self):
        CONN.execute("DELETE FROM fsm")
        CONN.commit()
        self.storage = PgStorage(CONN)

    def test_state_roundtrip(self):
        key = make_key()
        asyncio.run(self.storage.set_state(key, "Survey:topics"))
        self.assertEqual(asyncio.run(self.storage.get_state(key)), "Survey:topics")
        asyncio.run(self.storage.set_state(key, None))
        self.assertIsNone(asyncio.run(self.storage.get_state(key)))

    def test_state_does_not_clobber_data(self):
        key = make_key()
        asyncio.run(self.storage.set_data(key, {"a": 1}))
        asyncio.run(self.storage.set_state(key, "Survey:freq"))
        self.assertEqual(asyncio.run(self.storage.get_data(key)), {"a": 1})

    def test_data_roundtrip_and_keys_isolated(self):
        k1, k2 = make_key(), make_key(chat=99)
        asyncio.run(self.storage.set_data(k1, {"a": 1, "b": [1, 2]}))
        asyncio.run(self.storage.set_data(k2, {"c": 3}))
        self.assertEqual(asyncio.run(self.storage.get_data(k1)), {"a": 1, "b": [1, 2]})
        self.assertEqual(asyncio.run(self.storage.get_data(k2)), {"c": 3})

    def test_get_data_empty_is_dict(self):
        self.assertEqual(asyncio.run(self.storage.get_data(make_key())), {})

    def test_update_data_merges(self):
        key = make_key()
        asyncio.run(self.storage.set_data(key, {"a": 1}))
        merged = asyncio.run(self.storage.update_data(key, {"b": 2}))
        self.assertEqual(merged, {"a": 1, "b": 2})
        self.assertEqual(asyncio.run(self.storage.get_data(key)), {"a": 1, "b": 2})

    def test_reset_state_clears(self):
        key = make_key()
        asyncio.run(self.storage.set_state(key, "Survey:topics"))
        asyncio.run(self.storage.set_data(key, {"x": 1}))
        asyncio.run(self.storage.reset_state(key))
        self.assertIsNone(asyncio.run(self.storage.get_state(key)))
        self.assertEqual(asyncio.run(self.storage.get_data(key)), {})

    def test_updated_at_refreshed_on_touch(self):
        key = make_key()
        asyncio.run(self.storage.set_state(key, "s"))
        first = CONN.execute("SELECT updated_at FROM fsm WHERE key=%s",
                             (f"{BOT_ID}:{CHAT}:{USER}:{None}",)).fetchone()[0]
        CONN.execute("UPDATE fsm SET updated_at=%s WHERE key=%s",
                     ("2020-01-01T00:00:00Z", f"{BOT_ID}:{CHAT}:{USER}:{None}"))
        asyncio.run(self.storage.set_data(key, {"t": 1}))
        second = CONN.execute("SELECT updated_at FROM fsm WHERE key=%s",
                              (f"{BOT_ID}:{CHAT}:{USER}:{None}",)).fetchone()[0]
        self.assertNotEqual(second, "2020-01-01T00:00:00Z")  # касание обновило


class TestChatTimeout(unittest.TestCase):
    def test_chat_read_timeout_240(self):
        from pipeline import llm
        self.assertEqual(llm.CHAT_READ_TIMEOUT, 240.0)

    def test_chat_uses_constant(self):
        from pipeline import llm
        with mock.patch.object(llm, "_call", return_value="ok") as call:
            self.assertEqual(llm.chat([{"role": "user", "content": "привет"}], "контекст"), "ok")
        call.assert_called_once()
        self.assertEqual(call.call_args.kwargs["read_timeout"], llm.CHAT_READ_TIMEOUT)


if __name__ == "__main__":
    unittest.main()
