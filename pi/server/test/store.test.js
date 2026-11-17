// База и слой store: тот же код, что был на платформе, но поверх node:sqlite.
// Проверяем именно то, на чём держится сводка: дедуп, окно, анти-дедуп прошлых сводок,
// надгробия retention, метки слотов и поиск. Каждый тест заводит свой источник —
// тесты не должны зависеть от порядка.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { items } from '../src/schema.js';
import {
  addSource,
  analyzeStats,
  consumedKeys,
  deleteSource,
  ensureUser,
  getInterests,
  getState,
  insertItem,
  insertItems,
  listDigests,
  listSources,
  markSlotSent,
  openStore,
  pendingRows,
  recentItems,
  recordDigest,
  retentionPass,
  saveAnalysis,
  searchItems,
  setInterests,
  setState,
  slotSent,
  sourceCounts,
  stats,
  storeHandle,
} from '../src/store.js';
import { isoFromMs, isoNow } from '../src/text.js';

const dir = mkdtempSync(join(tmpdir(), 'news-store-'));
openStore(join(dir, 'news.db'));
after(() => {
  try {
    storeHandle().close();
  } catch {
    /* уже закрыта */
  }
  rmSync(dir, { recursive: true, force: true });
});

const CHAT = 603522950;
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

async function freshSource(tag = 'src') {
  seq += 1;
  const result = await addSource(CHAT, { kind: 'rss', url: `https://ex.com/${tag}-${seq}.xml`, title: `${tag}-${seq}` });
  const rows = listSources(CHAT);
  return rows.find((row) => row.id === result.id);
}

test('схема создаётся и профиль заводится один раз', async () => {
  const user = await ensureUser(CHAT);
  assert.equal(Number(user.chatId), CHAT);
  assert.equal(Number(user.tzOffsetMin), 180);
  const again = await ensureUser(CHAT);
  assert.equal(Number(again.chatId), CHAT);
});

test('источник: добавление, дубль, удаление с зависимостями', async () => {
  const created = await addSource(CHAT, { kind: 'rss', url: 'https://ex.com/feed.xml', title: 'Ex', topics: ['тест'] });
  assert.equal(created.created, true);
  const duplicate = await addSource(CHAT, { kind: 'rss', url: 'https://ex.com/feed.xml', title: 'Ex', topics: [] });
  assert.equal(duplicate.created, false);

  await insertItem(created.id, { url: 'https://ex.com/1', title: 'Новость', text: 'текст', published: isoNow() });
  storeHandle().exec(`UPDATE items SET fetched_at = '${isoNow()}' WHERE url = 'https://ex.com/1'`);
  assert.equal(await deleteSource(created.id, CHAT), true);
  assert.equal(storeHandle().$count(items), 0);
});

test('дедуп пункта: повтор URL+заголовка не вставляет второй раз', async () => {
  const source = await freshSource('dedupe');
  const entry = { url: 'https://ex.com/news/1?utm=1', title: 'Заголовок один', published: isoNow(), text: 'тело' };
  assert.equal(await insertItem(source.id, entry), true);
  assert.equal(await insertItem(source.id, { ...entry, url: 'https://ex.com/news/1?utm=2' }), false);
});

test('пачка пунктов: одна транзакция, дедуп внутри пачки и с прошлым', async () => {
  const source = await freshSource('batch');
  const batch = [
    { url: 'https://ex.com/b/1', title: 'Первая', published: isoNow() },
    { url: 'https://ex.com/b/2', title: 'Вторая', published: isoNow() },
    { url: 'https://ex.com/b/1?utm=1', title: 'Первая', published: isoNow() },
  ];
  assert.equal(await insertItems(source.id, batch), 2);
  assert.equal(await insertItems(source.id, batch), 0);
  const rows = (await pendingRows(CHAT, Date.now() - DAY)).filter((row) => row.sourceId === source.id);
  assert.equal(rows.length, 2);
});

test('окно сводки: pendingRows по fetchedAt, recentItems с верхней границей', async () => {
  const source = await freshSource('window');
  await insertItem(source.id, { url: 'https://ex.com/w/1', title: 'Свежая', published: isoNow(), text: 'x' });
  storeHandle().exec(`UPDATE items SET fetched_at = '${isoNow()}' WHERE url = 'https://ex.com/w/1'`);
  const rows = (await pendingRows(CHAT, Date.now() - DAY)).filter((row) => row.sourceId === source.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, source.id);
  const older = await recentItems(CHAT, Date.now() - 2 * DAY, 10, Date.now() - DAY);
  assert.equal(older.length, 0);
});

test('anti-дедуп: пункты прошлой сводки не попадают в следующую', async () => {
  const source = await freshSource('consumed');
  await insertItem(source.id, { url: 'https://ex.com/c/1', title: 'Уже была', published: isoNow(), text: 'x' });
  const rows = (await pendingRows(CHAT, Date.now() - DAY)).filter((row) => row.sourceId === source.id);
  await recordDigest(CHAT, {
    periodFrom: isoFromMs(Date.now() - DAY),
    periodTo: isoNow(),
    text: 'тестовая сводка',
    itemIds: rows.map((row) => row.id),
    kind: 'manual',
  });
  const consumed = await consumedKeys(CHAT);
  assert.equal(consumed.urls.has('https://ex.com/c/1'), true);
  assert.ok((await listDigests(CHAT)).length >= 1);
});

