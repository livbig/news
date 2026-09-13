"""Итерация 8: Mini App (FR-17, TC-43) — initData-авторизация (HMAC бот-токена),
JSON API CRUD источников и расписания, страница UI, fallback кнопки меню при
недоступном веб-пути. tests/TESTPLAN.md — TC-43 (автоматизируемая часть)."""
import hashlib
import hmac
import itertools
import json
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fakes.py

TOKEN = "12345:TESTTOKEN"


def sign_init_data(user_id, token=TOKEN, auth_date="1726200000"):
    """initData по алгоритму Telegram: строка url-encoded, но hash =
    HMAC(secret, data_check_string) по ДЕКОДИРОВАННЫМ парам без hash,
    отсортированным по ключу (пример из доков — распакованный user JSON)."""
    fields = {
        "auth_date": auth_date,
        "query_id": "AAFtest",
        "signature": "AAIBm3R0YXlrZWQ",
        "user": json.dumps({"id": user_id, "first_name": "Тест Юзер"},
                           separators=(",", ":"), ensure_ascii=False),
    }
    encoded = "&".join(f"{k}={urllib.parse.quote(v, safe='')}" for k, v in fields.items())
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(token.encode(), b"WebAppData", hashlib.sha256).digest()
    digest = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}&hash={digest}"


def req(path, init=None, body=None):
    """(статус, сырое тело); без авторизации и/или тела — тоже можно."""
    headers = {}
    if init:
        headers["Authorization"] = "tma " + init
    if body is not None:
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, exc.read()
        finally:
            exc.close()


def api(path, init=None, body=None):
    status, raw = req(path, init, body)
    return status, (json.loads(raw) if raw else None)


def setUpModule():
    global BASE, DB, _SAVED
    from bot import config as bconfig, db, handlers, webapp

    # ключи/чаты/публичный URL .env не утекают в тесты (NFR-05)
    _SAVED = (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, bconfig.WEBAPP_PUBLIC_URL)
    bconfig.TOKEN = TOKEN
    bconfig.ALLOWED_CHAT_ID = ""
    bconfig.WEBAPP_PUBLIC_URL = ""
    DB = db.connect(":memory:")
    handlers.init(DB)
    webapp.start(DB, port=0)
    BASE = webapp.URL
    assert BASE, "веб-сервер не поднялся"


def tearDownModule():
    from bot import config as bconfig, webapp

    webapp.stop()
    bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, bconfig.WEBAPP_PUBLIC_URL = _SAVED


_UID = itertools.count(1)


def seed(chat_id, count=2):
    """Пользователь chat_id и count rss-источников с уникальными URL;
    возвращает id источников."""
    from bot import db

    db.ensure_user(DB, chat_id)
    out = []
    for _ in range(count):
        out.append(db.add_source(DB, chat_id, "rss", f"http://ex.test/{next(_UID)}",
                                 f"Источник {next(_UID)}"))
    return out


# --- авторизация initData --------------------------------------------------------

