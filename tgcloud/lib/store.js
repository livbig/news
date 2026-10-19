// Слой БД (замена bot/db.py): платформенная SQLite через sdk/db.
// Каскадов нет (FK запрещены) — удаление источника чистит items/seen_hashes руками.
// Транзакций в SDK нет: порядок операций важнее атомарности, last_sent_at пишем последним.

import { db } from 'sdk';
import { and, asc, desc, eq, gte, inArray, lt } from 'sdk/db';
import { chatHistory, digestItems, digests, fsm, items, jobs, seenHashes, sources, users } from '../schema.js';
import { isoFromMs, isoNow, normalizeTitle, urlHash } from './text.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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

export async function getLastSentAt(chatId) {
  const row = await db.select({ lastSentAt: users.lastSentAt }).from(users).where(eq(users.chatId, chatId)).get();
  return row?.lastSentAt ?? null;
}

/** Профиль интересов переносим только если на платформе его ещё нет. */
export async function setInterestsIfEmpty(chatId, text) {
  const current = await getInterests(chatId);
  if (current?.trim()) return false;
  await db.update(users).set({ interestsText: String(text).slice(0, 4000) }).where(eq(users.chatId, chatId)).run();
  return true;
}

export async function markOnboarded(chatId) {
  await db.update(users).set({ onboardedAt: isoNow() }).where(eq(users.chatId, chatId)).run();
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

// --- пункты ----------------------------------------------------------------------

/**
 * Вставка пункта с дедупом UNIQUE(source_id, url_hash) и надгробием seen_hashes (D19/D47).
 * @returns {Promise<boolean>} true — пункт новый
 */
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

/** Лента за период без учёта «уже отправлено»: контекст для вопросов по темам (R3). */
export async function recentItems(chatId, sinceMs, limit = 40) {
  const owned = await db.select({ id: sources.id }).from(sources).where(eq(sources.chatId, chatId)).all();
  const ids = owned.map((row) => row.id);
  if (!ids.length) return [];
  return db
    .select({ title: items.title, url: items.url, text: items.text, gist: items.gist, published: items.published })
    .from(items)
    .where(and(inArray(items.sourceId, ids), gte(items.fetchedAt, isoFromMs(sinceMs))))
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

/** Фиксация сводки: digests → digest_items → users.last_sent_at (последним: окно едет за фактом отправки). */
export async function recordDigest(chatId, { periodFrom, periodTo, text, itemIds }) {
  const inserted = await db
    .insert(digests)
    .values({ chatId, periodFrom, periodTo, itemCount: itemIds.length, messageText: text.slice(0, 200000), createdAt: isoNow() })
    .returning()
    .run();
  const digestId = inserted?.[0]?.id;
  if (!digestId) throw new Error('recordDigest: платформа не вернула id сводки');
  if (itemIds.length) {
    await db.insert(digestItems).values(itemIds.map((itemId) => ({ digestId, itemId }))).run();
  }
  await db.update(users).set({ lastSentAt: periodTo }).where(eq(users.chatId, chatId)).run();
  return digestId;
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

export async function retentionPass(chatId, { itemsDays = 10, days = 30 } = {}) {
  let removed = 0;
  const now = Date.now();
  const itemsFloor = isoFromMs(now - itemsDays * DAY_MS);
  const floor = isoFromMs(now - days * DAY_MS);
  const owned = await db.select({ id: sources.id }).from(sources).where(eq(sources.chatId, chatId)).all();
  const ids = owned.map((row) => row.id);
  if (ids.length) {
    const old = await db
      .select({ id: items.id, sourceId: items.sourceId, urlHash: items.urlHash })
      .from(items)
      .where(and(inArray(items.sourceId, ids), lt(items.fetchedAt, itemsFloor)))
      .limit(2000)
      .all();
    for (const row of old) {
      await db.insert(seenHashes).values({ sourceId: row.sourceId, urlHash: row.urlHash, createdAt: isoNow() }).run();
      await db.delete(digestItems).where(eq(digestItems.itemId, row.id)).run();
      await db.delete(items).where(eq(items.id, row.id)).run();
      removed += 1;
    }
  }
  await db.delete(chatHistory).where(and(eq(chatHistory.chatId, chatId), lt(chatHistory.createdAt, floor))).run();
  return { itemsRemoved: removed };
}

// --- задачи сводки (тяжёлый LLM вне платформы) ------------------------------------

export async function createJob(chatId) {
  const inserted = await db
    .insert(jobs)
    .values({ chatId, status: 'queued', stage: 'created', createdAt: isoNow(), updatedAt: isoNow() })
    .returning()
    .run();
  return inserted?.[0]?.id ?? null;
}

export const setJob = (id, patch) =>
  db.update(jobs).set({ ...patch, updatedAt: isoNow() }).where(eq(jobs.id, id)).run();

export const getJob = (id) => db.select().from(jobs).where(eq(jobs.id, id)).get();

export async function latestJob(chatId) {
  return db.select().from(jobs).where(eq(jobs.chatId, chatId)).orderBy(desc(jobs.id)).limit(1).get();
}

// --- диалог и FSM ----------------------------------------------------------------

export const appendHistory = (chatId, role, text) =>
  db.insert(chatHistory).values({ chatId, role, text: String(text).slice(0, 4000), createdAt: isoNow() }).run();

export async function recentHistory(chatId, limit = 10) {
  const rows = await db
    .select({ role: chatHistory.role, text: chatHistory.text })
    .from(chatHistory)
    .where(eq(chatHistory.chatId, chatId))
    .orderBy(desc(chatHistory.id))
    .limit(limit)
    .all();
  return rows.reverse();
}

export const getFsm = (key) => db.select().from(fsm).where(eq(fsm.key, key)).get();

export async function setFsm(key, state, data = {}) {
  const existing = await getFsm(key);
  if (existing) {
    await db.update(fsm).set({ state, data: JSON.stringify(data), updatedAt: isoNow() }).where(eq(fsm.key, key)).run();
    return;
  }
  await db.insert(fsm).values({ key, state, data: JSON.stringify(data), updatedAt: isoNow() }).run();
}

export const clearFsm = (key) => db.delete(fsm).where(eq(fsm.key, key)).run();

export async function stats(chatId) {
  const owned = await db.select({ id: sources.id, status: sources.status }).from(sources).where(eq(sources.chatId, chatId)).all();
  const ids = owned.map((row) => row.id);
  const since = isoFromMs(Date.now() - DAY_MS);
  let itemCount = 0;
  let freshCount = 0;
  if (ids.length) {
    const all = await db.select({ id: items.id, fetchedAt: items.fetchedAt }).from(items).where(inArray(items.sourceId, ids)).limit(5000).all();
    itemCount = all.length;
    freshCount = all.filter((row) => String(row.fetchedAt) >= since).length;
  }
  const digestCount = await db.select({ id: digests.id }).from(digests).where(eq(digests.chatId, chatId)).limit(1000).all();
  return {
    sources: owned.length,
    errors: owned.filter((row) => row.status === 'error').length,
    items: itemCount,
    fresh: freshCount,
    digests: digestCount.length,
  };
}
