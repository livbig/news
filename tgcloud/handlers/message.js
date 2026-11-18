// Единая точка входа бота: гейт → интент → действие.
// Сводка считается здесь же, в одном вызове платформы (~30 с): сбор с дедлайном,
// отбор, LLM без мышления (17 с), отправка чанками. Внешних исполнителей нет.
// Бюджет и замеры — docs/tgcloud-migration.md §11.

import { botApi } from '../lib/telegram.js';
import { gate, loadConfig } from '../lib/config.js';
import { route } from '../lib/intents.js';
import { EMPTY_TEXT, composeDigest, digestWindow, emptyPeriodText, formatItemsInput, parsePeriod, periodHeader, periodSpan, rowsInPeriod, selectPending, shortHistorySources } from '../lib/digest.js';
import { LlmError, ask, extractTerms, summarize } from '../lib/llm.js';
import { addInterestTerms, clarifyTerms, containsWholeWords, countInterestSources, fallbackTerms, interestFsmKey, matchInterestTerms, parseInterests, parseTermList } from '../lib/interests.js';
import { collectAll } from '../lib/collect.js';
import * as store from '../lib/store.js';
import { chunkMessage, escapeHtml, isoFromMs, isoNow, plural } from '../lib/text.js';
import { helpText, interestsListText, settingsText, statsText } from '../lib/render.js';
import { detectSource, sourcesView } from '../lib/sources-ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
      await runDigest(chatId, intent.periodHint);
      return;
    }
    // Интересы — до режима добавления источника: триггеры явные (FR-5…FR-7).
    if (intent.kind === 'interests') {
      await handleInterests(chatId, intent, text);
      return;
    }
    // Ждём ссылку на источник, если пользователь нажал «Добавить».
    const fsm = await store.getFsm(String(chatId));
    const fsmFresh = fsm && Date.now() - Date.parse(fsm.updatedAt ?? '') < 10 * 60 * 1000;
    if (fsmFresh && fsm.state === 'await_source') {
      await addSourceFromInput(chatId, text);
      return;
    }
    await answerQuestion(chatId, text, intent.periodHint);
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
  if (command === 'interests') {
    await sendInterests(chatId);
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
async function runDigest(chatId, periodHint = null) {
  const config = await loadConfig();
  const budget = config.inline;
  const started = Date.now();
  const left = () => budget.hardDeadlineMs - (Date.now() - started);

  // Явный период из текста (FR-1): конец периода, пояс и глубина — из настроек читателя.
  const tzOffsetMin = await store.getTzOffsetMin(chatId);
  const explicit = periodHint ? parsePeriod(periodHint, { nowMs: started, tzOffsetMin, maxDays: config.digest.windowDays }) : null;
  if (explicit?.invalid) {
    // «с 31 февраля»: окно не выдумываем, просим уточнить (FR-1).
    await send(chatId, `📅 Не понял период (${escapeHtml(explicit.label)}): такой даты нет. Уточни, например «за 3 дня» или «с 1 октября».`);
    return;
  }
  if (explicit?.future) {
    await send(chatId, `📅 Этот период ещё не начался (${escapeHtml(explicit.label)}) — сводки за него нет, якорь не двигался.`);
    return;
  }

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
  const status = await statusHandle(chatId, explicit ? `🔎 Собираю за ${explicit.label}…` : '🔎 Собираю ленту…');
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
    // Для сводки за период они не собираются вовсе (FR-9) — пункты уйдут в следующую,
    // а в сводке об этом будет пометка (deferred), чтобы «собрано 0» не было ложью.
    slowPlan = !explicit && slow.length ? rotate(slow, slowCursor, 1) : [];
    const deferred = explicit ? slow.length : 0;
    const rotated = fastBatch;
    const collected = await collectAll(rotated, {
      deadlineMs: Math.max(3000, Math.min(budget.collectDeadlineMs, left() - 14000)),
      retries: 1, // на ретраи нет бюджета: быстрый отказ лучше потерянных секунд
    });

    collected.partial.push(...collectedSkipped);
    const window = explicit
      ? { fromMs: explicit.fromMs, toMs: explicit.toMs, capped: explicit.capped }
      : digestWindow({ nowMs: Date.now(), lastSentAt: await store.getLastSentAt(chatId), windowDays: config.digest.windowDays, firstWindowHours: config.digest.firstWindowHours });
    // Кандидаты — ВСЁ за последние 7 дней, а не только после прошлой сводки:
    // непоместившиеся в лимит 45 пунктов должны попасть в следующую (P0 ревью 2026-10-19).
    const eligibilityMs = explicit ? explicit.fromMs : Date.now() - config.digest.windowDays * DAY_MS;
    const candidates = await store.pendingRows(chatId, eligibilityMs);
    // Явный период: верхняя граница работает только у закрытого окна (конец в прошлом),
    // иначе отсекалось всё, что этот же вызов только что собрал (P0 ревью 2026-10-19).
    const rows = explicit ? rowsInPeriod(candidates, explicit) : candidates;
    // FR-3: история источника короче запрошенного периода — честная пометка в сводке.
    const shortHistory = explicit ? shortHistorySources(candidates, window.fromMs) : [];
    // FR-2: явный период не вычитает отправленное ранее — повтор даёт тот же набор.
    const consumed = explicit ? { urls: new Set(), titles: new Set() } : await store.consumedKeys(chatId);
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
    // Конец периода: для «за вчера» и «с A по B» — полночь дня после B, а не сейчас (FR-1).
    const periodTo = explicit ? isoFromMs(explicit.toMs) : isoNow();

    if (!selected.length) {
      await status.close();
      const notes = [];
      if (collected.errors.length) notes.push(`⚠ Не удалось собрать ${collected.errors.length} источник(ов): ${collected.errors.map((e) => escapeHtml(e.url)).join(', ')}`);
      if (unsupported.length) notes.push(`ℹ️ Не собираются: ${unsupported.map((url) => escapeHtml(url)).join(', ')}`);
      if (collected.partial.length) notes.push(`ℹ️ Собрано неполно: ${collected.partial.length} источник(ов)`);
      // FR-11: пустой явный период называет период и цифры сбора, неявный — подсказывает период.
      const head = explicit
        ? emptyPeriodText({ span: periodSpan(periodFrom, periodTo, tzOffsetMin), polled: rotated.length, deferred, errors: collected.errors.length })
        : EMPTY_TEXT;
      await send(chatId, [head, ...notes].join('\n\n'));
      await store.setJob(jobId, { status: 'done', stage: 'empty', detail: 'новостей нет' });
      jobDone = true;
      return;
    }

    await status.set(`🧠 Думаю над ${plural(selected.length, 'пунктом', 'пунктами', 'пунктами')}…`);
    const interestsText = await store.getInterests(chatId);
    let summary;
    let truncated = false;
    try {
      summary = await summarize(formatItemsInput(selected, config.digest.textCap), interestsText, null, {
        thinking: budget.thinking,
        maxTokens: caps.maxTokens,
        attempts: 1,
      });
    } catch (error) {
      // Обрезка по max_tokens: вход не влез в выходной бюджет. Один повтор с половиной
      // пунктов (и те же лимиты) дешевле, чем честная ошибка вместо сводки.
      // Обрезанный текст лучше ошибки: он полон по смыслу, просто короче (пометка ниже).
      console.log(`LLM обрезала ответ: частичный текст ${String(error?.partial ?? '').length} симв.`);
      if (error?.name === 'LlmTruncatedError' && String(error.partial ?? '').length > 400) {
        summary = String(error.partial);
        truncated = true;
      } else if (error?.name !== 'LlmTruncatedError' || left() < 12000 || selected.length < 6) throw error;
      const half = selected.slice(0, Math.max(5, Math.floor(selected.length / 2)));
      console.log(`LLM обрезала ответ, повтор с ${half.length} пунктами`);
      summary = await summarize(formatItemsInput(half, config.digest.textCap), interestsText, null, {
        thinking: budget.thinking,
        maxTokens: caps.maxTokens,
        attempts: 1,
      });
      selected.splice(half.length);
    }
    // FR-3: если набор совпал с прошлой сводкой — честная пометка вместо тишины.
    // Честная пометка: текст полный по смыслу, но модель не дописала до конца.
    if (truncated) summary += '\n\n⚠️ Сводка сокращена: ответ не влез в лимит вызова.';
    const sameAs = explicit ? await previousDigestAt(chatId, selected) : null;
    const text = composeDigest({
      header: periodHeader(periodFrom, periodTo, tzOffsetMin),
      summary,
      capped: window.capped,
      sameAs,
      tzOffsetMin,
      errors: collected.errors,
      partial: collected.partial.map((p) => p.url),
      unsupported,
      deferred,
      shortHistory,
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
    await store.recordDigest(chatId, { periodFrom, periodTo, text, itemIds: selected.map((row) => row.id) }, { moveAnchor: !explicit });
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

/** Интересы: показ, удаление, отмена, предложение добавить (FR-5…FR-7). Сбор не запускается. */
async function handleInterests(chatId, intent, text) {
  if (intent.action === 'list') {
    await sendInterests(chatId);
    return;
  }
  if (intent.action === 'cancel') {
    // U8: то же, что кнопка «❌ Отмена» — предложение снимается, кнопки после этого не работают.
    await store.clearFsm(interestFsmKey(chatId)).catch(() => {});
    await send(chatId, '❌ Отменено, интересы не менялись.');
    return;
  }
  if (intent.action === 'remove') {
    await removeInterestFlow(chatId, intent.target);
    return;
  }
  await proposeInterests(chatId, text, intent.target);
}

async function interestsRows(chatId) {
  const terms = parseInterests(await store.getInterests(chatId));
  return countInterestSources(terms, await store.listSources(chatId));
}

async function sendInterests(chatId) {
  await send(chatId, interestsListText(await interestsRows(chatId)));
}

/** Запись — только после кнопки «✅ Добавить» (FR-5, FR-10); здесь только предложение. */
async function proposeInterests(chatId, text, target) {
  const extracted = parseTermList(await extractTerms(text));
  const usedFallback = !extracted.length;
  const candidates = usedFallback ? fallbackTerms(target) : extracted;
  if (!candidates.length) {
    await send(chatId, '🤔 Не понял, что добавить в интересы. Пример: «добавь в интересы кобальт» или «хочу больше про физическое золото».');
    return;
  }
  // FR-12: больше трёх тем, общий или слишком короткий термин — переспрос, запись не выполняется.
  const check = clarifyTerms(candidates);
  if (!check.ok) {
    const lines = ['🤔 Уточни, что добавить в интересы:', ...check.problems.map((problem) => `• ${escapeHtml(problem)}`)];
    if (check.terms.length) lines.push('', `Понял так: ${check.terms.slice(0, 5).map((term, index) => `${index + 1}) ${escapeHtml(term)}`).join(' ')}.`);
    lines.push('', 'Ничего не записал — скажи конкретнее.');
    await send(chatId, lines.join('\n'));
    return;
  }
  // Сухая примерка профиля: лимит 4000 и дедуп видит пользователь до записи.
  const preview = addInterestTerms(await store.getInterests(chatId), check.terms);
  if (!preview.ok) {
    await send(chatId, `⚠️ ${escapeHtml(preview.reason)}`);
    return;
  }
  if (!preview.added.length) {
    // Интерес уже в профиле: заводим недостающие источники — иначе тема есть в промпте,
    // но её новости никогда не собираются (пользователь просил именно «собрать источники»).
    const config = await loadConfig();
    const created = await store.addInterestSources(chatId, preview.existing, config.sources.max);
    const tail = created ? ` Источников завёл: ${created}.` : ' Источники по теме уже есть — смотри /sources.';
    await send(chatId, `ℹ️ Уже в интересах: ${preview.existing.map((term) => escapeHtml(term)).join(', ')}.${tail}`);
    return;
  }
  await store.setFsm(interestFsmKey(chatId), 'await_interest', { mode: 'add', terms: preview.added });
  const list = preview.added.map((term, index) => `${index + 1}) ${escapeHtml(term)}`).join('\n');
  const note = usedFallback ? '\n\n<i>LLM недоступна, взял формулировку как есть.</i>' : '';
  await botApi('sendMessage', {
    chat_id: chatId,
    text: `Добавить в интересы:\n${list}${note}\n\nИсточники: Google News по каждому.`,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: '✅ Добавить', callback_data: 'int:add' }, { text: '❌ Отмена', callback_data: 'int:cancel' }]] },
  }).catch((error) => console.error('proposeInterests:', error?.message ?? error));
}

