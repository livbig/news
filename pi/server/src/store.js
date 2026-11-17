// Слой БД: тот же код, что работал на платформе, но поверх node:sqlite (db.js).
// Каскадов нет (FK запрещены) — удаление источника чистит items/seen_hashes руками.
// Транзакций в SDK нет: порядок операций важнее атомарности, last_sent_at пишем последним.

import { and, asc, desc, eq, gte, inArray, lt, openDatabase } from './db.js';
import { digestItems, digests, items, seenHashes, sources, state, users } from './schema.js';
import { isoFromMs, isoNow, normalizeTitle, urlHash } from './text.js';
import { PROFILE_LIMIT, googleNewsUrl, interestSourceTitle, interestSourcesFor, parseTopics, removeInterestTerm } from './interests.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Единственная точка открытия базы: сервис, тесты и скрипты идут через неё. */
let db;
export function openStore(path) {
  db = openDatabase(path);
  return db;
}
export function storeHandle() {
  if (!db) throw new Error('store: база не открыта — вызовите openStore(path)');
  return db;
}

export async function ensureUser(chatId) {
  const existing = await db.select().from(users).where(eq(users.chatId, chatId)).get();
  if (existing) return existing;
  await db.insert(users).values({ chatId, createdAt: isoNow() }).run();
  return db.select().from(users).where(eq(users.chatId, chatId)).get();
}

export async function getInterests(chatId) {
  const row = await db.select({ interestsText: users.interestsText }).from(users).where(eq(users.chatId, chatId)).get();
  return row?.interestsText ?? null;
}

/** Профиль интересов целиком: лимит 4000 символов (FR-5). Переполненный не пишется. */
export async function setInterests(chatId, text) {
  const value = String(text ?? '').trim();
  if (value.length > PROFILE_LIMIT) return false;
  await db.update(users).set({ interestsText: value || null }).where(eq(users.chatId, chatId)).run();
  return true;
}

/** Пояс читателя для периода: users.tz_offset_min, не константа в коде (FR-1).
 * 0 — это UTC, а не «пустое значение»: `Number(tz) || 180` превращал его в московское время. */
export async function getTzOffsetMin(chatId) {
  const row = await db.select({ tz: users.tzOffsetMin }).from(users).where(eq(users.chatId, chatId)).get();
  const value = row?.tz;
  if (value == null || value === '') return 180;
  const tz = Number(value);
  return Number.isFinite(tz) ? tz : 180;
}

/** Профиль интересов переносим только если на платформе его ещё нет. */
export async function setInterestsIfEmpty(chatId, text) {
  const current = await getInterests(chatId);
  if (current?.trim()) return false;
  await db.update(users).set({ interestsText: String(text).slice(0, 4000) }).where(eq(users.chatId, chatId)).run();
  return true;
}

// --- источники -------------------------------------------------------------------

export const listSources = (chatId) =>
  db.select().from(sources).where(eq(sources.chatId, chatId)).orderBy(asc(sources.id)).all();

export const listActiveSources = (chatId) =>
  db
    .select()
    .from(sources)
    .where(and(eq(sources.chatId, chatId), eq(sources.enabled, 1)))
    .orderBy(asc(sources.id))
    .all();

export async function addSource(chatId, { kind, url, title, topics = [], origin = 'manual' }) {
  const existing = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.chatId, chatId), eq(sources.kind, kind), eq(sources.url, url)))
    .get();
  if (existing) return { id: existing.id, created: false };
  const inserted = await db
    .insert(sources)
    .values({ chatId, kind, url, title, topics: JSON.stringify(topics), origin, addedAt: isoNow() })
    .returning()
    .run();
  return { id: inserted?.[0]?.id ?? null, created: true };
}

export const setSourceEnabled = (id, chatId, enabled) =>
  db.update(sources).set({ enabled: enabled ? 1 : 0 }).where(and(eq(sources.id, id), eq(sources.chatId, chatId))).run();

