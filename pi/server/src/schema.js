// Схема news для node:sqlite. Один в один с платформенной (tgcloud/schema.js):
// store.js перенесён без переписывания. Добавлено то, чего на платформе не было:
// `state` (метки планировщика), анализ пунктов (importance/topics) и `digest_slots`
// (какой слот 09:00/21:00 уже отправлен — чтобы сводка не ушла дважды).

import { index, integer, table, text, uniqueIndex } from './db.js';

export const users = table('users', {
  chatId: integer('chat_id').primaryKey(),
  tzOffsetMin: integer('tz_offset_min').notNull().default(180),
  sendTimes: text('send_times').notNull().default('["09:00","21:00"]'),
  lastSentAt: text('last_sent_at'),
  interestsText: text('interests_text'),
  createdAt: text('created_at').notNull(),
  onboardedAt: text('onboarded_at'),
});

export const sources = table(
  'sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    kind: text('kind').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    topics: text('topics').notNull().default('[]'),
    origin: text('origin').notNull().default('manual'),
    enabled: integer('enabled').notNull().default(1),
    status: text('status').notNull().default('ok'),
    statusMsg: text('status_msg'),
    lastPostId: integer('last_post_id').notNull().default(0),
    addedAt: text('added_at').notNull(),
    lastCollectedAt: text('last_collected_at'),
    lastAdded: integer('last_added').notNull().default(0),
  },
  (t) => ({
    chatIdx: index('idx_sources_chat').on(t.chatId, t.enabled),
    uniqIdx: uniqueIndex('uniq_sources_chat_kind_url').on(t.chatId, t.kind, t.url),
  }),
);

export const items = table(
  'items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: integer('source_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    text: text('text'),
    enriched: integer('enriched').notNull().default(0),
    analyzed: integer('analyzed').notNull().default(0),
    gist: text('gist'),
    importance: integer('importance'),
    topics: text('topics'),
    published: text('published').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    urlHash: text('url_hash').notNull(),
  },
  (t) => ({
    publishedIdx: index('idx_items_published').on(t.published),
    uniqIdx: uniqueIndex('uniq_items_source_hash').on(t.sourceId, t.urlHash),
    unreadIdx: index('idx_items_source').on(t.sourceId, t.id),
    enrichedIdx: index('idx_items_enriched').on(t.analyzed),
  }),
);

export const digests = table(
  'digests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    periodFrom: text('period_from').notNull(),
    periodTo: text('period_to').notNull(),
    itemCount: integer('item_count').notNull(),
    messageText: text('message_text').notNull(),
    createdAt: text('created_at').notNull(),
    kind: text('kind').notNull().default('manual'),
    slot: text('slot'),
  },
  (t) => ({
    chatIdx: index('idx_digests_chat').on(t.chatId, t.createdAt),
  }),
);

export const digestItems = table(
  'digest_items',
  {
    digestId: integer('digest_id').notNull(),
    itemId: integer('item_id').notNull(),
  },
  (t) => ({
    digestIdx: uniqueIndex('uniq_digest_items').on(t.digestId, t.itemId),
    itemIdx: index('idx_digest_items_item').on(t.itemId),
  }),
);

export const seenHashes = table(
  'seen_hashes',
  {
    sourceId: integer('source_id').notNull(),
    urlHash: text('url_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    uniqIdx: uniqueIndex('uniq_seen_source_hash').on(t.sourceId, t.urlHash),
  }),
);

/** Метки планировщика: последний сбор, последний анализ, отправленные слоты. */
export const state = table('state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