/** Удаление: 0 совпадений — отказ со списком, >1 — кнопки (FR-6). */
async function removeInterestFlow(chatId, target) {
  const matches = matchInterestTerms(await store.getInterests(chatId), target);
  if (!matches.length) {
    await send(chatId, [`ℹ️ Такого интереса нет: ${escapeHtml(target || '—')}.`, '', interestsListText(await interestsRows(chatId))].join('\n'));
    return;
  }
  // Кнопки — когда названный обрывок разрастается в разные интересы («ставк» → «ставка фрс»
  // и «ставки по ипотеке»). Если слово есть в профиле целиком, выбора нет: «убери золото»
  // убирает все вхождения сразу (P2-7).
  if (matches.length > 1 && !matches.every((line) => containsWholeWords(line, target))) {
    const terms = matches.slice(0, 5);
    await store.setFsm(interestFsmKey(chatId), 'await_interest', { mode: 'remove', terms });
    await botApi('sendMessage', {
      chat_id: chatId,
      text: 'Уточни, что убрать:',
      reply_markup: { inline_keyboard: terms.map((term, index) => [{ text: term.slice(0, 40), callback_data: `int:pick:${index}` }]) },
    }).catch((error) => console.error('removeInterest:', error?.message ?? error));
    return;
  }
  // Фраза пользователя, а не строка профиля: убирается термин, а источники ищутся по нему (FR-6).
  await dropInterest(chatId, target, true);
}

