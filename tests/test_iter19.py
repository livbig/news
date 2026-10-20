"""iter-19: гейт единственного пользователя (D40, ужесточение).

- allowed(): fail-closed при боевом токене без TELEGRAM_CHAT_ID; открыт
  только в dev/mock-режиме (нет ни токена, ни chat_id).
- _AllowedOnlyMiddleware (bot/handlers/__init__.py): чужие апдейты режутся
  ДО роутеров — включая FSM-хендлеры без своего allowed().
"""
import asyncio
import unittest

from aiogram.types import Update

from bot import config as bconfig
from pipeline import config as pconfig

_SAVED = None


def setUpModule():
    global _SAVED
    # как прочие модули (NFR-05): реальные ключи/чаты .env в тесты не утекают
    _SAVED = (bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY)
    bconfig.TOKEN = "1:PROD"          # боевой режим: гейт активен
    bconfig.ALLOWED_CHAT_ID = "4242"  # владелец
    pconfig.LLM_API_KEY = ""


def tearDownModule():
    bconfig.TOKEN, bconfig.ALLOWED_CHAT_ID, pconfig.LLM_API_KEY = _SAVED


from fakes import FakeBot, make_callback, make_message, shared_dispatcher  # noqa: E402


class GateCase(unittest.TestCase):
    """Общее: чистая БД, общий диспетчер (middleware собрана в нём), fake-поллинг."""

    CHAT = 4242  # владелец = ALLOWED_CHAT_ID
    USER = 7
    STRANGER = 9999
    STRANGER_USER = 8

    def setUp(self):
        from aiogram.fsm.storage.base import StorageKey
        from bot import db, handlers
        from bot.handlers import onboarding

        handlers.init(db.connect(":memory:"))
        self.db = db
        self.onboarding = onboarding
        self.dp = shared_dispatcher()
        self.bot = FakeBot()
        self._update_id = 0
        for chat, user in ((self.CHAT, self.USER), (self.STRANGER, self.STRANGER_USER)):
            key = StorageKey(bot_id=self.bot.id, chat_id=chat, user_id=user)
            asyncio.run(self.dp.storage.set_state(key, None))
            asyncio.run(self.dp.storage.set_data(key, {}))
        onboarding.ACTIVE.clear()

    def feed(self, **event):
        self._update_id += 1
        asyncio.run(self.dp.feed_update(self.bot, Update(update_id=self._update_id, **event)))

    def _user_rows(self, chat_id):
        return self.onboarding.conn.execute(
            "SELECT count(*) FROM users WHERE chat_id=%s", (chat_id,)).fetchone()[0]


class TC50AllowedSemantics(GateCase):
    """allowed(): владелец/чужой, fail-closed без chat_id, dev-режим открыт."""

    def test_semantics(self):
        from bot.handlers.onboarding import allowed

        self.assertTrue(allowed(4242))
        self.assertTrue(allowed("4242"))
        self.assertFalse(allowed(9999))
        self.assertFalse(allowed("9999"))
        saved_chat, saved_token = bconfig.ALLOWED_CHAT_ID, bconfig.TOKEN
        try:
            bconfig.ALLOWED_CHAT_ID = ""  # боевой токен без chat_id — закрыто для всех
            self.assertFalse(allowed(4242))
            bconfig.TOKEN = ""            # dev/mock: нет ни токена, ни chat_id — открыто
            self.assertTrue(allowed(9999))
        finally:
            bconfig.ALLOWED_CHAT_ID, bconfig.TOKEN = saved_chat, saved_token


class TC51StrangerMessagesIgnored(GateCase):
    """Команда и свободный текст чужого чата — тишина, следов в БД нет."""

    def test_stranger_ignored(self):
        self.feed(message=make_message(self.STRANGER, self.STRANGER_USER, "/start"))
        self.assertEqual(self.bot.calls, [])
        self.assertEqual(self._user_rows(self.STRANGER), 0)
        self.feed(message=make_message(self.STRANGER, self.STRANGER_USER, "что на рынках?"))
        self.assertEqual(self.bot.calls, [])
        self.feed(message=make_message(self.STRANGER, self.STRANGER_USER, "/digest"))
        self.assertEqual(self.bot.calls, [])


class TC52StrangerFsmCallbackIgnored(GateCase):
    """Чужой колбэк режется даже при выставленном FSM-состоянии."""

    def test_stranger_fsm_callback_ignored(self):
        from aiogram.fsm.storage.base import StorageKey
        from bot.states import Survey

        key = StorageKey(bot_id=self.bot.id, chat_id=self.STRANGER, user_id=self.STRANGER_USER)
        asyncio.run(self.dp.storage.set_state(key, Survey.interview))
        self.feed(callback_query=make_callback(self.STRANGER, self.STRANGER_USER, "i:done"))
        self.assertEqual(self.bot.calls, [])
        state = asyncio.run(self.dp.storage.get_state(key))
        self.assertEqual(state, Survey.interview.state)


class TC53OwnerPassesGate(GateCase):
    """Владелец проходит middleware: /start и колбэк меню доходят до хендлеров."""

    def test_owner_passes(self):
        self.db.ensure_user(self.onboarding.conn, self.CHAT)
        self.onboarding.conn.execute(
            "UPDATE users SET onboarded_at=%s WHERE chat_id=%s", ("2026-09-30", self.CHAT))
        self.onboarding.conn.commit()
        self.feed(message=make_message(self.CHAT, self.USER, "/start"))
        self.assertIn("С возвращением", self.bot.sent_texts()[-1])
        self.feed(callback_query=make_callback(self.CHAT, self.USER, "menu:main"))
        self.assertTrue(self.bot.calls)


