// Слой БД (замена bot/db.py): платформенная SQLite через sdk/db.
// Каскадов нет (FK запрещены) — удаление источника чистит items/seen_hashes руками.
// Транзакций в SDK нет: порядок операций важнее атомарности, last_sent_at пишем последним.

import { db } from 'sdk';
import { and, asc, desc, eq, gte, inArray, lt } from 'sdk/db';
import { chatHistory, digestItems, digests, fsm, items, jobs, seenHashes, sources, users } from '../schema.js';
import { isoFromMs, isoNow, normalizeTitle, urlHash } from './text.js';
import { PROFILE_LIMIT, googleNewsUrl, interestSourceTitle, interestSourcesFor, parseTopics, removeInterestTerm } from './interests.js';

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

/** «↩️ Вернуть»: профиль и источники из снимка в fsm (FR-6).
 * ponytail: откат кладёт профиль из снимка, а не мержит с текущим; окно 10 минут,
 * усложнять — если после удаления успевают появиться другие правки. */
export async function restoreInterest(chatId, snapshot) {
  if (!snapshot?.profile && !snapshot?.sources?.length) return 0;
  await setInterests(chatId, snapshot.profile ?? '');
  let restored = 0;
  for (const row of snapshot.sources ?? []) {
    const result = await addSource(chatId, { kind: row.kind, url: row.url, title: row.title, topics: row.topics ?? [], origin: row.origin ?? 'interest' });
    if (result.created) restored += 1;
  }
  return restored;
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

/** Фиксация сводки: digests → digest_items → users.last_sent_at (последним: окно едет за фактом отправки).
 * Сводка за явный период якорь НЕ двигает (FR-2): иначе следующая неявная сводка
 * начнётся с конца периода и пропустит более свежее. */
export async function recordDigest(chatId, { periodFrom, periodTo, text, itemIds }, { moveAnchor = true } = {}) {
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
  if (moveAnchor) await db.update(users).set({ lastSentAt: periodTo }).where(eq(users.chatId, chatId)).run();
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

export async function retentionPass(chatId, { itemsDays = 10, days = 30 } = {}, maxRows = 300) {
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
      .limit(maxRows)
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
