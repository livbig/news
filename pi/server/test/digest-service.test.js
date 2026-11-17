// Сводка целиком, но без сети: LLM подменена функцией, телеграм не вызывается.
// Проверяем то, что читатель увидит: окно, отбор, заголовок, анти-дедуп, честное «пусто».

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'news-digest-'));
process.env.NEWS_DB = join(dir, 'news.db');
process.env.NEWS_CHAT_ID = '42';
process.env.LLM_API_KEY = 'test-key';
process.env.NEWS_DIGEST_TIMES = '09:00,21:00';

const { buildDigest, resolveWindow, selectForDigest, collectNow } = await import('../src/digest-service.js');
const { EMPTY_TEXT } = await import('../src/digest.js');
const { loadConfig } = await import('../src/config.js');
const { addSource, ensureUser, insertItem, listSources, openStore, recordDigest, storeHandle } = await import('../src/store.js');
const { isoFromMs, isoNow } = await import('../src/text.js');

openStore(process.env.NEWS_DB);
after(() => {
  try {
    storeHandle().close();
  } catch {
    /* уже закрыта */
  }
  rmSync(dir, { recursive: true, force: true });
});

const CHAT = 42;
const DAY = 24 * 60 * 60 * 1000;
const fakeSummary = async () => '<b>ЛИД</b>: главное за период.\n\n<b>🤖 AI-МОДЕЛИ</b>\n<b>Событие</b> — вывод. <a href="https://ex.com/1">🤖</a>';

async function seed(count, { sourceUrl = 'https://ex.com/feed.xml', fetchedAt = isoNow(), published = null } = {}) {
  await ensureUser(CHAT);
  const { id } = await addSource(CHAT, { kind: 'rss', url: sourceUrl, title: 'Источник' });
  const created = [];
  for (let index = 0; index < count; index += 1) {
    await insertItem(id, {
      url: `${sourceUrl}#item-${index}-${Math.random().toString(36).slice(2, 7)}`,
      title: `Новость ${sourceUrl.slice(-12)} ${index}`,
      text: 'Тело новости для сводки.',
      published: published ?? isoNow(),
    });
  }
  storeHandle().exec(`UPDATE items SET fetched_at = '${fetchedAt}' WHERE source_id = ${id}`);
  const rows = storeHandle().raw.prepare('SELECT id FROM items WHERE source_id = ?').all(id);
  return rows.map((row) => row.id);
}

test('окно по умолчанию — сутки, явный период понимается словами', () => {
  const config = loadConfig();
  const now = Date.parse('2026-11-10T12:00:00Z');
  const plain = resolveWindow({ nowMs: now, tzOffsetMin: 180, config });
  assert.equal(now - plain.fromMs, DAY);
  const yesterday = resolveWindow({ period: 'вчера', nowMs: now, tzOffsetMin: 180, config });
  assert.equal(yesterday.explicit, true);
  assert.ok(yesterday.fromMs < yesterday.toMs);
  const invalid = resolveWindow({ period: 'с 31 февраля', nowMs: now, tzOffsetMin: 180, config });
  assert.equal(invalid.invalid, true);
});

test('отбор: не больше perSource и без уже отправленного', () => {
  const config = loadConfig();
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: index,
    sourceId: 1,
    title: `T${index}`,
    url: `https://ex.com/${index}`,
    text: '',
    published: isoNow(),
    fetchedAt: isoNow(),
  }));
  const window = { fromMs: Date.now() - DAY, toMs: Date.now(), explicit: false };
  const result = selectForDigest({ rows, window, profile: 'manual', config, consumedUrls: new Set(['https://ex.com/0']), consumedTitles: new Set() });
  assert.equal(result.selected.length, 4);
});

test('сводка собирается: пункты, заголовок, лид модели', async () => {
  await seed(3, { sourceUrl: 'https://ex.com/main.xml' });
  const digest = await buildDigest({ chatId: CHAT, summarizeFn: fakeSummary, log: () => {} });
  assert.equal(digest.itemCount, 3);
  assert.match(digest.text, /ГЛАВНОЕ ЗА ПЕРИОД/);
  assert.match(digest.text, /ЛИД/);
  assert.equal(digest.items.length, 3);
});

test('анти-дедуп: после отправки те же пункты в новую сводку не идут', async () => {
  const digest = await buildDigest({ chatId: CHAT, summarizeFn: fakeSummary, log: () => {} });
  await recordDigest(CHAT, {
    periodFrom: isoFromMs(Date.now() - DAY),
    periodTo: isoNow(),
    text: digest.text,
    itemIds: digest.items.map((row) => row.id),
  });
  const second = await buildDigest({ chatId: CHAT, summarizeFn: fakeSummary, log: () => {} });
  assert.equal(second.items.length, 0);
  assert.equal(second.text, EMPTY_TEXT);
});

test('явный период без пунктов: честная строка, а не выдуманная сводка', async () => {
  const digest = await buildDigest({ chatId: CHAT, period: 'позавчера', summarizeFn: fakeSummary, log: () => {} });
  assert.equal(digest.items.length, 0);
  assert.match(digest.text, /За период/);
});

test('старый пункт в обычную сводку не попадает, в явный период — да', async () => {
  const threeDaysAgo = isoFromMs(Date.now() - 2 * DAY);
  await seed(1, { sourceUrl: 'https://ex.com/old.xml', fetchedAt: threeDaysAgo, published: threeDaysAgo });
  const fresh = await buildDigest({ chatId: CHAT, summarizeFn: fakeSummary, log: () => {} });
  assert.equal(fresh.items.length, 0);
  const threeDays = await buildDigest({ chatId: CHAT, period: 'за 3 дня', summarizeFn: fakeSummary, log: () => {} });
  assert.ok(threeDays.items.length >= 1);
});

test('collectNow без источников не падает', async () => {
  const result = await collectNow({ chatId: 999, log: () => {} });
  assert.equal(result.sources, 0);
  assert.equal(result.added, 0);
  assert.ok(listSources(999).length === 0);
});