export const setSourceStatus = (id, status, statusMsg) =>
  db.update(sources).set({ status, statusMsg }).where(eq(sources.id, id)).run();

/** Удаление источника: сначала зависимые строки, потом сам источник (каскадов в SQLite нет). */
export async function deleteSource(id, chatId) {
  const owned = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.chatId, chatId)))
    .get();
  if (!owned) return false;
  await db.delete(items).where(eq(items.sourceId, id)).run();
  await db.delete(seenHashes).where(eq(seenHashes.sourceId, id)).run();
  await db.delete(sources).where(eq(sources.id, id)).run();
  return true;
}

// --- интересы и их источники (FR-6…FR-8) -----------------------------------------

/** Источники чата по термину интереса — уже отфильтрованные по origin и topics. */
export async function interestSources(chatId, term) {
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.chatId, chatId), eq(sources.origin, 'interest')))
    .all();
  return interestSourcesFor(term, rows);
}

/**
 * Создание источников под интересы: 1 термин = 1 Google News RSS (FR-8).
 * При достижении sources.max интерес всё равно пишется — источники нет, об этом скажем явно.
 */
export async function addInterestSources(chatId, terms, max = 100) {
  let count = (await listSources(chatId)).length;
  const created = [];
  const existing = [];
  const skipped = [];
  for (const term of terms ?? []) {
    if (count >= max) {
      skipped.push(term);
      continue;
    }
    const result = await addSource(chatId, {
      kind: 'rss',
      url: googleNewsUrl(term),
      title: interestSourceTitle(term),
      topics: [term],
      origin: 'interest',
    });
    if (result.created) {
      created.push(term);
      count += 1;
    } else {
      existing.push(term);
    }
  }
  return { created, existing, skipped };
}

/** Удаление интереса целиком: строка профиля + его источники с items и seen_hashes (FR-6).
 * В снимке для «Вернуть» — профиль ДО удаления: иначе откат вернёт источники без термина.
 * all — убрать все вхождения термина в профиле (текст «убери золото», P2-7). */
export async function removeInterest(chatId, term, all = false) {
  const current = String((await getInterests(chatId)) ?? '');
  const removed = removeInterestTerm(current, term, all);
  if (!removed.removed) return null;
  const rows = await interestSources(chatId, removed.removed);
  let removedSources = 0;
  for (const row of rows) {
    if (await deleteSource(row.id, chatId)) removedSources += 1;
  }
  await setInterests(chatId, removed.text);
  return {
    term: removed.removed,
    profile: current,
    removedSources,
    sources: rows.map((row) => ({ kind: row.kind, url: row.url, title: row.title, topics: parseTopics(row.topics), origin: row.origin })),
  };
}

// --- пункты ----------------------------------------------------------------------

/**
 * Вставка пункта с дедупом UNIQUE(source_id, url_hash) и надгробием seen_hashes (D19/D47).
 * @returns {Promise<boolean>} true — пункт новый
 */
/** Подготовка пункта: хеш считается асинхронно (WebCrypto) до транзакции. */
export async function prepareItem(entry) {
  const hash = await urlHash(entry.url, entry.title);
  return {
    url: entry.url,
    title: String(entry.title).slice(0, 500),
    text: entry.text ? String(entry.text).slice(0, 4000) : null,
    published: entry.published ?? isoNow(),
    urlHash: hash,
  };
}

/** Вставка пачки в одной транзакции: на SD-карте это разница «секунды» и «минуты». */
export async function insertItems(sourceId, entries) {
  const prepared = [];
  for (const entry of entries ?? []) prepared.push(await prepareItem(entry));
  if (!prepared.length) return 0;
  let added = 0;
  storeHandle().transaction(() => {
    for (const item of prepared) {
      if (insertPrepared(sourceId, item)) added += 1;
    }
  });
  return added;
}

