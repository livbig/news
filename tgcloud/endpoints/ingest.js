// Запись сводки в БД платформы (без отправки в Telegram: отправляет воркер
// своим токеном бота — так сводка не зависит от Bot API-доступа платформы).
import { appendHistory, recordDigest, setJob } from '../lib/store.js';
import { plural } from '../lib/text.js';

export default async function ingest(input = {}) {
  const chatId = Number(input.chatId);
  const text = String(input.text ?? '').trim();
  if (!chatId) throw new Error('ingest: нужен chatId');
  if (!text) throw new Error('ingest: пустой текст сводки');

  const ids = Array.isArray(input.ids) ? input.ids.map(Number).filter(Boolean) : [];
  await recordDigest(chatId, {
    periodFrom: String(input.periodFrom ?? ''),
    periodTo: String(input.periodTo ?? ''),
    text,
    itemIds: ids,
  });
  await appendHistory(chatId, 'assistant', text);
  if (input.jobId) {
    await setJob(Number(input.jobId), {
      status: 'done',
      stage: 'sent',
      detail: `${plural(ids.length, 'пункт', 'пункта', 'пунктов')}, ${plural(Number(input.sent) || 0, 'сообщение', 'сообщения', 'сообщений')}`,
    });
  }
  return JSON.stringify({ recorded: ids.length });
}