class TestAuth(unittest.TestCase):
    CHAT = 77

    def setUp(self):
        seed(self.CHAT)

    def test_valid_init_data_ok(self):
        status, body = api("/api/sources", init=sign_init_data(self.CHAT))
        self.assertEqual(status, 200)
        self.assertEqual([s["id"] for s in body["sources"]],
                         [r[0] for r in DB.execute(
                             "SELECT id FROM sources WHERE chat_id=%s ORDER BY id",
                             (self.CHAT,)).fetchall()])

    def test_check_string_uses_decoded_values(self):
        # М3.2: Telegram подписывает DECODED-пары (доки: user={"id":...});
        # подпись по encoded-парам (старый баг) должна отвергаться
        from bot.webauth import verify_init_data
        user = verify_init_data(sign_init_data(self.CHAT), TOKEN)
        self.assertEqual(user["id"], self.CHAT)
        fields = {"auth_date": "1", "user": json.dumps(
            {"id": self.CHAT, "first_name": "Тест"}, separators=(",", ":"),
            ensure_ascii=False)}
        encoded = "&".join(f"{k}={urllib.parse.quote(v, safe='')}"
                           for k, v in fields.items())
        secret = hmac.new(TOKEN.encode(), b"WebAppData", hashlib.sha256).digest()
        buggy = hmac.new(secret, "\n".join(sorted(
            p for p in encoded.split("&"))).encode(), hashlib.sha256).hexdigest()
        self.assertIsNone(verify_init_data(f"{encoded}&hash={buggy}", TOKEN))

    def test_tampered_hash_rejected(self):
        init = sign_init_data(self.CHAT)
        bad = init[:-1] + ("0" if init[-1] != "0" else "1")
        self.assertEqual(api("/api/sources", init=bad)[0], 401)

    def test_hash_of_other_token_rejected(self):
        self.assertEqual(api("/api/sources",
                             init=sign_init_data(self.CHAT, token="9:OTHER"))[0], 401)

    def test_no_header_rejected(self):
        self.assertEqual(api("/api/sources")[0], 401)
        self.assertEqual(api("/api/sources", init="garbage-not-signed")[0], 401)

    def test_foreign_user_rejected_when_allowed_set(self):
        from bot import config as bconfig

        with mock.patch.object(bconfig, "ALLOWED_CHAT_ID", "99999"):
            self.assertEqual(api("/api/sources", init=sign_init_data(self.CHAT))[0], 401)
            self.assertEqual(api("/api/sources", init=sign_init_data(99999))[0], 200)

    def test_page_public_no_secrets(self):
        status, raw = req("/")
        self.assertEqual(status, 200)
        page = raw.decode()
        self.assertIn("Источники", page)
        self.assertNotIn(TOKEN, page)  # токен не утекает в разметку


# --- CRUD источников через API (единый bot.db) -----------------------------------

class TestSourcesApi(unittest.TestCase):
    CHAT, OTHER = 77, 888

    def setUp(self):
        self.ids = seed(self.CHAT)
        self.other_ids = seed(self.OTHER)

    def test_toggle_flips_enabled(self):
        status, body = api("/api/sources/toggle", init=sign_init_data(self.CHAT),
                           body={"id": self.ids[0]})
        self.assertEqual((status, body["ok"]), (200, True))
        self.assertEqual(DB.execute("SELECT enabled FROM sources WHERE id=%s",
                                    (self.ids[0],)).fetchone()[0], 0)
        # повтор — состояние стабильно (NFR-03)
        status, body = api("/api/sources/toggle", init=sign_init_data(self.CHAT),
                           body={"id": self.ids[0]})
        self.assertEqual((status, body["enabled"]), (200, True))
        self.assertEqual(DB.execute("SELECT enabled FROM sources WHERE id=%s",
                                    (self.ids[0],)).fetchone()[0], 1)

    def test_delete_removes_with_items(self):
        from bot import db

        db.insert_item(DB, self.ids[0], "http://ex.test/x/1", "Новость", None)
        status, body = api("/api/sources/delete", init=sign_init_data(self.CHAT),
                           body={"id": self.ids[0]})
        self.assertEqual((status, body["ok"]), (200, True))
        self.assertIsNone(DB.execute("SELECT id FROM sources WHERE id=%s",
                                     (self.ids[0],)).fetchone())
        self.assertEqual(DB.execute("SELECT COUNT(*) FROM items WHERE source_id=%s",
                                    (self.ids[0],)).fetchone()[0], 0)  # каскад (TC-23)

    def test_foreign_source_not_accessible(self):
        status, _ = api("/api/sources/toggle", init=sign_init_data(self.CHAT),
                        body={"id": self.other_ids[0]})
        self.assertEqual(status, 404)
        status, _ = api("/api/sources/delete", init=sign_init_data(self.CHAT),
                        body={"id": self.other_ids[0]})
        self.assertEqual(status, 404)
        self.assertIsNotNone(DB.execute("SELECT id FROM sources WHERE id=%s",
                                        (self.other_ids[0],)).fetchone())

    def test_unknown_id_and_bad_body(self):
        self.assertEqual(api("/api/sources/toggle", init=sign_init_data(self.CHAT),
                             body={"id": 999999})[0], 404)
        self.assertEqual(api("/api/sources/toggle", init=sign_init_data(self.CHAT),
                             body={"nope": 1})[0], 404)


# --- расписание через API ---------------------------------------------------------

