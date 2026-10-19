// Кнопки: интересы (int:*) и источники (src:*). Запись интересов — только здесь,
// после явного нажатия (FR-5, FR-10): текст сообщения сам по себе ничего не пишет.
import { botApi } from '../lib/telegram.js';
import { gate, loadConfig } from '../lib/config.js';
import { parseSourceCallback, sourcesView } from '../lib/sources-ui.js';
import { addInterestTerms, interestFsmKey, parseInterestCallback } from '../lib/interests.js';
import { escapeHtml } from '../lib/text.js';
import * as store from '../lib/store.js';

const FSM_TTL_MS = 10 * 60 * 1000;

export default async function onCallback(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id ?? callbackQuery?.from?.id;
  if (!(await gate(chatId))) return;

  const interest = parseInterestCallback(callbackQuery?.data);
  if (interest) {
    await handleInterest(chatId, callbackQuery, interest);
    return;
  }

  const parsed = parseSourceCallback(callbackQuery?.data);
  if (!parsed) {
    await answer(callbackQuery, 'Не понял команду');
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

  await answer(callbackQuery, notice);
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

/** Подтверждение/отмена предложения, выбор термина при неоднозначности, «Вернуть». */
async function handleInterest(chatId, callbackQuery, { action, index }) {
  // Интересы живут под своим ключом: иначе предложение интереса затирает ожидание ссылки (await_source).
  const fsmKey = interestFsmKey(chatId);
  const fsm = await store.getFsm(fsmKey);
  const fresh = Boolean(fsm) && Date.now() - Date.parse(fsm?.updatedAt ?? '') < FSM_TTL_MS;
  const data = fresh ? safeJson(fsm?.data) : {};

  if (action === 'cancel') {
    await store.clearFsm(fsmKey).catch(() => {});
    await answer(callbackQuery, 'Отменено');
    await edit(callbackQuery, chatId, '❌ Отменено, интересы не менялись.');
    return;
  }

  if (action === 'undo') {
    if (fsm?.state !== 'await_undo' || !fresh || !data.sources) {
      await answer(callbackQuery, 'Возвращать нечего');
      return;
    }
    const restored = await store.restoreInterest(chatId, data);
    await store.clearFsm(fsmKey).catch(() => {});
    await answer(callbackQuery, 'Вернул');
    await edit(callbackQuery, chatId, `↩️ Вернул: ${escapeHtml(data.term ?? '')} (источников восстановлено: ${restored})`);
    return;
  }

  if (action === 'pick') {
    const term = data.mode === 'remove' ? data.terms?.[index] : null;
    if (!fresh || !term) {
      await answer(callbackQuery, 'Выбор устарел');
      await edit(callbackQuery, chatId, '⚠️ Выбор устарел — повтори «убери <тема>».');
      return;
    }
    const snapshot = await store.removeInterest(chatId, term);
    if (!snapshot) {
      await answer(callbackQuery, 'Такого интереса нет');
      await edit(callbackQuery, chatId, `ℹ️ Такого интереса нет: ${escapeHtml(term)}.`);
      return;
    }
    await store.setFsm(fsmKey, 'await_undo', { term: snapshot.term, profile: snapshot.profile, sources: snapshot.sources });
    await answer(callbackQuery, 'Убрал');
    await edit(callbackQuery, chatId, `🗑 Убрал: ${escapeHtml(snapshot.term)} (источников удалено: ${snapshot.removedSources})`, [[{ text: '↩️ Вернуть', callback_data: 'int:undo' }]]);
    return;
  }

  // action === 'add': двойное нажатие второго раза не дублирует (FR-10).
  if (fsm?.state !== 'await_interest' || data.mode !== 'add' || !data.terms?.length) {
    await answer(callbackQuery, 'Уже добавлено');
    await edit(callbackQuery, chatId, 'ℹ️ Уже добавлено (или предложение устарело).');
    return;
  }
  const config = await loadConfig();
  const merged = addInterestTerms(await store.getInterests(chatId), data.terms);
  if (!merged.ok) {
    await answer(callbackQuery, 'Профиль заполнен');
    await edit(callbackQuery, chatId, `⚠️ ${escapeHtml(merged.reason)}`);
    return;
  }
  if (merged.added.length) await store.setInterests(chatId, merged.text);
  const created = await store.addInterestSources(chatId, merged.added, config.sources.max);
  await store.clearFsm(fsmKey).catch(() => {});

  const lines = [];
  lines.push(merged.added.length ? `✅ Добавил в интересы: ${merged.added.map((term) => escapeHtml(term)).join(', ')}` : 'ℹ️ Уже в интересах — ничего не менял.');
  if (created.created.length) lines.push(`Источники Google News: ${created.created.map((term) => escapeHtml(term)).join(', ')}.`);
  if (created.existing.length) lines.push(`Источник уже был: ${created.existing.map((term) => escapeHtml(term)).join(', ')}.`);
  // FR-8: при лимите интерес записывается, источники нет — говорим об этом прямо.
  if (created.skipped.length) lines.push(`⚠️ Лимит источников ${config.sources.max}: интерес записан, источники не созданы (${created.skipped.map((term) => escapeHtml(term)).join(', ')}). Удали лишние в /sources и повтори.`);
  await answer(callbackQuery, 'Готово');
  await edit(callbackQuery, chatId, lines.join('\n'));
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function answer(callbackQuery, text) {
  return botApi('answerCallbackQuery', { callback_query_id: callbackQuery?.id, text: String(text ?? '').slice(0, 190) }).catch(() => {});
}

function edit(callbackQuery, chatId, text, keyboard = null) {
  return botApi('editMessageText', {
    chat_id: chatId,
    message_id: callbackQuery?.message?.message_id,
    text,
    parse_mode: 'HTML',
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }).catch((error) => console.error('editMessageText:', error?.message ?? error));
}
