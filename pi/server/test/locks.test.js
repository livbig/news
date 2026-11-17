// Замки на сбор и сводку и честная отправка: два запуска одновременно не должны молотить
// зеркала и LLM дважды, а недосланная сводка не должна считаться отправленной.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'news-locks-'));
process.env.NEWS_DB = join(dir, 'news.db');
process.env.NEWS_CHAT_ID = '55';
process.env.LLM_API_KEY = 'test-key';
process.env.NEWS_BOT_TOKEN = '123456789:AA-test-token-not-real';

const { buildDigest, sendDigest } = await import('../src/digest-service.js');
const { addSource, ensureUser, getState, insertItem, openStore, storeHandle } = await import('../src/store.js');
const { isoNow } = await import('../src/text.js');

openStore(process.env.NEWS_DB);
after(() => {
  try {
    storeHandle().close();
  } catch {
    /* уже закрыта */
  }
  rmSync(dir, { recursive: true, force: true });
});

const CHAT = 55;

test('вторая сводка одновременно с первой — отказ, а не двойной расход LLM', async () => {
  await ensureUser(CHAT);
  // Без пунктов сводка не доходит до LLM и замок не держится — сеем один.
  const { id } = await addSource(CHAT, { kind: 'rss', url: 'https://ex.com/lock.xml', title: 'Источник' });
  await insertItem(id, { url: 'https://ex.com/lock.xml#1', title: 'Пункт для замка', text: 'тело', published: isoNow() });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slowSummary = async () => {
    await gate;
    return '';
  };
  const first = buildDigest({ chatId: CHAT, summarizeFn: slowSummary, log: () => {} });
  first.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(buildDigest({ chatId: CHAT, summarizeFn: slowSummary, log: () => {} }), /уже собирается/);
  release();
  await first.catch(() => {});
});

test('недосланная сводка не помечает слот отправленным', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  // Первый кусок уходит, дальше Telegram отвечает отказом на всех попытках.
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    return { ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 1' }) };
  };
  try {
    const digest = {
      text: `${'а'.repeat(9000)}`,
      items: [{ id: 1 }],
      window: { fromMs: Date.now() - 1000, toMs: Date.now() },
      itemCount: 1,
    };
    await assert.rejects(sendDigest({ chatId: CHAT, digest, kind: 'scheduled', slot: 'test-slot', log: () => {} }), /ушло \d+ кусков из \d+/);
    assert.equal(getState('slot:test-slot'), null, 'слот не должен быть помечен отправленным');
  } finally {
    globalThis.fetch = realFetch;
  }
});
