// Дневной анализ: разбор ответа LLM, фолбэк без сети и запись в базу.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { analyzePending, fallbackGist } from '../src/analyze.js';
import { addSource, ensureUser, insertItem, listSources, openStore, pendingRows, storeHandle } from '../src/store.js';
import { isoNow } from '../src/text.js';

const dir = mkdtempSync(join(tmpdir(), 'news-analyze-'));
openStore(join(dir, 'news.db'));
after(() => {
  try {
    storeHandle().close();
  } catch {
    /* уже закрыта */
  }
  rmSync(dir, { recursive: true, force: true });
});

const CHAT = 1;

let batch = 0;
async function seedItems(count) {
  batch += 1;
  await ensureUser(CHAT);
  const { id } = await addSource(CHAT, { kind: 'rss', url: `https://ex.com/an-${batch}.xml`, title: `A${batch}` });
  for (let index = 0; index < count; index += 1) {
    await insertItem(id, {
      url: `https://ex.com/an/${batch}/${index}`,
      title: `Новость ${index}`,
      text: `Текст новости ${index}. Подробности.`,
      published: isoNow(),
    });
  }
  return id;
}

test('разбор ответа LLM: только известные id, важность в 1–5, темы обрезаны', async () => {
  const sourceId = await seedItems(2);
  const rows = (await pendingRows(CHAT, Date.now() - 60_000)).filter((row) => row.sourceId === sourceId);
  const payload = JSON.stringify([
    { id: rows[0].id, gist: 'Выжимка первая', importance: 9, topics: ['золото', 'ФРС'] },
    { id: rows[1].id, gist: 'Выжимка вторая', importance: 0, topics: [] },
    { id: 999999, gist: 'Чужой id', importance: 3 },
  ]);
  const result = await analyzePending({ batch: 10, call: async () => payload, log: () => {} });
  assert.equal(result.analyzed, 2);
  const stored = storeHandle().raw.prepare('SELECT id, gist, importance, topics FROM items WHERE source_id = ?').all(sourceId);
  const byId = new Map(stored.map((row) => [Number(row.id), row]));
  assert.equal(byId.get(rows[0].id).gist, 'Выжимка первая');
  assert.equal(Number(byId.get(rows[0].id).importance), 5);
  assert.deepEqual(JSON.parse(byId.get(rows[0].id).topics), ['золото', 'ФРС']);
  assert.equal(byId.get(rows[1].id).gist, 'Выжимка вторая');
  assert.equal(Number(byId.get(rows[1].id).importance), 1);
});

test('мусор вместо JSON: фолбэк на первое предложение, пункт не висит неразобранным', async () => {
  const sourceId = await seedItems(1);
  const result = await analyzePending({ batch: 10, call: async () => 'извините, не могу', log: () => {} });
  assert.equal(result.analyzed, 1);
  const row = storeHandle().raw.prepare('SELECT gist, analyzed FROM items WHERE source_id = ?').get(sourceId);
  assert.equal(Number(row.analyzed), 1);
  assert.match(row.gist, /Текст новости/);
});

test('LLM недоступна: выжимка всё равно появляется и помечена честно', async () => {
  const sourceId = await seedItems(1);
  const result = await analyzePending({
    batch: 10,
    call: async () => {
      throw new Error('network down');
    },
    log: () => {},
  });
  assert.equal(result.analyzed, 1);
  assert.equal(result.failed, 1);
  const row = storeHandle().raw.prepare('SELECT gist FROM items WHERE source_id = ?').get(sourceId);
  assert.match(row.gist, /без анализа: LLM недоступна/);
});

test('фолбэк берёт первое предложение, а не весь текст', () => {
  const { gist } = fallbackGist({ title: 'T', text: 'Первое предложение. Второе предложение. Третье.' });
  assert.equal(gist, 'Первое предложение.');
});

test('пустая очередь: ни вызовов, ни записей', async () => {
  const before = storeHandle().$count((await import('../src/schema.js')).items);
  let called = false;
  const result = await analyzePending({ batch: 5, call: async () => ((called = true), '[]'), log: () => {} });
  assert.equal(result.analyzed, 0);
  assert.equal(called, false);
  assert.equal(storeHandle().$count((await import('../src/schema.js')).items), before);
});

test('модель ответила, но часть пунктов пропустила — их считаем отдельно (skipped)', async () => {
  const sourceId = await seedItems(3);
  const ids = (await pendingRows(CHAT, Date.now() - 60_000)).filter((row) => row.sourceId === sourceId).map((row) => row.id);
  const call = async () => JSON.stringify([{ id: ids[0], gist: 'разобрано', importance: 3, topics: [] }]);
  const result = await analyzePending({ batch: 3, minAgeMs: 0, call, log: () => {} });
  assert.equal(result.analyzed, 3, 'все три пункта записаны');
  assert.equal(result.failed, 0, 'сбой модели не было');
  assert.equal(result.skipped, 2, 'два пункта ушли фолбэком — это видно в счётчике');
});