function insertPrepared(sourceId, item) {
  const tomb = db
    .select({ urlHash: seenHashes.urlHash })
    .from(seenHashes)
    .where(and(eq(seenHashes.sourceId, sourceId), eq(seenHashes.urlHash, item.urlHash)))
    .get();
  if (tomb) return false;
  const dup = db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.sourceId, sourceId), eq(items.urlHash, item.urlHash)))
    .get();
  if (dup) return false;
  db.insert(items)
    .values({
      sourceId,
      url: item.url,
      title: item.title,
      text: item.text,
      enriched: item.text ? 1 : 0,
      published: item.published,
      fetchedAt: isoNow(),
      urlHash: item.urlHash,
    })
    .run();
  return true;
}

export async function insertItem(sourceId, entry) {
  const hash = await urlHash(entry.url, entry.title);
  const tomb = await db
    .select({ urlHash: seenHashes.urlHash })
    .from(seenHashes)
    .where(and(eq(seenHashes.sourceId, sourceId), eq(seenHashes.urlHash, hash)))
    .get();
  if (tomb) return false;
  const dup = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.sourceId, sourceId), eq(items.urlHash, hash)))
    .get();
  if (dup) return false;
  const text = entry.text ? String(entry.text).slice(0, 4000) : null;
  await db
    .insert(items)
    .values({
      sourceId,
      url: entry.url,
      title: entry.title.slice(0, 500),
      text,
      enriched: text ? 1 : 0,
      published: entry.published ?? isoNow(),
      fetchedAt: isoNow(),
      urlHash: hash,
    })
    .run();
  return true;
}

/** Кандидаты в сводку: пункты источников чата, отобранные за окно (fresh first). */
export async function pendingRows(chatId, windowStartMs, limit = 3000) {
  const owned = await db.select({ id: sources.id }).from(sources).where(eq(sources.chatId, chatId)).all();
  const ids = owned.map((row) => row.id);
  if (!ids.length) return [];
  return db
    .select({
      id: items.id,
      sourceId: items.sourceId,
      title: items.title,
      url: items.url,
      text: items.text,
      gist: items.gist,
      published: items.published,
      fetchedAt: items.fetchedAt,
    })
    .from(items)
    .where(and(inArray(items.sourceId, ids), gte(items.fetchedAt, isoFromMs(windowStartMs))))
    .orderBy(desc(items.published), desc(items.id))
    .limit(limit)
    .all();
}

/** Лента за период без учёта «уже отправлено»: контекст для вопросов по темам (R3).
 * upperMs — верхняя граница закрытого окна (P2-11): «что было по золоту с 1 октября»
 * не должно подмешивать сегодняшние пункты. Граница — по дате публикации, как в rowsInPeriod. */
export async function recentItems(chatId, sinceMs, limit = 40, upperMs = null) {
  const owned = await db.select({ id: sources.id }).from(sources).where(eq(sources.chatId, chatId)).all();
  const ids = owned.map((row) => row.id);
  if (!ids.length) return [];
  const clause = upperMs
    ? and(inArray(items.sourceId, ids), gte(items.fetchedAt, isoFromMs(sinceMs)), lt(items.published, isoFromMs(upperMs)))
    : and(inArray(items.sourceId, ids), gte(items.fetchedAt, isoFromMs(sinceMs)));
  return db
    .select({ title: items.title, url: items.url, text: items.text, gist: items.gist, published: items.published })
    .from(items)
    .where(clause)
    .orderBy(desc(items.published), desc(items.id))
    .limit(limit)
    .all();
}

/** Уже отправленные в сводки чата: URL и нормализованные заголовки (анти-дедуп, iter-19). */
export async function consumedKeys(chatId) {
  const rows = await db
    .select({ id: digests.id })
    .from(digests)
    .where(eq(digests.chatId, chatId))
    .orderBy(desc(digests.id))
    .limit(60)
    .all();
  const urls = new Set();
  const titles = new Set();
  if (!rows.length) return { urls, titles };
  const links = await db
    .select({ itemId: digestItems.itemId })
    .from(digestItems)
    .where(inArray(digestItems.digestId, rows.map((row) => row.id)))
    .all();
  const itemIds = links.map((row) => row.itemId);
  for (let i = 0; i < itemIds.length; i += 200) {
    const chunk = itemIds.slice(i, i + 200);
    const rowsItems = await db
      .select({ url: items.url, title: items.title })
      .from(items)
      .where(inArray(items.id, chunk))
      .all();
    for (const row of rowsItems) {
      if (row.url) urls.add(row.url);
      const key = normalizeTitle(row.title);
      if (key) titles.add(key);
    }
  }
  return { urls, titles };
}

