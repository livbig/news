// Прямой Bot API новостного бота: отправка сводок, служебные вызовы, состояние вебхука.
// На платформе ответы шли с токеном из сгенерированного файла; на Pi — из окружения.

import { loadConfig } from './config.js';
import { chunkMessage, repairAnchors } from './text.js';

export async function botApi(method, body = {}, { token = null, timeoutMs = 30_000 } = {}) {
  const config = loadConfig();
  const botToken = token ?? config.botToken;
  if (!botToken) throw new Error('NEWS_BOT_TOKEN не задан (EnvironmentFile /etc/news/news.env)');
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(`telegram ${method}: ${data.error_code ?? response.status} ${data.description ?? ''}`.trim());
  return data.result;
}

/** Починить ссылки перед отправкой: у <a> оставляем только href, кривые теги разворачиваем. */
const fixed = (chunk) => (typeof repairAnchors === 'function' ? repairAnchors(chunk) : chunk);

/** То же, что sendHtml, но возвращает id отправленных сообщений (для удаления). */
export async function sendHtmlIds(chatId, text, limit = 4000) {
  const chunks = chunkMessage(text, limit).map(fixed);
  const ids = [];
  for (const chunk of chunks) {
    const id = (await sendOne(chatId, chunk, 'HTML')) || (await sendOne(chatId, plainText(chunk), null));
    if (id) ids.push(id);
  }
  return ids;
}

/** Отправка длинного HTML: режем по 4000, при отказе разметки повторяем без parse_mode. */
export async function sendHtml(chatId, text, limit = 4000) {
  const chunks = chunkMessage(text, limit).map(fixed);
  let sent = 0;
  for (const chunk of chunks) {
    const ok = (await sendOne(chatId, chunk, 'HTML')) || (await sendOne(chatId, plainText(chunk), null));
    if (ok) sent += 1;
    else console.warn(`sendHtml: кусок ${sent + 1} из ${chunks.length} не ушёл`);
  }
  return sent;
}

async function sendOne(chatId, chunk, parseMode) {
  try {
    const body = { chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true } };
    if (parseMode) body.parse_mode = parseMode;
    const message = await botApi('sendMessage', body);
    return message?.message_id ?? true;
  } catch (error) {
    console.warn(`sendMessage (${parseMode ?? 'plain'}):`, error?.message ?? error);
    return false;
  }
}

/** Откат без разметки: теги снимаем, иначе владелец видит «<b>Сводка</b>» вместо текста. */
const plainText = (text) => String(text ?? '').replace(/<[^>]+>/g, '');

export async function getMe(token) {
  return botApi('getMe', {}, { token });
}

export async function getWebhookInfo(token) {
  return botApi('getWebhookInfo', {}, { token });
}

/** Переход на long polling: иначе Telegram не отдаёт апдейты мосту (409 Conflict). */
export async function deleteWebhook(token) {
  return botApi('deleteWebhook', { drop_pending_updates: false }, { token });
}

/** Удалить свои сообщения (бот может удалять только отправленное им, и только по id). */
export async function deleteMessages(chatId, messageIds) {
  const ids = (messageIds ?? []).map(Number).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return false;
  await botApi('deleteMessages', { chat_id: chatId, message_ids: ids });
  return true;
}

/**
 * Настоящий квиз-опрос Telegram: пользователь отвечает, Telegram сам показывает «верно/неверно».
 * correct_option_id — индекс с нуля; explanation — разбор после ответа.
 */
export async function sendQuiz(chatId, { question, options, correctIndex = 0, explanation = '', silent = true }, { timeoutMs = 20_000 } = {}) {
  const body = {
    chat_id: chatId,
    question: String(question).slice(0, 255),
    options: (options ?? []).map((option) => ({ text: String(option).slice(0, 100) })),
    type: 'quiz',
    correct_option_id: Number(correctIndex),
    is_anonymous: false,
    disable_notification: Boolean(silent),
    allow_sending_without_reply: true,
  };
  if (explanation) body.explanation = String(explanation).slice(0, 200);
  const message = await botApi('sendPoll', body, { timeoutMs });
  return message?.message_id ?? true;
}
