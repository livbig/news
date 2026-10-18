// Единая точка входа бота: гейт → интент → работа с видимым прогрессом (R1/R2/R3).
// Сводка собирается по запросу: сбор и LLM идут в одном вызове, пользователь видит
// шаги «собираю → думаю → пишу», чтобы не гадать, завис ли бот.

import { api } from 'sdk';
import { gate, loadConfig } from '../lib/config.js';
import { route } from '../lib/intents.js';
import { collectAll } from '../lib/collect.js';
import {
  EMPTY_TEXT,
  coverageNote,
  degradedFooter,
  digestWindow,
  formatItemsInput,
  periodHeader,
  selectPending,
} from '../lib/digest.js';
import { LlmError, ask, summarize } from '../lib/llm.js';
import * as store from '../lib/store.js';
import { chunkMessage, escapeHtml, isoFromMs, isoNow, plural } from '../lib/text.js';
import { helpText, settingsText, sourcesText, statsText } from '../lib/render.js';

const THROTTLE_MS = 1200;

export default async function onMessage(message) {
  const chatId = message?.chat?.id;
  if (!(await gate(chatId))) return; // fail-closed: чужой чат не получает ничего
  if (message?.from?.is_bot) return;
  const text = String(message?.text ?? message?.caption ?? '').trim();
  if (!text) return;

  await store.ensureUser(chatId);
  const intent = route(text);
  try {
    if (intent.kind === 'command') {
      await handleCommand(chatId, intent);
      return;
    }
    if (intent.kind === 'digest') {
      await sendDigest(chatId);
      return;
    }
    await answerQuestion(chatId, text);
  } catch (error) {
    console.error('handler упал:', error?.stack ?? error);
    await send(chatId, `⚠️ Ошибка: ${escapeHtml(String(error?.message ?? error)).slice(0, 300)}`);
  }
}

async function handleCommand(chatId, { command }) {
  if (command === 'digest' || command === 'start') {
    if (command === 'start') {
      const config = await loadConfig();
      const interests = await store.getInterests(chatId);
      const hint = interests
        ? 'Напиши «сводка» (или просто «ну как там») — соберу новости с прошлой сводки.'
        : 'Напиши «сводка» — соберу новости с прошлой сводки. Позже добавим интервью о твоих интересах.';
      await send(chatId, `🧿 <b>Агрегатор</b>\n\n${hint}`);
      await send(chatId, helpText(config.sources.max));
      return;
    }
    await sendDigest(chatId);
    return;
  }
  if (command === 'stats') {
    const data = await store.stats(chatId);
    await send(chatId, statsText(data));
    return;
  }
  if (command === 'sources') {
    const list = await store.listSources(chatId);
    await send(chatId, sourcesText(list));
    return;
  }
  if (command === 'settings' || command === 'help' || command === 'stop') {
    const config = await loadConfig();
    await send(chatId, command === 'help' ? helpText(config.sources.max) : settingsText());
  }
}