/** Фиксация сводки: digests → digest_items. Окно обычной сводки больше не зависит
 * от last_sent_at: это всегда последние сутки, поэтому якорь не двигаем. */
export async function recordDigest(chatId, { periodFrom, periodTo, text, itemIds, kind = 'manual', slot = null }) {
  const inserted = await db
    .insert(digests)
    .values({ chatId, periodFrom, periodTo, itemCount: itemIds.length, messageText: text.slice(0, 200000), createdAt: isoNow(), kind, slot })
    .returning()
    .run();
  const digestId = inserted?.[0]?.id;
  if (!digestId) throw new Error('recordDigest: платформа не вернула id сводки');
  if (itemIds.length) {
    await db.insert(digestItems).values(itemIds.map((itemId) => ({ digestId, itemId }))).run();
  }
  return digestId;
}

/** Пункты последней сводки: пометка «те же пункты» (FR-3). */
export async function lastDigestItemIds(chatId) {
  const row = await db.select({ id: digests.id }).from(digests).where(eq(digests.chatId, chatId)).orderBy(desc(digests.id)).limit(1).get();
  if (!row) return [];
  const links = await db.select({ itemId: digestItems.itemId }).from(digestItems).where(eq(digestItems.digestId, row.id)).all();
  return links.map((link) => link.itemId);
}

/** Последняя сводка чата: контекст для «второй пункт», «подробнее» (R3). */
export async function lastDigest(chatId) {
  const row = await db
    .select({ text: digests.messageText, periodTo: digests.periodTo, createdAt: digests.createdAt })
    .from(digests)
    .where(eq(digests.chatId, chatId))
    .orderBy(desc(digests.id))
    .limit(1)
    .get();
  return row ?? null;
}

// --- retention (ленивый проход вместо cron, D47) ---------------------------------

export async function retentionPass(chatId, { itemsDays = 10, days = 30, tombDays = 60 } = {}, maxRows = 300) {
  let removed = 0;
  let tombsRemoved = 0;
  const now = Date.now();
  const itemsFloor = isoFromMs(now - itemsDays * DAY_MS);
  const floor = isoFromMs(now - days * DAY_MS);
  const tombFloor = isoFromMs(now - tombDays * DAY_MS);
  const owned = await db.select({ id: sources.id }).from(sources).where(eq(sources.chatId, chatId)).all();
  const ids = owned.map((row) => row.id);
  if (ids.length) {
    const old = await db
      .select({ id: items.id, sourceId: items.sourceId, urlHash: items.urlHash })
      .from(items)
      .where(and(inArray(items.sourceId, ids), lt(items.fetchedAt, itemsFloor)))
      .limit(maxRows)
      .all();
    // Одна транзакция: на SD-карте три записи на строку без неё — это секунды ожидания.
    storeHandle().transaction(() => {
      for (const row of old) {
        db.insert(seenHashes).values({ sourceId: row.sourceId, urlHash: row.urlHash, createdAt: isoNow() }).run();
        db.delete(digestItems).where(eq(digestItems.itemId, row.id)).run();
        db.delete(items).where(eq(items.id, row.id)).run();
        removed += 1;
      }
    });
  }
  if (ids.length) {
    // Надгробия (URL, которые уже уходили в сводку) нужны только пока жив пункт: без чистки
    // таблица растёт вечно и тормозит вставку на SD-карте.
    const gone = await db.raw.prepare('DELETE FROM seen_hashes WHERE source_id IN (SELECT id FROM sources WHERE chat_id = ?) AND created_at < ?').run(Number(chatId), tombFloor);
    tombsRemoved = Number(gone?.changes ?? 0);
  }
  return { itemsRemoved: removed, tombsRemoved };
}

