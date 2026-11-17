// Одноразовый перенос из Supabase (scripts/export-sources.py → этот эндпоинт).
// Идемпотентен: добавит только отсутствующие (UNIQUE chat_id+kind+url).
import { addSource, ensureUser, setInterestsIfEmpty } from '../lib/store.js';

export default async function importSources(input = {}) {
  const chatId = Number(input.chatId);
  if (!chatId) throw new Error('importSources: нужен chatId');
  await ensureUser(chatId);
  if (input.interests) await setInterestsIfEmpty(chatId, String(input.interests));
  let added = 0;
  for (const item of input.sources ?? []) {
    const result = await addSource(chatId, {
      kind: String(item.kind),
      url: String(item.url),
      title: String(item.title ?? item.url),
      topics: Array.isArray(item.topics) ? item.topics : [],
      origin: item.origin === 'survey' ? 'survey' : 'manual',
    });
    if (result.created) added += 1;
  }
  return JSON.stringify({ added, total: (input.sources ?? []).length });
}