async function sendDigest(chatId) {
  const config = await loadConfig();
  const started = Date.now();
  const status = await statusHandle(chatId, '🔎 Собираю ленту…');
  await typing(chatId);

  const sources = await store.listActiveSources(chatId);
  await status.set(`🔎 Собираю ${plural(sources.length, 'источник', 'источника', 'источников')}…`);
  const collected = await collectAll(sources);

  const lastSentAt = await store.getLastSentAt(chatId);
  const window = digestWindow({
    nowMs: Date.now(),
    lastSentAt,
    windowDays: config.digest.windowDays,
    firstWindowHours: config.digest.firstWindowHours,
  });
  const rows = await store.pendingRows(chatId, window.fromMs);
  const consumed = await store.consumedKeys(chatId);
  const { selected } = selectPending(rows, {
    perSource: config.digest.perSource,
    maxItems: config.digest.maxItems,
    maxChars: config.digest.maxChars,
    consumedUrls: consumed.urls,
    consumedTitles: consumed.titles,
  });
  const periodFrom = isoFromMs(window.fromMs);
  const periodTo = isoNow();

  if (!selected.length) {
    await status.close();
    const note = coverageNote({ capped: window.capped, missingSources: collected.partial });
    await send(chatId, `${EMPTY_TEXT}${note}${degradedFooter(collected.errors)}`);
    return;
  }

  await status.set(`🧠 Думаю над ${plural(selected.length, 'пунктом', 'пунктами', 'пунктами')} из ${plural(sources.length, 'источника', 'источников', 'источников')}… (это может занять несколько минут)`);
  await typing(chatId);

  let summary;
  try {
    summary = await summarize(formatItemsInput(selected, config.digest.textCap), await store.getInterests(chatId), (progress) => {
      status.set(`🧠 Думаю над сводкой… уже ${Math.round(progress.chars / 100) / 10} тыс. символов`);
    });
  } catch (error) {
    await status.close();
    const reason = error instanceof LlmError ? error.message : String(error?.message ?? error);
    await send(chatId, `⚠️ Сводка не удалась: ${escapeHtml(reason).slice(0, 400)}\n\nПопробуй ещё раз — новости никуда не денутся.`);
    return;
  }

  const header = periodHeader(periodFrom, periodTo, config.tz.offsetMin);
  const note = coverageNote({
    capped: window.capped,
    missingSources: collected.partial,
  });
  const full = `${header}\n\n${summary}${note}${degradedFooter(collected.errors)}`;
  const chunks = chunkMessage(full, config.digest.messageLimit);
  await status.set('✍️ Пишу сообщения…');
  for (let i = 0; i < chunks.length; i += 1) {
    await send(chatId, chunks[i]);
    if (i === 0) await status.close(); // первый кусок уже пришёл — статус больше не нужен
  }
  await store.recordDigest(chatId, {
    periodFrom,
    periodTo,
    text: full,
    itemIds: selected.map((row) => row.id),
  });
  await store.appendHistory(chatId, 'assistant', full);
  console.log(`сводка: ${selected.length} пунктов, ${collected.added} новых, ${Math.round((Date.now() - started) / 1000)} c`);
}

/** Уточнения по темам и свободный диалог (R3): контекст — накопленная лента за окно. */
async function answerQuestion(chatId, question) {
  const config = await loadConfig();
  const window = digestWindow({
    nowMs: Date.now(),
    lastSentAt: null,
    windowDays: config.digest.windowDays,
    firstWindowHours: config.digest.firstWindowHours,
  });
  const rows = await store.recentItems(chatId, window.fromMs, 40);
  const last = await store.lastDigest(chatId);
  const feed = rows
    .map((row) => `${escapeHtml(row.title)} — ${escapeHtml(row.url)}${row.gist ? `\nВЫЖИМКА: ${escapeHtml(row.gist)}` : ''}`)
    .join('\n\n');
  const context = last
    ? `Последняя сводка читателю (на неё могут ссылаться «второй пункт» и т.п.):\n${last.text}\n\nЛента за период:\n${feed}`
    : `Лента за период:\n${feed}`;
  const status = await statusHandle(chatId, '🧠 Думаю…');
  await typing(chatId);
  let answer;
  try {
    answer = await ask({ question, context: context || 'лента за период пуста', history: await store.recentHistory(chatId, 10) });
  } catch (error) {
    await status.close();
    const reason = error instanceof LlmError ? error.message : String(error?.message ?? error);
    await send(chatId, `⚠️ Не получилось ответить: ${escapeHtml(reason).slice(0, 300)}`);
    return;
  }
  await status.close();
  for (const chunk of chunkMessage(answer, config.digest.messageLimit)) await send(chatId, chunk);
  await store.appendHistory(chatId, 'user', question);
  await store.appendHistory(chatId, 'assistant', answer);
}

async function send(chatId, text) {
  await api
    .sendMessage({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    .catch((error) => console.error('sendMessage:', error?.message ?? error));
}

async function typing(chatId) {
  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
}

/** Сообщение-статус, которое дописывается по ходу работы (троттл ~1 запрос/сек). */
async function statusHandle(chatId, initial) {
  const message = await api
    .sendMessage({ chat_id: chatId, text: initial, disable_notification: true })
    .catch(() => null);
  const messageId = message?.message_id;
  let lastSent = Date.now();
  let lastText = initial;
  return {
    async set(text) {
      if (!messageId || text === lastText) return;
      if (Date.now() - lastSent < THROTTLE_MS) return;
      lastSent = Date.now();
      lastText = text;
      await api.editMessageText({ chat_id: chatId, message_id: messageId, text }).catch(() => {});
    },
    async close() {
      if (!messageId) return;
      await api.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => {});
    },
  };
}
