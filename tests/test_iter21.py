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


if __name__ == "__main__":
    unittest.main()
