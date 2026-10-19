// Нажатия кнопок. Пока роутер клавиатур не перенесён (следующий срез), кнопок нет —
// но обработчик обязателен: без него Telegram считает бота зависшим на старых сообщениях.

import { botApi } from '../lib/telegram.js';
import { gate } from '../lib/config.js';

export default async function onCallback(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id ?? callbackQuery?.from?.id;
  if (!(await gate(chatId))) return;
  await botApi('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Кнопки появятся позже' }).catch(() => {});
}
