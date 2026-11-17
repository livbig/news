// Сборка и отправка сводки — один путь для расписания, чата, фронтенда и инструментов агента.
// Логика отбора и текста — проверенные модули (digest.js, digest-run.js); здесь только
// склейка с базой, телеграмом и профилями объёма.

import { collectAll } from './collect.js';
import { loadConfig } from './config.js';
import {
  EMPTY_TEXT,
  composeDigest,
  digestWindow,
  emptyPeriodText,
  entrySize,
  parsePeriod,
  periodHeader,
  periodSpan,
  rowsInPeriod,
  rowsInRecent,
  selectPending,
  shortHistorySources,
} from './digest.js';
import { summarizeDigest } from './digest-run.js';
import { orderSections, sectionOrderKeys } from './digest.js';
import { SECTIONS, SECTION_ORDER } from './prompts.js';
import { summarize } from './llm.js';
import {
  consumedKeys,
  ensureUser,
  getInterests,
  lastDigest,
  lastDigestItemIds,
  listActiveSources,
  listSources,
  markSlotSent,
  pendingRows,
  recordDigest,
  retentionPass,
  setState,
} from './store.js';
import { sendHtml } from './telegram.js';
import { chunkMessage, isoNow, normalizeTitle } from './text.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Профили объёма: ручная сводка скромнее, плановая — «мега». */
function budgetFor(profile, config) {
  const base = { thinking: true, fanout: { ...config.inline.fanout } };
  if (profile === 'scheduled') {
    return {
      ...base,
      items: { perSource: 12, maxItems: 100, maxChars: 220_000 },
      caps: { maxTokens: 24_000 },
      // 4 части по 25 пунктов: 14k токенов на часть не хватало — модель обрезалась.
      fanout: { enabled: true, parts: 4, minItems: 50, maxTokensPerPart: 20_000, maxTokensEditor: 6_000 },
    };
  }
  return {
    ...base,
    items: { perSource: config.inline.perSource, maxItems: config.inline.maxItems, maxChars: config.inline.maxChars },
    caps: { maxTokens: 16_000 },
    // Ручная сводка на Pi не ограничена 30 секундами платформы: частям даём больше токенов.
    fanout: { ...config.inline.fanout, maxTokensPerPart: 12_000, maxTokensEditor: 4_000 },
  };
}

/** Окно: явный период из текста или обычные сутки. */
export function resolveWindow({ period = null, nowMs = Date.now(), tzOffsetMin = 180, config = loadConfig(), lastSentAt = null }) {
  const parsed = parsePeriod(period, { nowMs, tzOffsetMin, maxDays: config.digest.windowDays });
  if (parsed?.invalid) return { invalid: true, label: parsed.label };
  // Плановая сводка идёт от прошлой: 09:00 закрывает ночь, 21:00 — день. Обычная — сутки.
  const window = parsed ?? digestWindow({
    nowMs,
    lastSentAt,
    windowDays: config.digest.defaultWindowDays,
    firstWindowHours: config.digest.firstWindowHours,
  });
  return { ...window, explicit: Boolean(parsed) };
}

/** Темы, которые не должны пропадать из сводки: у читателя они глубокие,
 * а по важности проигрывают громким AI-заголовкам. Пол — минимум пунктов,
 * если подходящие новости в окне вообще есть. */
const SECTION_FLOORS = [
  { key: 'metals', floor: 3, re: /золот|серебр|платин|паллад|драгметалл|медь|никел|алюмин|сырь|黄金|金价/i },
  { key: 'fx', floor: 2, re: /рубл|доллар|валют|usd\/rub|юань|евро|цб рф|人民币|汇率/i },
  // Китайские пункты важны: 机器人 — робот, 人形 — человекоподобный.
  { key: 'robotics', floor: 3, re: /робот|гуманоид|physical ai|embodied|манипулятор|кобот|человекоподобн|机器人|人形|robot/i },
];

/** Текст пункта для сопоставления с темой: заголовок, выжимка и темы анализатора. */
function rowHaystack(row) {
  const topics = Array.isArray(row?.topics) ? row.topics.join(' ') : String(row?.topics ?? '');
  return `${row?.title ?? ''} ${row?.gist ?? ''} ${topics}`.toLowerCase();
}

/**
 * Добить выборку пунктами глубоких тем до пола: берём самые свежие не выбранные,
 * не больше `floor` на тему и не больше 8 пунктов сверх лимита.
 * @returns {Array} выбранные пункты (исходные + добавка)
 */