class TC54DigestDedup(unittest.TestCase):
    """Детерминированный анти-дедуп (iter-19): прямые повторы (тот же url или
    тот же нормализованный заголовок) не попадают в сводку повторно — ни из
    прошлых дайджестов, ни внутри одной выборки. Развитие темы (другая
    формулировка) не режется."""

    CHAT = 4242

    def setUp(self):
        from bot import db

        self.db = db
        self.conn = db.connect(":memory:")
        db.ensure_user(self.conn, self.CHAT)
        self.s1 = db.add_source(self.conn, self.CHAT, "rss", "http://f1/rss", "F1")
        self.s2 = db.add_source(self.conn, self.CHAT, "rss", "http://f2/rss", "F2")

    def tearDown(self):
        self.conn.close()

    def _add(self, source_id, url, title, published):
        assert self.db.insert_item(self.conn, source_id, url, title, published)

    def _pending_urls(self):
        return [r["url"] for r in self.db.pending_items(self.conn, self.CHAT)]

    def _send_digest(self):
        ids = [r["id"] for r in self.db.pending_items(self.conn, self.CHAT)]
        assert ids
        return self.db.record_digest(self.conn, self.CHAT, "сводка", ids)

    def test_repeat_from_previous_digest_excluded(self):
        self._add(self.s1, "http://a/1", "Fed повысил ставку", "2026-09-29T09:00:00")
        self._send_digest()
        # прямой повтор той же новости (другой url, тот же заголовок) — отсекается
        self._add(self.s2, "http://b/2", "Fed повысил ставку", "2026-09-30T09:00:00")
        # развитие темы с новой формулировкой — проходит
        self._add(self.s1, "http://a/2", "Fed повысил ставку на 25 бп и намекнул на паузу",
                  "2026-09-30T10:00:00")
        self.assertEqual(self._pending_urls(), ["http://a/2"])

    def test_same_url_from_previous_digest_excluded(self):
        self._add(self.s1, "http://a/1", "Новость дня", "2026-09-29T09:00:00")
        self._send_digest()
        # тот же url от другого источника (кросс-пост) — отсекается
        self._add(self.s2, "http://a/1", "Новость дня (репост)", "2026-09-30T09:00:00")
        self.assertEqual(self._pending_urls(), [])

    def test_dup_inside_one_batch_keeps_freshest(self):
        # одна новость в двух источниках до первой сводки — выживает свежая копия
        self._add(self.s1, "http://a/1", "ЦБ РФ оставил ключевую ставку",
                  "2026-09-30T09:00:00")
        self._add(self.s2, "http://b/1", "цб рф оставил ключевую ставку!",
                  "2026-09-30T10:00:00")
        self.assertEqual(self._pending_urls(), ["http://b/1"])

    def test_developing_story_not_filtered(self):
        self._add(self.s1, "http://a/1", "Золото обновило максимум", "2026-09-29T09:00:00")
        self._send_digest()
        self._add(self.s1, "http://a/2", "Золото откатилось после данных по CPI",
                  "2026-09-30T09:00:00")
        self.assertEqual(self._pending_urls(), ["http://a/2"])


class TC55LLMPayload(unittest.TestCase):
    """Payload _call под DeepSeek (iter-19): thinking=True — поле thinking из
    LLM_THINKING + output_config.effort из LLM_EFFORT; thinking=False —
    ЯВНЫЙ {"type":"disabled"} (у DeepSeek thinking включён по умолчанию,
    иначе служебные вызовы с малым max_tokens отдают пустой текст)."""

    SSE = [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},'
        '"usage":{"output_tokens":5}}',
    ]

    class _Stream:
        status_code = 200

        def __init__(self, lines):
            self._lines = lines

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def iter_lines(self):
            yield from self._lines

    def _payload(self, thinking):
        import pipeline.llm as pll

        captured = {}
        real_stream = pll.httpx.stream

        def fake_stream(method, url, headers=None, json=None, timeout=None):
            captured.update(json)
            return self._Stream(self.SSE)

        pll.httpx.stream = fake_stream
        try:
            out = pll._call("sys", [{"role": "user", "content": "x"}],
                            100, thinking=thinking)
        finally:
            pll.httpx.stream = real_stream
        self.assertEqual(out, "ok")
        return captured

    def setUp(self):
        self._saved = (pconfig.LLM_THINKING, pconfig.LLM_EFFORT, pconfig.LLM_API_KEY)
        pconfig.LLM_THINKING = '{"type":"enabled"}'
        pconfig.LLM_EFFORT = "max"
        pconfig.LLM_API_KEY = "test-key"

    def tearDown(self):
        pconfig.LLM_THINKING, pconfig.LLM_EFFORT, pconfig.LLM_API_KEY = self._saved

    def test_thinking_true_sends_effort(self):
        payload = self._payload(thinking=True)
        self.assertEqual(payload["thinking"], {"type": "enabled"})
        self.assertEqual(payload["output_config"], {"effort": "max"})

    def test_thinking_false_disables_explicitly(self):
        payload = self._payload(thinking=False)
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("output_config", payload)

    def test_effort_empty_not_sent(self):
        pconfig.LLM_EFFORT = ""
        payload = self._payload(thinking=True)
        self.assertNotIn("output_config", payload)


if __name__ == "__main__":
    unittest.main()