/** Убирает интерес и его источники; снимок в fsm — для кнопки «↩️ Вернуть» (FR-6).
 * all — текстом названный термин убирается во всех местах профиля (P2-7); выбор кнопкой
 * указывает на конкретную строку, поэтому там — только первое совпадение. */
async function dropInterest(chatId, term, all = false) {
  const snapshot = await store.removeInterest(chatId, term, all);
  if (!snapshot) {
    await send(chatId, `ℹ️ Такого интереса нет: ${escapeHtml(term)}.`);
    return null;
  }
  await store.setFsm(interestFsmKey(chatId), 'await_undo', { term: snapshot.term, profile: snapshot.profile, sources: snapshot.sources });
  await botApi('sendMessage', {
    chat_id: chatId,
    text: `🗑 Убрал: ${escapeHtml(snapshot.term)} (источников удалено: ${snapshot.removedSources})`,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: '↩️ Вернуть', callback_data: 'int:undo' }]] },
  }).catch((error) => console.error('dropInterest:', error?.message ?? error));
  return snapshot;
}

/** Время прошлой сводки, если её набор пунктов совпадает с текущим (FR-3). */
async function previousDigestAt(chatId, selected) {
  const lastIds = await store.lastDigestItemIds(chatId);
  if (!lastIds.length || lastIds.length !== selected.length) return null;
  const ids = new Set(lastIds);
  if (!selected.every((row) => ids.has(row.id))) return null;
  return (await store.lastDigest(chatId))?.createdAt ?? null;
}