export function applySectionFloors(selected, rows, { consumedUrls = new Set(), consumedTitles = new Set() } = {}) {
  const picked = [...selected];
  const seenUrl = new Set(picked.map((row) => String(row.url ?? '').trim()));
  const seenTitle = new Set(picked.map((row) => normalizeTitle(row.title)));
  let extra = 0;
  for (const rule of SECTION_FLOORS) {
    const have = picked.filter((row) => rule.re.test(rowHaystack(row))).length;
    let need = rule.floor - have;
    if (need <= 0) continue;
    for (const row of rows) {
      if (!need || extra >= 8) break;
      const url = String(row.url ?? '').trim();
      const titleKey = normalizeTitle(row.title);
      if (!url || consumedUrls.has(url) || (titleKey && consumedTitles.has(titleKey))) continue;
      if (seenUrl.has(url) || (titleKey && seenTitle.has(titleKey))) continue;
      if (!rule.re.test(rowHaystack(row))) continue;
      seenUrl.add(url);
      if (titleKey) seenTitle.add(titleKey);
      picked.push(row);
      need -= 1;
      extra += 1;
    }
  }
  return picked;
}

/** Отбор пунктов под окно и профиль. Чистая обвязка над digest.js — удобно тестировать. */
export function selectForDigest({ rows, window, profile, config, consumedUrls, consumedTitles }) {
  const filtered = window.explicit ? rowsInPeriod(rows, window) : rowsInRecent(rows, window.fromMs);
  const limits = budgetFor(profile, config).items;
  const base = selectPending(filtered, { ...limits, consumedUrls, consumedTitles });
  const selected = applySectionFloors(base.selected, filtered, { consumedUrls, consumedTitles });
  // Пол добавляет пункты сверх лимита — пересчитываем объём по фактической выборке.
  const chars = selected.reduce((sum, row) => sum + entrySize(row), 0);
  return { selected, chars, filtered };
}

/** Замки живут здесь, а не в таймере службы: сбор и сводку запускает ещё и API,
 *  и агент, и фронтенд — без общего замка два прохода работают одновременно (429 от зеркала,
 *  двойной расход LLM, две сводки в чат). */
let collecting = false;
let digesting = false;

export async function collectNow({ chatId, log = console.log } = {}) {
  if (collecting) throw new Error('сбор уже идёт — второй не запускаю');
  collecting = true;
  try {
    return await collectOnce({ chatId, log });
  } finally {
    collecting = false;
  }
}

async function collectOnce({ chatId, log }) {
  const config = loadConfig();
  const sources = listActiveSources(chatId);
  if (!sources.length) return { added: 0, errors: [], sources: 0 };
  const started = Date.now();
  const result = await collectAll(sources, { retries: 2 });
  await retentionPass(chatId, config.retention).catch((error) => log(`retention: ${error?.message ?? error}`));
  setState('last_collect_at', isoNow());
  log(`сбор: ${sources.length} источников, +${result.added}, ${Math.round((Date.now() - started) / 1000)} c, ошибок ${result.errors.length}`);
  return { ...result, sources: sources.length, tookMs: Date.now() - started };
}

/**
 * Собрать сводку (без отправки). Возвращает текст, пункты и честные пометки.
 * @param {{chatId:number, period?:string|null, profile?:'manual'|'scheduled', collectFirst?:boolean, nowMs?:number, summarizeFn?:Function, log?:Function}} options
 */
export async function buildDigest(options = {}) {
  if (digesting) throw new Error('сводка уже собирается — вторую не запускаю');
  digesting = true;
  try {
    return await buildDigestOnce(options);
  } finally {
    digesting = false;
  }
}