export async function stats(chatId) {
  const owned = await db.select({ id: sources.id, status: sources.status }).from(sources).where(eq(sources.chatId, chatId)).all();
  const ids = owned.map((row) => row.id);
  const since = isoFromMs(Date.now() - DAY_MS);
  // Считаем на стороне SQLite: limit(5000) делал статистику враньём после 5000 пунктов.
  let itemCount = 0;
  let freshCount = 0;
  let digestCount = 0;
  if (ids.length) {
    try {
      itemCount = await db.$count(items, inArray(items.sourceId, ids));
      freshCount = await db.$count(items, and(inArray(items.sourceId, ids), gte(items.fetchedAt, since)));
    } catch (error) {
      console.warn('stats: $count недоступен, считаю выборкой:', error?.message ?? error);
      const all = await db.select({ id: items.id, fetchedAt: items.fetchedAt }).from(items).where(inArray(items.sourceId, ids)).all();
      itemCount = all.length;
      freshCount = all.filter((row) => String(row.fetchedAt) >= since).length;
    }
  }
  try {
    digestCount = await db.$count(digests, eq(digests.chatId, chatId));
  } catch {
    digestCount = (await db.select({ id: digests.id }).from(digests).where(eq(digests.chatId, chatId)).all()).length;
  }
  return {
    sources: owned.length,
    errors: owned.filter((row) => row.status === 'error').length,
    items: itemCount,
    fresh: freshCount,
    digests: digestCount,
  };
}


// --- планировщик, фронтенд и анализ (добавлено при переносе на Pi) -----------------

export function getState(key) {
  return db.select().from(state).where(eq(state.key, key)).get()?.value ?? null;
}

export function setState(key, value) {
  const existing = db.select({ key: state.key }).from(state).where(eq(state.key, key)).get();
  const payload = { key, value: String(value), updatedAt: isoNow() };
  if (existing) db.update(state).set({ value: payload.value, updatedAt: payload.updatedAt }).where(eq(state.key, key)).run();
  else db.insert(state).values(payload).run();
}

/** Все метки планировщика (для sentSlotKeys) — плоский список key/value. */
export function listState(prefix = '') {
  const rows = db.select({ key: state.key, value: state.value }).from(state).all();
  return prefix ? rows.filter((row) => String(row.key).startsWith(prefix)) : rows;
}

/** Отправленные слоты вида `slot:2026-11-11T09:00` — защита от двойной отправки. */
export const slotSent = (slotKey) => getState(`slot:${slotKey}`) !== null;
export const markSlotSent = (slotKey, digestId) => setState(`slot:${slotKey}`, String(digestId ?? ''));

export function getSource(id, chatId) {
  return db
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.chatId, chatId)))
    .get();
}

export function setSourceCollected(id, added) {
  db.update(sources).set({ lastCollectedAt: isoNow(), lastAdded: Number(added) || 0 }).where(eq(sources.id, id)).run();
}

/** Пункты, которые ещё не разобраны анализатором (gist/importance/topics). */
export function itemsToAnalyze(limit = 40, olderThanMs = 0, tooOldMs = 3 * 24 * 60 * 60 * 1000) {
  // Разбираем только свежее: анализ архивного пункта не попадёт в сводку и сожжёт токены.
  const fresh = gte(items.published, isoFromMs(Date.now() - tooOldMs));
  const clause = olderThanMs
    ? and(eq(items.analyzed, 0), fresh, lt(items.fetchedAt, isoFromMs(Date.now() - olderThanMs)))
    : and(eq(items.analyzed, 0), fresh);
  return db
    .select({ id: items.id, title: items.title, url: items.url, text: items.text, published: items.published })
    .from(items)
    .where(clause)
    .orderBy(desc(items.published), desc(items.id))
    .limit(limit)
    .all();
}

