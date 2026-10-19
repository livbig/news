// Диагностика: жив ли Bot API для нашего токена и что лежит в БД.
import { botApi } from '../lib/telegram.js';
import { listActiveSources } from '../lib/store.js';

export default async function health(input = {}) {
  const me = await botApi('getMe');
  const chatId = Number(input.chatId) || 0;
  const sources = chatId ? (await listActiveSources(chatId)).length : 0;
  return JSON.stringify({ bot: me.username, botId: me.id, sources });
}