async function buildDigestOnce({
  chatId,
  period = null,
  profile = 'manual',
  collectFirst = false,
  nowMs = Date.now(),
  summarizeFn = summarize,
  log = console.log,
} = {}) {
  const config = loadConfig();
  const tz = config.tz.offsetMin;
  await ensureUser(chatId);

  let collected = null;
  if (collectFirst) collected = await collectNow({ chatId, log });

  const previous = await lastDigest(chatId);
  const window = resolveWindow({
    period,
    nowMs,
    tzOffsetMin: tz,
    config,
    lastSentAt: profile === 'scheduled' ? previous?.createdAt ?? null : null,
  });
  if (window.invalid) {
    return { text: `Не понял дату «${window.label}» — такого дня нет. Назови период иначе: «за 3 дня», «вчера».`, items: [], invalid: true };
  }

  const rows = await pendingRows(chatId, window.fromMs);
  const consumed = await consumedKeys(chatId);
  const { selected, chars } = selectForDigest({
    rows,
    window,
    profile,
    config,
    consumedUrls: consumed.urls,
    consumedTitles: consumed.titles,
  });

  if (!selected.length) {
    const text = window.explicit
      ? emptyPeriodText({ span: window.label, polled: collected?.sources ?? listSources(chatId).length, errors: collected?.errors?.length ?? 0 })
      : EMPTY_TEXT;
    return { text, items: [], chars: 0, window, collected };
  }

  const interests = await getInterests(chatId);
  const budget = budgetFor(profile, config);
  const summary = await summarizeDigest({
    selected,
    interestsText: interests,
    config,
    budget,
    caps: budget.caps,
    left: () => Number.POSITIVE_INFINITY,
    summarize: summarizeFn,
  });
  // Порядок разделов — не на совести модели: раскладываем блоки по SECTION_ORDER.
  if (summary?.text) summary.text = orderSections(summary.text, sectionOrderKeys(SECTIONS, SECTION_ORDER));

  const fromIso = new Date(window.fromMs).toISOString();
  const toIso = new Date(Math.min(window.toMs ?? nowMs, nowMs)).toISOString();
  const last = previous;
  const previousItems = await lastDigestItemIds(chatId);
  const currentIds = summary.items.map((row) => row.id);
  const sameAs =
    previousItems.length && currentIds.length && previousItems.length === currentIds.length && currentIds.every((id) => previousItems.includes(id))
      ? last?.createdAt ?? null
      : null;

  const text = composeDigest({
    header: periodHeader(fromIso, toIso, tz),
    summary: summary.text,
    capped: Boolean(window.capped),
    capText: `окно ограничено ${config.digest.windowDays} днями — более старое не запрашивается`,
    errors: collected?.errors ?? [],
    partial: collected?.partial ?? [],
    shortHistory: shortHistorySources(rows, window.fromMs),
    sameAs,
    tzOffsetMin: tz,
  });

  return {
    text,
    items: summary.items,
    note: summary.note ?? '',
    chars,
    window,
    span: periodSpan(fromIso, toIso, tz),
    collected,
    itemCount: summary.items.length,
  };
}

/** Отправить готовую сводку и записать её в базу. Запись — после успешной отправки. */
export async function sendDigest({ chatId, digest, kind = 'manual', slot = null, log = console.log }) {
  const config = loadConfig();
  const expected = chunkMessage(digest.text, config.digest.messageLimit).length;
  const chunks = await sendHtml(chatId, digest.text, config.digest.messageLimit);
  // Ушла часть — это не отправленная сводка: слот не помечаем, попытка повторится через 5 минут.
  // Иначе половина текста теряется навсегда (429 в середине серии — живой случай).
  if (!chunks) throw new Error('не удалось отправить ни одного куска сводки');
  if (chunks !== expected) throw new Error(`ушло ${chunks} кусков из ${expected} — сводка не считается отправленной`);
  const digestId = await recordDigest(chatId, {
    periodFrom: new Date(digest.window.fromMs).toISOString(),
    periodTo: new Date(digest.window.toMs ?? Date.now()).toISOString(),
    text: digest.text,
    itemIds: digest.items.map((row) => row.id),
    kind,
    slot,
  });
  setState('last_digest_at', isoNow());
  if (slot) markSlotSent(slot, digestId);
  log(`сводка отправлена: ${digest.itemCount} пунктов, ${chunks} сообщений, digest #${digestId} (${kind}${slot ? `, слот ${slot}` : ''})`);
  return { digestId, chunks };
}

/** Полный путь «собрать → отправить» для расписания и команд. */
export async function runDigest({ chatId, period = null, profile = 'manual', collectFirst = false, send = true, kind = 'manual', slot = null, log = console.log } = {}) {
  const digest = await buildDigest({ chatId, period, profile, collectFirst, log });
  if (digest.invalid || !digest.items.length) {
    if (send) {
      await sendHtml(chatId, digest.text, loadConfig().digest.messageLimit);
      // Непонятый период — не сводка: в историю не пишем, окно не сдвигаем.
      if (digest.invalid) return { digest, empty: true, invalid: true };
      const digestId = await recordDigest(chatId, {
        periodFrom: new Date(Date.now() - DAY_MS).toISOString(),
        periodTo: isoNow(),
        text: digest.text,
        itemIds: [],
        kind,
        slot,
      });
      if (slot) markSlotSent(slot, digestId);
      return { digest, digestId, chunks: 1, empty: true };
    }
    return { digest, empty: true, invalid: Boolean(digest.invalid) };
  }
  if (!send) return { digest };
  const sent = await sendDigest({ chatId, digest, kind, slot, log });
  return { digest, ...sent };
}