test('retention: старый пункт уходит в надгробия и не возвращается', async () => {
  const source = await freshSource('retention');
  const old = { url: 'https://ex.com/old', title: 'Старая новость', published: isoFromMs(Date.now() - 20 * DAY), text: 'старое' };
  assert.equal(await insertItem(source.id, old), true);
  storeHandle().exec(`UPDATE items SET fetched_at = '${isoFromMs(Date.now() - 20 * DAY)}' WHERE url = 'https://ex.com/old'`);
  const result = await retentionPass(CHAT, { itemsDays: 10, days: 30 });
  assert.ok(result.itemsRemoved >= 1);
  assert.equal(await insertItem(source.id, old), false);
});

test('retention: старые надгробия удаляются, свежие нужны (иначе таблица растёт вечно)', async () => {
  const source = await freshSource('tombs');
  await insertItem(source.id, { url: 'https://ex.com/t/old', title: 'Старый надгробный', published: isoFromMs(Date.now() - 20 * DAY) });
  await insertItem(source.id, { url: 'https://ex.com/t/fresh', title: 'Свежий надгробный', published: isoFromMs(Date.now() - 20 * DAY) });
  storeHandle().exec(`UPDATE items SET fetched_at = '${isoFromMs(Date.now() - 20 * DAY)}' WHERE source_id = ${source.id}`);
  await retentionPass(CHAT, { itemsDays: 10, days: 30 });
  // Все надгробия делаем старыми, потом возвращаем возраст одному — так проверяется граница.
  storeHandle().exec("UPDATE seen_hashes SET created_at = '2026-01-01T00:00:00.000Z'");
  storeHandle().exec(`UPDATE seen_hashes SET created_at = '${isoNow()}' WHERE rowid = (SELECT MAX(rowid) FROM seen_hashes)`);
  const before = storeHandle().raw.prepare('SELECT COUNT(*) AS c FROM seen_hashes').get().c;
  const result = await retentionPass(CHAT, { itemsDays: 10, days: 30, tombDays: 60 });
  const after = storeHandle().raw.prepare('SELECT COUNT(*) AS c FROM seen_hashes').get().c;
  assert.ok(result.tombsRemoved >= 1, 'старые надгробия должны удаляться');
  assert.equal(after, before - result.tombsRemoved);
  assert.ok(after >= 1, 'свежее надгробие остаётся');
});

test('анализ: сохранение выжимки и счётчики разобранного', async () => {
  const source = await freshSource('analysis');
  await insertItem(source.id, { url: 'https://ex.com/analyze', title: 'Для анализа', published: isoNow(), text: 'текст' });
  const rows = (await pendingRows(CHAT, Date.now() - DAY)).filter((row) => row.sourceId === source.id);
  assert.equal(rows.length, 1);
  saveAnalysis(rows[0].id, { gist: 'выжимка', importance: 4, topics: ['тест'] });
  const counters = analyzeStats();
  assert.ok(counters.analyzed >= 1);
  assert.equal(counters.pending, counters.total - counters.analyzed);
  // Архивный пункт вне окна анализа в счётчики не входит: он и не будет разобран.
  storeHandle().exec(`UPDATE items SET published = '${isoFromMs(Date.now() - 10 * DAY)}', analyzed = 0 WHERE id = ${rows[0].id}`);
  const afterArchive = analyzeStats();
  assert.equal(afterArchive.total, counters.total - 1);
  const stored = storeHandle().raw.prepare('SELECT gist, importance, topics FROM items WHERE id = ?').get(rows[0].id);
  assert.equal(stored.gist, 'выжимка');
  assert.equal(Number(stored.importance), 4);
  assert.deepEqual(JSON.parse(stored.topics), ['тест']);
});

test('метки планировщика: state и слоты не теряются', () => {
  assert.equal(getState('last_collect_at'), null);
  setState('last_collect_at', '2026-11-10T06:00:00Z');
  assert.equal(getState('last_collect_at'), '2026-11-10T06:00:00Z');
  assert.equal(slotSent('2026-11-10T09:00'), false);
  markSlotSent('2026-11-10T09:00', 7);
  assert.equal(slotSent('2026-11-10T09:00'), true);
});

test('поиск по ленте находит по заголовку и не находит мусор', async () => {
  const source = await freshSource('search');
  await insertItem(source.id, { url: 'https://ex.com/gold', title: 'Золото обновило максимум', published: isoNow(), text: 'цена золота растёт' });
  const found = searchItems(CHAT, 'золото');
  assert.ok(found.some((row) => row.url === 'https://ex.com/gold'));
  assert.equal(searchItems(CHAT, 'нетакогослова').length, 0);
});

test('интересы, история и статистика источников', async () => {
  await setInterests(CHAT, 'золото, ФРС');
  assert.equal(await getInterests(CHAT), 'золото, ФРС');
  const counts = sourceCounts(CHAT, Date.now() - DAY);
  assert.equal(counts.length, listSources(CHAT).length);
  assert.ok(counts.every((row) => typeof row.total === 'number'));
  const summary = await stats(CHAT);
  assert.equal(summary.sources, listSources(CHAT).length);
  assert.ok(summary.items >= 1);
});

test('поиск ограничен сроком хранения: архивный пункт не висит в выдаче как найденный', async () => {
  const source = await freshSource('search-window');
  await insertItem(source.id, { url: 'https://ex.com/sw/old', title: 'Архивная платина', text: 'старое', published: isoFromMs(Date.now() - 20 * DAY) });
  await insertItem(source.id, { url: 'https://ex.com/sw/new', title: 'Свежая платина', text: 'новое', published: isoNow() });
  const found = searchItems(CHAT, 'платина');
  assert.ok(found.some((row) => row.url === 'https://ex.com/sw/new'), 'свежий пункт находится');
  assert.ok(!found.some((row) => row.url === 'https://ex.com/sw/old'), 'пункт старше окна хранения не выдаётся');
});
