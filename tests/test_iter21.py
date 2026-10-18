"""Итерация 21 (2026-10-02): ревью-цикл ponytail + pi-subagents (три линзы:
логика, эффективность, эксплуатация). Закрыты находки P0/P1 и малые P2.

iter-21a: короткие служебные вызовы LLM (интервью, подбор источников) шли
с thinking=True при LLM_EFFORT=max — мышление съедало INTERVIEW_MAX_TOKENS=1000
и SUGGEST_MAX_TOKENS=16000 целиком (та же ловушка, что map-стадия в iter-18):
пустой/обрезанный ответ → None/[] → фолбэк на дефолт-профиль.
tests/TESTPLAN.md."""
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


if __name__ == "__main__":
    unittest.main()
