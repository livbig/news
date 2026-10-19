// Единая точка входа бота: гейт → интент → действие.
// Сводка выполняется воркером (GitHub Actions): мега-вызов effort=max идёт 264 с,
// а инвокация платформы живёт 30 с (замер 2026-10-19, docs/tgcloud-migration.md §9).
// Здесь — мгновенные шаги: задача в БД, запуск воркера, ответ пользователю.

import { botApi } from '../lib/telegram.js';
import { gate, loadConfig } from '../lib/config.js';
import { route } from '../lib/intents.js';
import { EMPTY_TEXT, composeDigest, digestWindow, formatItemsInput, periodHeader, selectPending } from '../lib/digest.js';
import { LlmError, ask, summarize } from '../lib/llm.js';
import { collectAll } from '../lib/collect.js';
import * as store from '../lib/store.js';
import { chunkMessage, escapeHtml, isoFromMs, isoNow, plural } from '../lib/text.js';
import { helpText, settingsText, sourcesText, statsText } from '../lib/render.js';

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
      await runDigest(chatId);
      return;
    }
    await answerQuestion(chatId, text);
  } catch (error) {
    console.error('handler упал:', error?.stack ?? error);
    await send(chatId, `⚠️ Ошибка: ${escapeHtml(String(error?.message ?? error)).slice(0, 300)}`);
  }
}

async function handleCommand(chatId, { command }) {
  const config = await loadConfig();
  if (command === 'start') {
    const interests = await store.getInterests(chatId);
    const hint = interests
      ? 'Напиши «сводка» (или просто «ну как там») — соберу новости с прошлой сводки.'
      : 'Напиши «сводка» — соберу новости с прошлой сводки (не больше 7 дней).';
    await send(chatId, `🧿 <b>Агрегатор</b>\n\n${hint}`);
    await send(chatId, helpText(config.sources.max));
    return;
  }
  if (command === 'digest') {
    await runDigest(chatId);
    return;
  }
  if (command === 'stats') {
    const data = await store.stats(chatId);
    const job = await store.latestJob(chatId);
    const tail = job ? `\nПоследняя задача: ${job.status} (${job.stage ?? '—'}${job.detail ? `, ${escapeHtml(job.detail)}` : ''})` : '';
    await send(chatId, `${statsText(data)}${tail}`);
    return;
  }
  if (command === 'sources') {
    await send(chatId, sourcesText(await store.listSources(chatId)));
    return;
  }
  await send(chatId, command === 'help' ? helpText(config.sources.max) : settingsText());
}

/**
 * Сводка в момент запроса: сбор → отбор → LLM → отправка, всё в одном вызове.
 * Внешних исполнителей нет. Бюджет платформы (~30 с) делится явно: сбор упирается
 * в deadline, LLM идёт с меньшим усилием и компактным входом (config.inline).
 */
