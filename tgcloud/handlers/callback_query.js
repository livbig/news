// Кнопки источников: включить/выключить, удалить, режим добавления.
import { botApi } from '../lib/telegram.js';
import { gate } from '../lib/config.js';
import { parseSourceCallback, sourcesView } from '../lib/sources-ui.js';
import * as store from '../lib/store.js';

export default async function onCallback(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id ?? callbackQuery?.from?.id;
  if (!(await gate(chatId))) return;

  const parsed = parseSourceCallback(callbackQuery?.data);
  if (!parsed) {
    await botApi('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Не понял команду' }).catch(() => {});
    return;
  }
  const { action, id } = parsed;
  let notice = '';

  if (action === 'add') {
    await store.setFsm(String(chatId), 'await_source', {});
    notice = 'Пришли ссылку (RSS/сайт) или @канал одним сообщением';
  } else if (action === 'toggle' && id) {
    const list = await store.listSources(chatId);
    const row = list.find((item) => item.id === id);
    if (row) {
      await store.setSourceEnabled(id, chatId, Number(row.enabled) !== 1);
      notice = Number(row.enabled) === 1 ? 'Выключил источник' : 'Включил источник';
    }
  } else if (action === 'del' && id) {
    const removed = await store.deleteSource(id, chatId);
    notice = removed ? 'Удалил источник' : 'Источник не найден';
  }

  await botApi('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: notice }).catch(() => {});
  const view = sourcesView(await store.listSources(chatId));
  await botApi('editMessageText', {
    chat_id: chatId,
    message_id: callbackQuery.message?.message_id,
    text: view.text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: view.keyboard },
  }).catch((error) => console.error('editMessageText:', error?.message ?? error));
}