/** Уточнения по темам и свободный диалог (R3): короткий вызов, влезает в инвокацию.
 * Период из фразы уходит в окно контекста (FR-4): «сводка по золоту за неделю» — не 24 часа. */
async function answerQuestion(chatId, question, periodHint = null) {
  const config = await loadConfig();
  const tzOffsetMin = await store.getTzOffsetMin(chatId);
  const explicit = periodHint ? parsePeriod(periodHint, { nowMs: Date.now(), tzOffsetMin, maxDays: config.digest.windowDays }) : null;
  const usable = Boolean(explicit) && !explicit.invalid && !explicit.future;
  const window = usable
    ? { fromMs: explicit.fromMs, toMs: explicit.toMs, capped: explicit.capped }
    : digestWindow({
      nowMs: Date.now(),
      lastSentAt: null,
      windowDays: config.digest.windowDays,
      firstWindowHours: config.digest.firstWindowHours,
    });
  // Закрытое окно («вчера», «с A по B») ограничивает ленту и сверху (P2-11): иначе на «что
  // было по золоту с 1 октября» в контекст попадают сегодняшние пункты.
  const rows = await store.recentItems(chatId, window.fromMs, 40, usable && !explicit.openEnd ? window.toMs : null);
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

/** Отправка текста: длинное сообщение режется на части ≤ лимита (P2-9) — иначе Telegram
 * отклоняет его целиком и пользователь не видит ничего (так падал /interests на большом профиле). */
async function send(chatId, text) {
  const config = await loadConfig();
  for (const chunk of chunkMessage(text, config.digest.messageLimit)) {
    await botApi('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      .catch((error) => console.error('sendMessage:', error?.message ?? error));
  }
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