async function runDigest(chatId) {
  const config = await loadConfig();
  const budget = config.inline;
  const started = Date.now();
  const left = () => budget.hardDeadlineMs - (Date.now() - started);

  const running = await store.latestJob(chatId);
  if (running?.status === 'running' && Date.now() - Date.parse(running.updatedAt ?? '') < 10 * 60 * 1000) {
    await send(chatId, `⏳ Сводка уже собирается (задача ${running.id}). Дождись результата.`);
    return;
  }
  const jobId = await store.createJob(chatId);
  await store.setJob(jobId, { status: 'running', stage: 'collect' });

  const status = await statusHandle(chatId, '🔎 Собираю ленту…');
  await typing(chatId);
  try {
    // Ленивый retention вместо cron (D47): дешёвый проход, ошибки не валят сводку.
    await store.retentionPass(chatId, config.retention).catch((error) => console.warn('retention:', error?.message ?? error));

    const allSources = await store.listActiveSources(chatId);
    const sources = allSources.filter((row) => row.kind !== 'html');
    const unsupported = allSources.filter((row) => row.kind === 'html').map((row) => row.url);
    const collected = await collectAll(sources, { deadlineMs: Math.max(4000, Math.min(budget.collectDeadlineMs, left() - 14000)) });

    const window = digestWindow({ nowMs: Date.now(), lastSentAt: await store.getLastSentAt(chatId), windowDays: config.digest.windowDays, firstWindowHours: config.digest.firstWindowHours });
    const rows = await store.pendingRows(chatId, window.fromMs);
    const consumed = await store.consumedKeys(chatId);
    const { selected } = selectPending(rows, {
      perSource: budget.perSource,
      maxItems: budget.maxItems,
      maxChars: budget.maxChars,
      consumedUrls: consumed.urls,
      consumedTitles: consumed.titles,
    });
    const periodFrom = isoFromMs(window.fromMs);
    const periodTo = isoNow();

    if (!selected.length) {
      await status.close();
      const notes = [];
      if (collected.errors.length) notes.push(`⚠ Не удалось собрать ${collected.errors.length} источник(ов): ${collected.errors.map((e) => e.url).join(', ')}`);
      if (unsupported.length) notes.push(`ℹ️ Не собираются: ${unsupported.join(', ')}`);
      await send(chatId, [EMPTY_TEXT, ...notes].join('\n\n'));
      await store.setJob(jobId, { status: 'done', stage: 'empty', detail: 'новостей нет' });
      return;
    }

    if (left() < 12000) {
      await status.close();
      await send(chatId, `⏳ Собрал ${plural(selected.length, 'пункт', 'пункта', 'пунктов')}, но на анализ уже не хватает времени вызова. Напиши «сводка» ещё раз — новости сохранены и никуда не денутся.`);
      await store.setJob(jobId, { status: 'failed', stage: 'deadline', detail: 'не хватило бюджета на LLM' });
      return;
    }
    await status.set(`🧠 Думаю над ${plural(selected.length, 'пунктом', 'пунктами', 'пунктами')}…`);
    const summary = await summarize(formatItemsInput(selected, config.digest.textCap), await store.getInterests(chatId), null, {
      thinking: budget.thinking,
      maxTokens: budget.maxTokens,
    });
    const text = composeDigest({
      header: periodHeader(periodFrom, periodTo, config.tz.offsetMin),
      summary,
      capped: window.capped,
      errors: collected.errors,
      partial: collected.partial.map((p) => p.url),
      unsupported,
    });

    await status.set('✍️ Пишу сообщения…');
    const chunks = chunkMessage(text, config.digest.messageLimit);
    let sent = 0;
    for (const chunk of chunks) {
      const ok = await sendChunk(chatId, chunk, false) || await sendChunk(chatId, chunk, true);
      if (!ok) throw new Error(`не удалось отправить часть ${sent + 1} из ${chunks.length}`);
      sent += 1;
      if (sent === 1) await status.close();
    }
    await store.recordDigest(chatId, { periodFrom, periodTo, text, itemIds: selected.map((row) => row.id) });
    await store.appendHistory(chatId, 'assistant', text);
    await store.setJob(jobId, { status: 'done', stage: 'sent', detail: `${plural(selected.length, 'пункт', 'пункта', 'пунктов')}, ${plural(sent, 'сообщение', 'сообщения', 'сообщений')}` });
    console.log(`сводка: ${selected.length} пунктов, ${collected.added} новых, ${Math.round((Date.now() - started) / 1000)} c`);
  } catch (error) {
    await status.close();
    const reason = error instanceof LlmError ? error.message : String(error?.message ?? error);
    await store.setJob(jobId, { status: 'failed', stage: 'error', detail: reason.slice(0, 200) });
    await send(chatId, `⚠️ Сводка не удалась: ${escapeHtml(reason).slice(0, 400)}\n\nНовости не потеряны — они уйдут в следующую сводку.`);
  }
}

/** Отправка куска: сначала HTML, при отказе разметки — чистым текстом. */
async function sendChunk(chatId, text, plain) {
  const body = { chat_id: chatId, text: plain ? text.replace(/<[^>]+>/g, '') : text, link_preview_options: { is_disabled: true } };
  if (!plain) body.parse_mode = 'HTML';
  try {
    return Boolean(await botApi('sendMessage', body));
  } catch (error) {
    console.error('sendMessage:', error?.message ?? error);
    return false;
  }
}

/** Уточнения по темам и свободный диалог (R3): короткий вызов, влезает в инвокацию. */
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
  await botApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    .catch((error) => console.error('sendMessage:', error?.message ?? error));
}

async function typing(chatId) {
  await botApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

/** Сообщение-статус, которое дописывается по ходу работы (троттл ~1 запрос/сек). */
async function statusHandle(chatId, initial) {
  const message = await botApi('sendMessage', { chat_id: chatId, text: initial, disable_notification: true }).catch(() => null);
  const messageId = message?.message_id;
  let lastSent = Date.now();
  let lastText = initial;
  return {
    async set(text) {
      if (!messageId || text === lastText) return;
      if (Date.now() - lastSent < 1200) return;
      lastSent = Date.now();
      lastText = text;
      await botApi('editMessageText', { chat_id: chatId, message_id: messageId, text }).catch(() => {});
    },
    async close() {
      if (!messageId) return;
      await botApi('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
    },
  };
}
