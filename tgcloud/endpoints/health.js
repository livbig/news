// Диагностика: жив ли Bot API для нашего токена и что лежит в БД.
import { botApi } from '../lib/telegram.js';
import { listActiveSources } from '../lib/store.js';

export default async function health(input = {}) {
  const me = await botApi('getMe');
  const chatId = Number(input.chatId) || 0;
  const list = chatId ? await listActiveSources(chatId) : [];
  return JSON.stringify({
    bot: me.username,
    botId: me.id,
    sources: list.length,
    // id и url нужны для адресных операций (удаление/выключение) без доступа к БД
    list: list.map((row) => ({ id: row.id, kind: row.kind, url: row.url, enabled: row.enabled })),
  });
}
