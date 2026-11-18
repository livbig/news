// Сбор ленты: быстрый шаг, укладывается в лимит вызова (замер: 13 источников ≈ 0.7 с).
// Вызывается воркером через `tgcloud run endpoints/collect` или ботом напрямую.
import { collectAll } from '../lib/collect.js';
import { listActiveSources, retentionPass, setJob } from '../lib/store.js';
import { loadConfig } from '../lib/config.js';

export default async function collect(input = {}) {
  const chatId = Number(input.chatId);
  if (!chatId) throw new Error('collect: нужен chatId');
  const config = await loadConfig();

  // Ленивый retention вместо cron (D47): дешёвый проход в начале сбора.
  let retention = { itemsRemoved: 0 };
  try {
    retention = await retentionPass(chatId, config.retention);
  } catch (error) {
    console.warn('retention:', error?.message ?? error);
  }

  // Партии: сеть медленная (зеркало канала до 12 с), вызов живёт 30 с — воркер
  // зовёт сбор по типам и по offset/limit, пока не соберёт всё.
  const all = await listActiveSources(chatId);
  const pool = input.kind ? all.filter((row) => row.kind === input.kind) : all;
  // html собирается как обычный источник (lib/html.js) — неподдерживаемых типов нет.
  const unsupported = [];
  const offset = Number(input.offset) || 0;
  const limit = Math.min(Number(input.limit) || 8, 12);
  const batch = pool.slice(offset, offset + limit);
  const result = await collectAll(batch);
  const remaining = Math.max(0, pool.length - (offset + batch.length));

  if (input.jobId) {
    await setJob(Number(input.jobId), { stage: 'collected', detail: `+${result.added} из ${batch.length}, осталось ${remaining}` });
  }
  return JSON.stringify({
    sources: batch.length,
    added: result.added,
    remaining,
    errors: result.errors.map((e) => e.url),
    partial: result.partial.map((p) => p.url),
    unsupported,
    retentionRemoved: retention.itemsRemoved,
  });
}
