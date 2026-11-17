// Конфигурация службы: значения из окружения, включая капризный LLM_THINKING.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig, resetConfigCache } from '../src/config.js';

const base = {
  NEWS_CHAT_ID: '1',
  NEWS_BOT_TOKEN: 'x',
  NEWS_API_TOKEN: 't',
};

test('LLM_THINKING словом превращается в объект', () => {
  resetConfigCache();
  const config = loadConfig({ ...base, LLM_THINKING: 'enabled' });
  assert.deepEqual(config.llm.thinking, { type: 'enabled' });
});

test('LLM_THINKING готовым JSON не оборачивается второй раз', () => {
  resetConfigCache();
  const config = loadConfig({ ...base, LLM_THINKING: '{"type":"enabled"}' });
  assert.deepEqual(config.llm.thinking, { type: 'enabled' });
  const disabled = loadConfig({ ...base, LLM_THINKING: '{"type":"disabled","budget_tokens":1024}' });
  assert.equal(disabled.llm.thinking.type, 'disabled');
  assert.equal(disabled.llm.thinking.budget_tokens, 1024);
});

test('битый JSON — настройка по умолчанию, а не падение', () => {
  resetConfigCache();
  const config = loadConfig({ ...base, LLM_THINKING: '{oops' });
  assert.deepEqual(config.llm.thinking, { type: 'enabled' });
});

test('слоты, интервал и пустые значения', () => {
  resetConfigCache();
  const config = loadConfig({ ...base, NEWS_DIGEST_TIMES: '08:30, 20:15', NEWS_COLLECT_INTERVAL_MIN: '' });
  assert.deepEqual(config.sendTimes, ['08:30', '20:15']);
  assert.equal(config.service.collectIntervalMin, 20); // пустая переменная — не ноль
  const bad = loadConfig({ ...base, NEWS_DIGEST_TIMES: 'утро,07:05' });
  assert.deepEqual(bad.sendTimes, ['07:05']);
});

test('нет chat_id — гейт закрыт', () => {
  resetConfigCache();
  const config = loadConfig({ NEWS_API_TOKEN: 't' });
  assert.equal(config.allowedChatId, null);
});