export function saveAnalysis(id, { gist, importance = 0, topics = [] }) {
  db.update(items)
    .set({
      gist: String(gist ?? '').slice(0, 1500) || null,
      importance: Number.isFinite(Number(importance)) ? Number(importance) : 0,
      topics: JSON.stringify(topics ?? []),
      analyzed: 1,
    })
    .where(eq(items.id, id))
    .run();
}

/** Запись анализа пачкой: одна транзакция на батч вместо 40 fsync на SD-карту. */
export function saveAnalysisBatch(rows) {
  if (!rows?.length) return 0;
  storeHandle().transaction(() => {
    for (const row of rows) saveAnalysis(row.id, row);
  });
  return rows.length;
}

/** Текстовый поиск по ленте: заголовок, выжимка, текст. Для инструмента агента и фронтенда.
 * SQLite LIKE не понижает кириллицу, поэтому нормализуем и фильтруем в JS —
 * на десятках тысяч пунктов это дешевле, чем колонка-дубль для FTS. */
const SEARCH_WINDOW_DAYS = 10; // столько же, сколько живёт пункт (retentionPass.itemsDays)

export function searchItems(chatId, query, limit = 20) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2)
    .slice(0, 5);
  if (!words.length) return [];
  const rows = db.raw
    .prepare(
      `SELECT i.id, i.title, i.url, i.gist, i.published, i.importance, i.source_id AS sourceId
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE s.chat_id = ? AND s.enabled = 1 AND i.published >= ?
       ORDER BY i.published DESC, i.id DESC LIMIT 5000`,
    )
    .all(Number(chatId), isoFromMs(Date.now() - SEARCH_WINDOW_DAYS * DAY_MS));
  const haystack = (row) => `${row.title ?? ''} ${row.gist ?? ''}`.toLowerCase();
  return rows.filter((row) => words.every((word) => haystack(row).includes(word))).slice(0, Number(limit));
}

/** Сводки для фронтенда: без гигантского message_text в списке. */
export function listDigests(chatId, limit = 30, offset = 0) {
  return db
    .select({ id: digests.id, periodFrom: digests.periodFrom, periodTo: digests.periodTo, itemCount: digests.itemCount, createdAt: digests.createdAt, kind: digests.kind, slot: digests.slot })
    .from(digests)
    .where(eq(digests.chatId, chatId))
    .orderBy(desc(digests.id))
    .limit(limit)
    .offset(offset)
    .all();
}

export function getDigest(chatId, id) {
  return db
    .select()
    .from(digests)
    .where(and(eq(digests.chatId, chatId), eq(digests.id, id)))
    .get();
}

/** Счётчики по источникам за окно — для фронтенда и «/stats». */
export function sourceCounts(chatId, sinceMs) {
  const sqlText = `SELECT s.id, s.title, s.kind, s.url, s.enabled, s.status, s.status_msg AS statusMsg,
      s.last_collected_at AS lastCollectedAt,
      (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS total,
      (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.fetched_at >= ?) AS fresh
     FROM sources s WHERE s.chat_id = ? ORDER BY s.id`;
  return db.raw.prepare(sqlText).all(isoFromMs(sinceMs), Number(chatId));
}

/** Счётчики анализа. pending считается по тому же окну, что и itemsToAnalyze (3 дня):
 * иначе архивные пункты, которые уже не разбираются, висели бы в «не разобрано» вечно. */
export function analyzeStats(tooOldMs = 3 * 24 * 60 * 60 * 1000) {
  const raw = db.raw;
  const floor = isoFromMs(Date.now() - tooOldMs);
  const total = Number(raw.prepare('SELECT COUNT(*) AS c FROM items WHERE published >= ?').get(floor)?.c ?? 0);
  const analyzed = Number(raw.prepare('SELECT COUNT(*) AS c FROM items WHERE analyzed = 1 AND published >= ?').get(floor)?.c ?? 0);
  return { total, analyzed, pending: total - analyzed };
}
