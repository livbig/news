"""Итерация 21 (2026-10-02): ревью-цикл ponytail + pi-subagents (три линзы:
логика, эффективность, эксплуатация). Закрыты находки P0/P1 и малые P2.

iter-21a: короткие служебные вызовы LLM (интервью, подбор источников) шли
с thinking=True при LLM_EFFORT=max — мышление съедало INTERVIEW_MAX_TOKENS=1000
и SUGGEST_MAX_TOKENS=16000 целиком (та же ловушка, что map-стадия в iter-18):
пустой/обрезанный ответ → None/[] → фолбэк на дефолт-профиль.
tests/TESTPLAN.md."""
import asyncio
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class InterviewWithoutThinking(unittest.TestCase):
    """bot.interview / bot.llm.suggest_sources: thinking выключен явно."""

    def _capture(self, module, func):
        from pipeline import config as pconfig

        seen = {}

        def fake_call(system, messages, max_tokens, read_timeout=None,
                      thinking=None, effort=None):
            seen["thinking"] = thinking
            return 'Готово? "title": "x"'

        real_call, real_key = module._call, pconfig.LLM_API_KEY
        module._call, pconfig.LLM_API_KEY = fake_call, "test-key"
        try:
            func()
        finally:
            module._call, pconfig.LLM_API_KEY = real_call, real_key
        return seen

    def test_next_question_disables_thinking(self):
        from bot import interview

        seen = self._capture(interview, lambda: interview.next_question([]))
        self.assertIs(seen["thinking"], False)

    def test_build_profile_disables_thinking(self):
        from bot import interview

        seen = self._capture(interview, lambda: interview.build_profile(
            [{"role": "user", "content": "q"}]))
        self.assertIs(seen["thinking"], False)

    def test_suggest_sources_disables_thinking(self):
        from bot import llm

        seen = self._capture(llm, lambda: llm.suggest_sources("золото"))
        self.assertIs(seen["thinking"], False)


class DigestCharBudget(unittest.TestCase):
    """bot.digest.build_delta: вход мега-вызова ограничен и по символам."""

    def test_input_stops_at_budget(self):
        from bot import config, digest

        rows = [{"id": i, "title": "Т" * 100, "url": f"http://ex.test/{i}",
                 "gist": "Ж" * 400, "text": None} for i in range(10)]
        seen = {}
        real = (digest.db.pending_items, digest.db.get_interests,
                digest.db.digest_period, digest.llm.summarize,
                config.DIGEST_MAX_CHARS)
        digest.db.pending_items = lambda conn, chat_id: rows
        digest.db.get_interests = lambda conn, chat_id: None
        digest.db.digest_period = lambda conn, chat_id: None

        def fake_summarize(text, interests=None):
            seen["len"] = len(text)
            return "Лид."

        digest.llm.summarize = fake_summarize
        config.DIGEST_MAX_CHARS = 1500
        try:
            text, ids = digest.build_delta(None, 1)
        finally:
            (digest.db.pending_items, digest.db.get_interests,
             digest.db.digest_period, digest.llm.summarize,
             config.DIGEST_MAX_CHARS) = real
        # 2 пункта по ~530 симв. влезают в 1500, третий — нет и остаётся
        # непотреблённым (ids только вошедших: иначе items «съедались» бы вслепую)
        self.assertEqual(ids, [0, 1])
        self.assertLessEqual(seen["len"], 1500 + 20)  # + обёртка <новости>


class CatchUpRetry(unittest.TestCase):
    """bot.scheduler.slots_once: catch-up не теряет сводку при сбое доставки.

    До iter-21 prep в catch-up хранил БУДУЩИЙ слот (upcoming), поэтому повтор
    D25 не срабатывал вовсе: фаза 1 требует prep is None, фаза 2 — now >= slot,
    а catch-up — снова prep is None. Сводка висела в памяти до следующего слота.
    """

    def _tick(self, now, send_results):
        from datetime import datetime

        from bot import db, digest, scheduler, tgsend

        row = {"chat_id": 1, "send_times": '["09:00"]',
               "last_sent_at": "2026-09-20T06:00:00Z",
               "onboarded_at": "2026-09-01T06:00:00Z"}
        sent_text = []
        real = (db.scheduled_users, db.record_digest, digest.build_delta,
                tgsend.send_chat, scheduler.SEND_RETRY)
        db.scheduled_users = lambda conn: [row]
        db.record_digest = lambda *a, **k: 1
        digest.build_delta = lambda conn, chat_id: ("Сводка", [7])
        tgsend.send_chat = lambda text, chat_id: sent_text.append(text) or send_results.pop(0)
        scheduler.SEND_RETRY = 0
        try:
            out = asyncio.run(scheduler.slots_once(None, now))
        finally:
            (db.scheduled_users, db.record_digest, digest.build_delta,
             tgsend.send_chat, scheduler.SEND_RETRY) = real
        return out, sent_text

    def setUp(self):
        from bot import scheduler

        scheduler._state.clear()  # между тиками состояние НЕ чистится — в этом суть
        scheduler._retry.clear()

    def test_failed_delivery_is_retried(self):
        from datetime import datetime

        now = datetime(2026, 10, 2, 12, 0).astimezone()
        sent, texts = self._tick(now, [False, True])
        self.assertEqual(sent, [])          # первый тик: доставка не удалась
        self.assertEqual(len(texts), 1)
        sent, texts = self._tick(now, [True])  # повтор после SEND_RETRY
        self.assertEqual(sent, [1])
        self.assertEqual(len(texts), 1)     # та же подготовленная сводка ушла


if __name__ == "__main__":
    unittest.main()
