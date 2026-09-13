"""М3: Mini App API на Vercel — Starlette-приложение api/index.py: та же
initData-авторизация и тот же JSON-контракт, что у локального webapp.py
(тест-база — test_iter8: sign_init_data и сидирование). БД — fresh ':memory:'
(в PG-режиме — временная схема), инжектируется через api.index._set_conn."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # fakes.py, test_iter8.py

from test_iter8 import sign_init_data  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

from api import index as api_index  # noqa: E402
from bot import db  # noqa: E402
from bot import config as bconfig  # noqa: E402

TOKEN = "12345:TESTTOKEN"
CHAT, OTHER = 77, 888


def seed(chat, count=2):
    db.ensure_user(CONN, chat)
    return [db.add_source(CONN, chat, "rss", f"http://ex.test/{chat}/{i}",
                          f"title{i}", "manual") for i in range(count)]


CONN = db.connect(":memory:")
api_index._set_conn(CONN)
client = TestClient(api_index.app)


class ApiBase(unittest.TestCase):
    def setUp(self):
        for t in ("sources", "items", "digest_items", "digests", "chat_history"):
            CONN.execute(f"DELETE FROM {t}")
        CONN.commit()
        for name, value in (("TOKEN", TOKEN), ("ALLOWED_CHAT_ID", str(CHAT))):
            patcher = mock.patch.object(bconfig, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.init = sign_init_data(CHAT)

    def get(self, path, chat=CHAT):
        return client.get(path, headers={"Authorization": "tma " + sign_init_data(chat)})

    def post(self, path, body, chat=CHAT, raw=None):
        headers = {"Authorization": "tma " + sign_init_data(chat)}
        if raw is not None:
            headers["Content-Type"] = "application/json"
            return client.post(path, content=raw, headers=headers)
        return client.post(path, json=body, headers=headers)


class TestPage(unittest.TestCase):
    def test_page_public_no_secrets(self):
        r = client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Источники", r.text)
        self.assertNotIn(TOKEN, r.text)  # токен не утекает в разметку

    def test_telegram_sdk_connected_before_inline(self):
        # М3.1: без telegram-web-app.js window.Telegram undefined → initData
        # пустой → 401 → вечный fallback-текст (баг серого текста)
        from bot import webapp
        src = Path(ROOT, "public", "index.html").read_text()
        for text, name in ((src, "public/index.html"), (webapp.PAGE, "webapp.PAGE")):
            self.assertIn("https://telegram.org/js/telegram-web-app.js", text)
            self.assertLess(text.index("telegram-web-app.js"),
                            text.index("const tg ="),  # SDK грузится до инлайн-скрипта
                            f"{name}: SDK должен подключаться до инлайн-скрипта")
        self.assertEqual(src, webapp.PAGE)  # тексты идентичны (Vercel CDN и фолбэк)


class TestAuth(ApiBase):
    def test_no_header_rejected(self):
        self.assertEqual(client.get("/api/sources").status_code, 401)
        self.assertEqual(client.get("/api/sources",
                                    headers={"Authorization": "tma garbage"}).status_code, 401)

    def test_tampered_hash_rejected(self):
        bad = self.init[:-1] + ("0" if self.init[-1] != "0" else "1")
        self.assertEqual(client.get("/api/sources",
                                    headers={"Authorization": "tma " + bad}).status_code, 401)

    def test_hash_of_other_token_rejected(self):
        headers = {"Authorization": "tma " + sign_init_data(CHAT, token="9:OTHER")}
        self.assertEqual(client.get("/api/sources", headers=headers).status_code, 401)

    def test_foreign_user_rejected_when_allowed_set(self):
        self.assertEqual(self.get("/api/sources", chat=OTHER).status_code, 401)


class TestSourcesApi(ApiBase):
    def test_list_seeded(self):
        ids = seed(CHAT)
        body = self.get("/api/sources").json()
        self.assertEqual([s["id"] for s in body["sources"]], ids)

    def test_toggle_flips_enabled(self):
        (sid,) = seed(CHAT, count=1)
        self.assertEqual(self.post("/api/sources/toggle", {"id": sid}).json()["enabled"], False)
        self.assertEqual(db.get_source(CONN, sid)["enabled"], 0)
        self.assertEqual(self.post("/api/sources/toggle", {"id": sid}).json()["enabled"], True)

    def test_delete_removes_with_items(self):
        (sid,) = seed(CHAT, count=1)
        db.insert_item(CONN, sid, "http://ex.test/x/1", "Новость", None)
        self.assertEqual(self.post("/api/sources/delete", {"id": sid}).json()["ok"], True)
        self.assertIsNone(db.get_source(CONN, sid))
        self.assertEqual(CONN.execute(
            "SELECT COUNT(*) FROM items WHERE source_id=%s", (sid,)).fetchone()[0], 0)

    def test_foreign_source_not_accessible(self):
        seed(CHAT, count=1)
        (foreign,) = seed(OTHER, count=1)
        self.assertEqual(self.post("/api/sources/toggle", {"id": foreign}).status_code, 404)
        self.assertEqual(self.post("/api/sources/delete", {"id": foreign}).status_code, 404)
        self.assertIsNotNone(db.get_source(CONN, foreign))

    def test_unknown_id_and_bad_body(self):
        (sid,) = seed(CHAT, count=1)
        self.assertEqual(self.post("/api/sources/toggle", {"id": 999999}).status_code, 404)
        self.assertEqual(self.post("/api/sources/toggle", {"nope": 1}).status_code, 404)
        self.assertEqual(self.post("/api/sources/toggle", None, raw="{oops").status_code, 400)
        self.assertIsNotNone(db.get_source(CONN, sid))


class TestSettingsApi(ApiBase):
    def test_get_and_post(self):
        seed(CHAT, count=0)
        db.set_send_times(CONN, CHAT, ["09:00"])
        self.assertEqual(self.get("/api/settings").json(), {"times": ["09:00"]})
        r = self.post("/api/settings", {"times": ["21:00", "7:30"]})
        self.assertEqual(r.json()["times"], ["07:30", "21:00"])  # нормализация + сортировка
        self.assertEqual(self.get("/api/settings").json(), {"times": ["07:30", "21:00"]})
        # повторная запись того же — идемпотентна (NFR-03)
        self.post("/api/settings", {"times": ["21:00", "7:30"]})
        self.assertEqual(json.loads(CONN.execute(
            "SELECT send_times FROM users WHERE chat_id=%s", (CHAT,)).fetchone()[0]),
            ["07:30", "21:00"])

    def test_invalid_values_rejected(self):
        seed(CHAT, count=0)
        before = CONN.execute("SELECT send_times FROM users WHERE chat_id=%s",
                              (CHAT,)).fetchone()[0]
        for times in ([], ["09:00", "12:00", "15:00"], ["25:00"], ["9:99"], ["abc"], "09:00"):
            self.assertEqual(self.post("/api/settings", {"times": times}).status_code, 400, times)
        self.assertEqual(CONN.execute("SELECT send_times FROM users WHERE chat_id=%s",
                                      (CHAT,)).fetchone()[0], before)

    def test_unknown_chat_starts_empty(self):
        patcher = mock.patch.object(bconfig, "ALLOWED_CHAT_ID", "")
        patcher.start()
        self.addCleanup(patcher.stop)  # без белого списка любой chat авторизован
        self.assertEqual(self.get("/api/settings", chat=9999).json(), {"times": []})