class TestSettingsApi(unittest.TestCase):
    CHAT = 77

    def setUp(self):
        seed(self.CHAT, count=0)
        from bot import db

        db.set_send_times(DB, self.CHAT, ["09:00"])

    def test_get_and_post(self):
        self.assertEqual(api("/api/settings", init=sign_init_data(self.CHAT))[1],
                         {"times": ["09:00"]})
        status, body = api("/api/settings", init=sign_init_data(self.CHAT),
                           body={"times": ["21:00", "7:30"]})
        self.assertEqual(status, 200)
        self.assertEqual(body["times"], ["07:30", "21:00"])  # нормализация + сортировка
        self.assertEqual(api("/api/settings", init=sign_init_data(self.CHAT))[1],
                         {"times": ["07:30", "21:00"]})
        # повторная запись того же — идемпотентна (NFR-03)
        api("/api/settings", init=sign_init_data(self.CHAT), body={"times": ["21:00", "7:30"]})
        self.assertEqual(json.loads(DB.execute("SELECT send_times FROM users WHERE chat_id=%s",
                                               (self.CHAT,)).fetchone()[0]),
                         ["07:30", "21:00"])

    def test_invalid_values_rejected(self):
        before = DB.execute("SELECT send_times FROM users WHERE chat_id=%s",
                            (self.CHAT,)).fetchone()[0]
        for times in ([], ["09:00", "12:00", "15:00"], ["25:00"], ["9:99"], ["abc"], "09:00"):
            status, _ = api("/api/settings", init=sign_init_data(self.CHAT), body={"times": times})
            self.assertEqual(status, 400, times)
        self.assertEqual(DB.execute("SELECT send_times FROM users WHERE chat_id=%s",
                                    (self.CHAT,)).fetchone()[0], before)

    def test_unknown_chat_starts_empty(self):
        self.assertEqual(api("/api/settings", init=sign_init_data(4242)),
                         (200, {"times": []}))


# --- кнопка меню и fallback (TC-43, автоматизируемая часть) ------------------------

from aiogram.types import Update  # noqa: E402
from fakes import FakeBot, make_callback, shared_dispatcher  # noqa: E402


class TestMenuButton(unittest.TestCase):
    """menu:webapp: сервер поднят → кнопка web_app; остановлен → меню бота."""

    CHAT, USER = 6464, 9

    def setUp(self):
        import asyncio

        from aiogram.fsm.storage.base import StorageKey
        from bot import db, handlers, webapp
        from bot.handlers import onboarding

        handlers.init(db.connect(":memory:"))
        self.webapp = webapp
        self.dp = shared_dispatcher()
        self.bot = FakeBot()
        self._uid = 0
        key = StorageKey(bot_id=self.bot.id, chat_id=self.CHAT, user_id=self.USER)
        asyncio.run(self.dp.storage.set_state(key, None))
        asyncio.run(self.dp.storage.set_data(key, {}))
        onboarding.ACTIVE.clear()

    def press(self, data):
        import asyncio

        self._uid += 1
        cb = make_callback(self.CHAT, self.USER, data)
        asyncio.run(self.dp.feed_update(self.bot, Update(update_id=self._uid, callback_query=cb)))

    def test_button_when_running(self):
        self.press("menu:webapp")
        sends = [v for t, v in self.bot.calls if t == "SendMessage"]
        self.assertTrue(sends and "Веб-панель" in sends[0]["text"])
        btn = sends[0]["reply_markup"]["inline_keyboard"][0][0]
        self.assertEqual(btn["web_app"]["url"], self.webapp.URL)

    def test_fallback_when_stopped(self):
        with mock.patch.object(self.webapp, "running", lambda: False), \
                mock.patch.object(self.webapp, "URL", None):
            self.press("menu:webapp")  # без необработанных ошибок (TC-43)
        edits = [v["text"] for t, v in self.bot.calls if t == "EditMessageText"]
        self.assertEqual(edits, ["Главное меню."])
        kb = [v for t, v in self.bot.calls if t == "EditMessageText"][0]["reply_markup"]
        labels = [b["text"] for row in kb["inline_keyboard"] for b in row]
        self.assertIn("Источники", labels)  # fallback ведёт в бот-интерфейс
        self.assertEqual([v for t, v in self.bot.calls if t == "SendMessage"], [])


if __name__ == "__main__":
    unittest.main()
