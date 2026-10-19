import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

// Схема news на платформенной SQLite (перенос docs/plan.md §1.2).
// Внешние ключи платформой запрещены (PRAGMA foreign_keys off, объявление
// REFERENCES падает при деплое) — каскады делает код (lib/store.js).
// Даты — ISO-строки (как в Python-версии), время — unix-секунды в created_at_ts
// там, где нужна сортировка.

export const users = table('users', {
  chatId: integer('chat_id').primaryKey(),
  tzOffsetMin: integer('tz_offset_min').notNull().default(180),
  sendTimes: text('send_times').notNull().default('["09:00"]'),
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
    origin: text('origin').notNull().default('survey'),
    enabled: integer('enabled').notNull().default(1),
    status: text('status').notNull().default('ok'),
    statusMsg: text('status_msg'),
    lastPostId: integer('last_post_id').notNull().default(0),
    addedAt: text('added_at').notNull(),
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
    gist: text('gist'),
    published: text('published').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    urlHash: text('url_hash').notNull(),
  },
  (t) => ({
    publishedIdx: index('idx_items_published').on(t.published),
    // iter-21 разбор: без этого индекса дедуп по (source_id, url_hash) сканирует таблицу
    uniqIdx: uniqueIndex('uniq_items_source_hash').on(t.sourceId, t.urlHash),
    unreadIdx: index('idx_items_source').on(t.sourceId, t.id),
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

export const chatHistory = table(
  'chat_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    role: text('role').notNull(),
    text: text('text').notNull(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  (t) => ({
    chatIdx: index('idx_chat_history_chat').on(t.chatId, t.id),
  }),
);

// FSM онбординга: между инвокациями память не сохраняется, состояние живёт здесь.
export const fsm = table('fsm', {
  key: text('key').primaryKey(),
  state: text('state'),
  data: text('data'),
  updatedAt: text('updated_at').notNull(),
});

// Задачи сводки: тяжёлый LLM живёт вне платформы (лимит вызова 30 с, замер iter-25),
// поэтому состояние задачи хранится здесь и переживает инвокации.
export const jobs = table(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    status: text('status').notNull().default('queued'), // queued|running|done|failed
    stage: text('stage'),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    chatIdx: index('idx_jobs_chat').on(t.chatId, t.id),
  }),
);

// Надгробия удалённых по retention пунктов: повторная вставка отбивается (D47).
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
