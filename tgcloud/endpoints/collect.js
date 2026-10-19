// Сбор ленты: быстрый шаг, укладывается в лимит вызова (замер: 13 источников ≈ 0.7 с).
// Вызывается воркером через `tgcloud run endpoints/collect` или ботом напрямую.
import { collectAll } from '../lib/collect.js';
import { listActiveSources, setJob } from '../lib/store.js';

export default async function collect(input = {}) {
  const chatId = Number(input.chatId);
  if (!chatId) throw new Error('collect: нужен chatId');
  const sources = await listActiveSources(chatId);
  const result = await collectAll(sources);
  if (input.jobId) await setJob(Number(input.jobId), { stage: 'collected', detail: `+${result.added} из ${sources.length}` });
  return JSON.stringify({
    sources: sources.length,
    added: result.added,
    errors: result.errors.map((e) => e.url),
    partial: result.partial.map((p) => p.url),
  });
}
