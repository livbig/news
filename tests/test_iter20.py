"""Итерация 20 (2026-10-01): ретрай-лестница по усилию мышления и запас
бюджета. Инцидент: сводка 09:00 не пришла — effort=max на плотном входе
(100 пунктов, 14.5k входных токенов) дважды выжег LLM_MAX_TOKENS=64000
выходных токенов на thinking, текста не было ни в одной попытке.
Правка: вторая попытка после обрезки идёт с effort=high; LLM_MAX_TOKENS
поднят до 96000 (реплей боевого входа: max — 54.8k, high — 30.9k).
tests/TESTPLAN.md."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class EffortLadder(unittest.TestCase):
    """bot.llm.summarize: обрезка по max_tokens понижает усилие на повторе."""

    def _run(self, side_effects):
        from pipeline import config as pconfig
        from bot import llm

        efforts = []

        def fake_call(system, messages, max_tokens, read_timeout=None, thinking=None,
                      effort=None):
            efforts.append(effort)
            effect = side_effects[len(efforts) - 1]
            if isinstance(effect, Exception):
                raise effect
            return effect

        real_call, real_key, real_sleep = llm._call, pconfig.LLM_API_KEY, llm._sleep
        llm._call, pconfig.LLM_API_KEY, llm._sleep = fake_call, "test-key", lambda s: None
        try:
            return llm.summarize("Заголовок — http://ex.test/1"), efforts
        finally:
            llm._call, pconfig.LLM_API_KEY, llm._sleep = real_call, real_key, real_sleep

    def test_truncated_downgrades_effort(self):
        from pipeline.llm import LLMTruncatedError

        text, efforts = self._run([LLMTruncatedError("обрезан"), "Лид.\nПункт."])
        self.assertEqual(efforts, [None, "high"])  # None = усилие из LLM_EFFORT
        self.assertIn("Лид.", text)

    def test_timeout_keeps_effort(self):
        """Не обрезка (таймаут) — усилие не понижаем: причина другая."""
        import httpx

        text, efforts = self._run([httpx.ConnectTimeout("no route"), "Лид.\nПункт."])
        self.assertEqual(efforts, [None, None])
        self.assertIn("Лид.", text)


class EffortOverride(unittest.TestCase):
    """pipeline.llm._call: effort переопределяет LLM_EFFORT в payload."""

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

    def _payload(self, effort):
        import pipeline.llm as pll
        from pipeline import config as pconfig

        captured = {}
        real_stream, real_effort, real_key = (
            pll.httpx.stream, pconfig.LLM_EFFORT, pconfig.LLM_API_KEY
        )

        def fake_stream(method, url, headers=None, json=None, timeout=None):
            captured.update(json)
            return self._Stream(self.SSE)

        pll.httpx.stream, pconfig.LLM_EFFORT, pconfig.LLM_API_KEY = (
            fake_stream, "max", "test-key"
        )
        try:
            pll._call("sys", [{"role": "user", "content": "x"}], 100,
                      thinking=True, effort=effort)
        finally:
            pll.httpx.stream, pconfig.LLM_EFFORT, pconfig.LLM_API_KEY = (
                real_stream, real_effort, real_key
            )
        return captured

    def test_override_wins(self):
        self.assertEqual(self._payload("high")["output_config"], {"effort": "high"})

    def test_none_takes_config(self):
        self.assertEqual(self._payload(None)["output_config"], {"effort": "max"})


if __name__ == "__main__":
    unittest.main()
