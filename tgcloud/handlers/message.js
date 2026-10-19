// Единая точка входа бота: гейт → интент → действие.
// Сводка считается здесь же, в одном вызове платформы (~30 с): сбор с дедлайном,
// отбор, LLM без мышления (17 с), отправка чанками. Внешних исполнителей нет.
// Бюджет и замеры — docs/tgcloud-migration.md §11.

import { botApi } from '../lib/telegram.js';
import { gate, loadConfig } from '../lib/config.js';
import { route } from '../lib/intents.js';
import { EMPTY_TEXT, composeDigest, digestWindow, formatItemsInput, periodHeader, selectPending } from '../lib/digest.js';
import { LlmError, ask, summarize } from '../lib/llm.js';
import { collectAll } from '../lib/collect.js';
import * as store from '../lib/store.js';
import { chunkMessage, escapeHtml, isoFromMs, isoNow, plural } from '../lib/text.js';
import { helpText, settingsText, statsText } from '../lib/render.js';
import { detectSource, sourcesView } from '../lib/sources-ui.js';

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
    // Ждём ссылку на источник, если пользователь нажал «Добавить».
    const fsm = await store.getFsm(String(chatId));
    const fsmFresh = fsm && Date.now() - Date.parse(fsm.updatedAt ?? '') < 10 * 60 * 1000;
    if (fsmFresh && fsm.state === 'await_source') {
      await addSourceFromInput(chatId, text);
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
    await sendSources(chatId);
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
  // Порог меньше максимального времени вызова (~30 с): убитая платформой задача
  // не должна блокировать следующие запросы (ревью 2026-10-19).
  const STALE_JOB_MS = 45 * 1000;
  if (running?.status === 'running' && Date.now() - Date.parse(running.updatedAt ?? '') < STALE_JOB_MS) {
    await send(chatId, `⏳ Сводка уже собирается (задача ${running.id}). Дождись результата.`);
    return;
  }
  const jobId = await store.createJob(chatId);
  await store.setJob(jobId, { status: 'running', stage: 'collect' });

  let sentChunks = 0;
  let totalChunks = 0;
  let jobDone = false;
  let slowPlan = []; // медленные источники: собираются после отправки сводки
  const status = await statusHandle(chatId, '🔎 Собираю ленту…');
  await typing(chatId);
  try {
    // Ленивый retention вместо cron (D47): дешёвый проход, ошибки не валят сводку.
    await store.retentionPass(chatId, config.retention).catch((error) => console.warn('retention:', error?.message ?? error));

    const allSources = await store.listActiveSources(chatId);
    // html собирается как обычный источник (lib/html.js) — неподдерживаемых типов больше нет,
    // но форма списка сохранена: футер сводки по-прежнему строится из него.
    const unsupported = [];
    // Ротация с приоритетом скорости: быстрые (rss/twitter) вперёд, медленные
    // (каналы через зеркало до 12 с, html-страницы до 7 с) — не больше двух за вызов.
    // Так вызов не выходит за 30 с, а все источники получают свой черёд.
    const collectedSkipped = [];
    const fast = allSources.filter((row) => row.kind === 'rss' || row.kind === 'twitter');
    const slow = allSources.filter((row) => row.kind !== 'rss' && row.kind !== 'twitter');
    const readCursor = async (key) => {
      const row = await store.getFsm(key);
      try {
        return Number(JSON.parse(row?.data ?? '{}').value) || 0;
      } catch {
        return 0;
      }
    };
    const rotate = (list, cursor, limit) => (list.length > limit
      ? [...list.slice(cursor % list.length), ...list.slice(0, cursor % list.length)].slice(0, limit)
      : list);
    const fastCursor = await readCursor('collect:cursor');
    const slowCursor = await readCursor('collect:slow');
    const fastBatch = rotate(fast, fastCursor, budget.maxSourcesPerRun ?? 12);
    await store.setFsm('collect:cursor', 'cursor', { value: fast.length ? (fastCursor + fastBatch.length) % fast.length : 0 }).catch(() => {});
    // Медленные (каналы через зеркало до 12 с, html-страницы) в сводку этого вызова
    // не идут: их сбор — отдельный шаг после отправки, чтобы не отнимать время у LLM.
    slowPlan = slow.length ? rotate(slow, slowCursor, 1) : [];
    const rotated = fastBatch;
    const collected = await collectAll(rotated, {
      deadlineMs: Math.max(3000, Math.min(budget.collectDeadlineMs, left() - 14000)),
      retries: 1, // на ретраи нет бюджета: быстрый отказ лучше потерянных секунд
    });

    collected.partial.push(...collectedSkipped);
    const window = digestWindow({ nowMs: Date.now(), lastSentAt: await store.getLastSentAt(chatId), windowDays: config.digest.windowDays, firstWindowHours: config.digest.firstWindowHours });
    // Кандидаты — ВСЁ за последние 7 дней, а не только после прошлой сводки:
    // непоместившиеся в лимит 45 пунктов должны попасть в следующую (P0 ревью 2026-10-19).
    const eligibilityMs = Date.now() - config.digest.windowDays * 24 * 60 * 60 * 1000;
    const rows = await store.pendingRows(chatId, eligibilityMs);
    const consumed = await store.consumedKeys(chatId);
    // Мало времени — режем вход и выход, но сводку всё равно отдаём:
    // пустой ответ хуже короткого (ревью 2026-10-19).
    const tight = left() < 20000;
    const caps = tight
      ? { perSource: 2, maxItems: 10, maxChars: 12000, maxTokens: 3000 }
      : { perSource: budget.perSource, maxItems: budget.maxItems, maxChars: budget.maxChars, maxTokens: budget.maxTokens };
    const { selected } = selectPending(rows, {
      perSource: caps.perSource,
      maxItems: caps.maxItems,
      maxChars: caps.maxChars,
      consumedUrls: consumed.urls,
      consumedTitles: consumed.titles,
    });
    const periodFrom = isoFromMs(window.fromMs);
    const periodTo = isoNow();

    if (!selected.length) {
      await status.close();
      const notes = [];
      if (collected.errors.length) notes.push(`⚠ Не удалось собрать ${collected.errors.length} источник(ов): ${collected.errors.map((e) => escapeHtml(e.url)).join(', ')}`);
      if (unsupported.length) notes.push(`ℹ️ Не собираются: ${unsupported.map((url) => escapeHtml(url)).join(', ')}`);
      if (collected.partial.length) notes.push(`ℹ️ Собрано неполно: ${collected.partial.length} источник(ов)`);
      await send(chatId, [EMPTY_TEXT, ...notes].join('\n\n'));
      await store.setJob(jobId, { status: 'done', stage: 'empty', detail: 'новостей нет' });
      jobDone = true;
      return;
    }

    await status.set(`🧠 Думаю над ${plural(selected.length, 'пунктом', 'пунктами', 'пунктами')}…`);
    const summary = await summarize(formatItemsInput(selected, config.digest.textCap), await store.getInterests(chatId), null, {
      thinking: budget.thinking,
      maxTokens: caps.maxTokens,
      attempts: 1,
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
    totalChunks = chunks.length;
    let sent = 0;
    for (const chunk of chunks) {
      const ok = await sendChunk(chatId, chunk, false) || await sendChunk(chatId, chunk, true);
      if (!ok) throw new Error(`не удалось отправить часть ${sent + 1} из ${chunks.length}`);
      sent += 1;
      sentChunks = sent;
      if (sent === 1) await status.close();
    }
    await store.recordDigest(chatId, { periodFrom, periodTo, text, itemIds: selected.map((row) => row.id) });
    await store.appendHistory(chatId, 'assistant', text);
    await store.setJob(jobId, { status: 'done', stage: 'sent', detail: `${plural(selected.length, 'пункт', 'пункта', 'пунктов')}, ${plural(sent, 'сообщение', 'сообщения', 'сообщений')}` });
    jobDone = true;
    console.log(`сводка: ${selected.length} пунктов, ${collected.added} новых, ${Math.round((Date.now() - started) / 1000)} c`);
  } catch (error) {
    console.error('runDigest упал:', error?.stack ?? error);
    await status.close();
    const reason = error instanceof LlmError ? error.message : String(error?.message ?? error);
    await store.setJob(jobId, { status: 'failed', stage: 'error', detail: reason.slice(0, 200) }).catch(() => {});
    const delivered = sentChunks > 0;
    await send(chatId, delivered
      ? `⚠️ Сводка доставлена не полностью (${sentChunks} из ${totalChunks}): ${escapeHtml(reason).slice(0, 300)}. Остальное придёт в следующей.`
      : `⚠️ Сводка не удалась: ${escapeHtml(reason).slice(0, 400)}\n\nНовости не потеряны — они уйдут в следующую сводку.`);
  } finally {
    // Страховка от вечного «уже собирается»: но не перетираем уже завершённую задачу.
    if (!jobDone) await store.setJob(jobId, { status: 'failed', stage: 'aborted', detail: 'вызов прерван' }).catch(() => {});
    // Медленный источник — после сводки: его пункты попадут в следующую.
    if (slowPlan.length && left() > 8000) {
      try {
        const late = await collectAll(slowPlan, { deadlineMs: Math.min(6000, Math.max(2000, left() - 2000)), retries: 1 });
        const slowCursorRow = await store.getFsm('collect:slow');
        let slowCursor = 0;
        try {
          slowCursor = Number(JSON.parse(slowCursorRow?.data ?? '{}').value) || 0;
        } catch {
          slowCursor = 0;
        }
        const slowTotal = (await store.listActiveSources(chatId)).filter((row) => row.kind !== 'rss' && row.kind !== 'twitter').length;
        await store.setFsm('collect:slow', 'cursor', { value: slowTotal ? (slowCursor + slowPlan.length) % slowTotal : 0 }).catch(() => {});
        console.log(`медленный источник после сводки: +${late.added}`);
      } catch (error) {
        console.warn('медленный сбор после сводки не удался:', error?.message ?? error);
      }
    }
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

/** Список источников с кнопками (управление без Python-бота). */
async function sendSources(chatId) {
  const view = sourcesView(await store.listSources(chatId));
  await botApi('sendMessage', {
    chat_id: chatId,
    text: view.text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: view.keyboard },
  }).catch((error) => console.error('sendSources:', error?.message ?? error));
}

/** Добавление источника из ответа пользователя (после кнопки «Добавить»). */
async function addSourceFromInput(chatId, input) {
  const detected = detectSource(input);
  if (!detected.kind) {
    // Выходим из режима добавления, иначе все следующие сообщения уходят в него
    // и обычные вопросы остаются без ответа (ревью 2026-10-19).
    await store.clearFsm(String(chatId)).catch(() => {});
    await send(chatId, `⚠️ ${escapeHtml(detected.reason ?? 'не понял')}. Режим добавления выключен. Пример: <code>https://example.com/feed.xml</code> или <code>@channel</code>`);
    return;
  }
  const config = await loadConfig();
  const count = (await store.listSources(chatId)).length;
  if (count >= config.sources.max) {
    await send(chatId, `⚠️ Лимит источников: ${config.sources.max}. Удали лишние в /sources.`);
    return;
  }
  const added = await store.addSource(chatId, { kind: detected.kind, url: detected.url, title: detected.url, origin: 'manual' });
  await store.clearFsm(String(chatId)).catch(() => {});
  await send(chatId, added.created
    ? `✅ Добавил: ${escapeHtml(detected.url)} (${detected.kind}). Соберётся при следующей сводке — /sources.`
    : `ℹ️ Такой источник уже есть: ${escapeHtml(detected.url)}`);
  await sendSources(chatId);
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
    console.error('runDigest упал:', error?.stack ?? error);
    await status.close();
    const reason = error instanceof LlmError ? error.message : String(error?.message ?? error);
    await send(chatId, `⚠️ Не получилось ответить: ${escapeHtml(reason).slice(0, 300)}`);
    return;
  }
  await status.close();
  for (const chunk of chunkMessage(answer, config.digest.messageLimit)) {
    const ok = await sendChunk(chatId, chunk, false) || await sendChunk(chatId, chunk, true);
    if (!ok) console.error('answer: не удалось доставить ответ');
  }
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
