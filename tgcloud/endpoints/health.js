// Диагностика: жив ли Bot API для нашего токена и что лежит в БД.
import { botApi } from '../lib/telegram.js';
import { getFsm, getInterests, latestJob, listActiveSources } from '../lib/store.js';
import { interestFsmKey } from '../lib/interests.js';
import { fetch } from 'sdk';
import { parseHtmlList } from '../lib/html.js';

export default async function health(input = {}) {
  const me = await botApi('getMe');
  const chatId = Number(input.chatId) || 0;
  const list = chatId ? await listActiveSources(chatId) : [];
  // probeUrl — диагностика источника с платформы: что именно приходит на её IP.
  let probe = null;
  if (input.probeUrl) {
    try {
      const response = await fetch(String(input.probeUrl), { method: 'GET', headers: { 'user-agent': 'personal-news-digest/2.0' } });
      const body = (await response.text()).slice(0, 800000);
      const items = parseHtmlList(body, { baseUrl: String(input.probeUrl) });
      probe = { status: response.status, bytes: body.length, items: items.length, first: items[0]?.title?.slice(0, 80) ?? null, head: body.slice(0, 120).replace(/\s+/g, ' ') };
    } catch (error) {
      probe = { error: String(error?.message ?? error).slice(0, 200) };
    }
  }
  return JSON.stringify({
    bot: me.username,
    botId: me.id,
    sources: list.length,
    // id и url нужны для адресных операций (удаление/выключение) без доступа к БД
    list: list.map((row) => ({ id: row.id, kind: row.kind, url: row.url, enabled: row.enabled })),
    job: chatId ? await latestJob(chatId) : null,
    // Диагностика интересов: профиль и отложенное предложение живут в БД, без них
    // не понять, почему кнопка «Добавить» ответила «уже добавлено».
    interestsText: chatId ? await getInterests(chatId) : null,
    fsm: chatId ? await getFsm(interestFsmKey(chatId)) : null,
    probe,
  });
}
