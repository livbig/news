"""Итерация 8б (фидбек): Mini App с телефона (FR-17) — публичный https-URL
BOT_WEBAPP_PUBLIC_URL в web_app-кнопках и меню-кнопке бота (setChatMenuButton),
привязка сервера BOT_WEBAPP_BIND; не-https URL отклоняется. База — test_iter8
(sign_init_data и механика прогона И8 не менялись)."""
import asyncio
import json
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fakes.py, test_iter8.py

from test_iter8 import sign_init_data  # noqa: E402

TOKEN = "12345:TESTTOKEN2"


def req(path, init=None, body=None):
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


def setUpModule():
    global BASE, DB, _SAVED
    from bot import config as bconfig, db, handlers, webapp

    _SAVED = (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID,
              bconfig.WEBAPP_PUBLIC_URL, bconfig.WEBAPP_BIND)
    bconfig.TOKEN = TOKEN
    bconfig.ALLOWED_CHAT_ID = ""
    bconfig.WEBAPP_PUBLIC_URL = ""  # ambient .env (мёртвый туннель) не влияет
    bconfig.WEBAPP_BIND = "127.0.0.1"
    DB = db.connect(":memory:")
    handlers.init(DB)
    webapp.start(DB, port=0)
    BASE = webapp.URL
    assert BASE, "веб-сервер не поднялся"


def tearDownModule():
    from bot import config as bconfig, webapp

    webapp.stop()
    (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID,
     bconfig.WEBAPP_PUBLIC_URL, bconfig.WEBAPP_BIND) = _SAVED


def _restart():
    """Пересоздать сервер; вернуть его URL (BASE — всегда локальный адрес для req())."""
    global BASE
    from bot import webapp

    webapp.stop()
    url = webapp.start(DB, port=0)
    BASE = f"http://127.0.0.1:{webapp._server.server_address[1]}"
    return url


# --- публичный URL (И8b) ----------------------------------------------------------

class TestPublicUrl(unittest.TestCase):

    def tearDown(self):
        from bot import config as bconfig

        _restart()
        self.assertEqual(bconfig.WEBAPP_PUBLIC_URL, "")  # патч снят — env чист

    def test_default_local_url(self):
        from bot import config as bconfig, webapp

        self.assertIsNone(webapp.public_url())
        self.assertTrue(webapp.URL.startswith("http://127.0.0.1:"))

    def test_https_public_used_as_url(self):
        from bot import config as bconfig, webapp

        with mock.patch.object(bconfig, "WEBAPP_PUBLIC_URL", "https://panel.example.com"):
            self.assertEqual(webapp.public_url(), "https://panel.example.com")
            url = _restart()
        self.assertEqual(url, "https://panel.example.com")
        self.assertEqual(webapp.URL, url)
        # страница по-прежнему отдаётся тем же сервером (публичный URL — только адрес)
        self.assertEqual(req("/")[0], 200)

    def test_http_public_ignored(self):
        from bot import config as bconfig, webapp

        with mock.patch.object(bconfig, "WEBAPP_PUBLIC_URL", "http://192.168.1.5:8087"):
            self.assertIsNone(webapp.public_url())
            url = _restart()
        self.assertTrue(url.startswith("http://127.0.0.1:"))


# --- привязка сервера (И8b) -------------------------------------------------------

class TestBind(unittest.TestCase):

    def test_default_loopback(self):
        from bot import webapp

        self.assertEqual(webapp._server.server_address[0], "127.0.0.1")

    def test_bind_configurable(self):
        from bot import config as bconfig, webapp

        webapp.stop()
        with mock.patch.object(bconfig, "WEBAPP_BIND", "0.0.0.0"):
            url = webapp.start(DB, port=0)
        self.assertTrue(url)
        self.assertEqual(webapp._server.server_address[0], "0.0.0.0")
        _restart()  # вернуть локальный сервер прочим тестам


# --- меню-кнопка Telegram (setChatMenuButton, И8b) --------------------------------

from aiogram.enums import MenuButtonType  # noqa: E402
from fakes import FakeBot  # noqa: E402


class TestMenuButtonApi(unittest.TestCase):

    def setUp(self):
        from bot import webapp

        self.bot = FakeBot()
        self.webapp = webapp

    def mb(self):
        calls = [v for t, v in self.bot.calls if t == "SetChatMenuButton"]
        return calls[0]["menu_button"] if calls else None

    def test_https_sets_web_app(self):
        from bot import config as bconfig
        from bot.handlers import menu

        with mock.patch.object(bconfig, "WEBAPP_PUBLIC_URL", "https://panel.example.com"):
            asyncio.run(menu.setup_menu_button(self.bot))
        button = self.mb()
        self.assertEqual(button["type"], "web_app")
        self.assertEqual(button["web_app"]["url"], "https://panel.example.com")
        self.assertEqual(button["text"], "Новости")

    def test_no_public_url_resets_to_default(self):
        from bot.handlers import menu

        asyncio.run(menu.setup_menu_button(self.bot))
        self.assertIs(self.mb()["type"], MenuButtonType.DEFAULT)

    def test_http_public_resets_to_default(self):
        from bot import config as bconfig
        from bot.handlers import menu

        with mock.patch.object(bconfig, "WEBAPP_PUBLIC_URL", "http://10.0.0.2:8087"):
            asyncio.run(menu.setup_menu_button(self.bot))
        self.assertIs(self.mb()["type"], MenuButtonType.DEFAULT)

    def test_server_down_resets_to_default(self):
        from bot.handlers import menu

        with mock.patch.object(self.webapp, "running", lambda: False), \
                mock.patch.object(self.webapp, "URL", "https://dead.example"):
            asyncio.run(menu.setup_menu_button(self.bot))
        self.assertIs(self.mb()["type"], MenuButtonType.DEFAULT)


# --- инлайн-кнопка меню несёт публичный https-URL ---------------------------------

from aiogram.types import Update  # noqa: E402
from fakes import make_callback, shared_dispatcher  # noqa: E402


class TestInlineButton(unittest.TestCase):

    CHAT, USER = 6465, 9

    def setUp(self):
        from aiogram.fsm.storage.base import StorageKey
        from bot import db, handlers
        from bot.handlers import onboarding

        handlers.init(db.connect(":memory:"))
        self.webapp = __import__("bot").webapp
        self.dp = shared_dispatcher()
        self.bot = FakeBot()
        key = StorageKey(bot_id=self.bot.id, chat_id=self.CHAT, user_id=self.USER)
        asyncio.run(self.dp.storage.set_state(key, None))
        asyncio.run(self.dp.storage.set_data(key, {}))
        onboarding.ACTIVE.clear()
        self._n = 0

    def press(self, data):
        self._n += 1
        cb = make_callback(self.CHAT, self.USER, data)
        asyncio.run(self.dp.feed_update(self.bot, Update(update_id=self._n, callback_query=cb)))

    def test_button_carries_public_https_url(self):
        with mock.patch.object(self.webapp, "URL", "https://panel.example.com"):
            self.press("menu:webapp")
        sends = [v for t, v in self.bot.calls if t == "SendMessage"]
        self.assertTrue(sends and "Веб-панель" in sends[0]["text"])
        btn = sends[0]["reply_markup"]["inline_keyboard"][0][0]
        self.assertEqual(btn["web_app"]["url"], "https://panel.example.com")


if __name__ == "__main__":
    unittest.main()
