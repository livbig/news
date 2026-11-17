// Служба новостей на Pi: фон (сбор → анализ → сводки 09:00/21:00) + HTTP для фронтенда и агента.
// Один процесс — один писатель в базу. Перезапуск безопасен: слоты и метки живут в state.
//
// Задачи независимы: сводка не ждёт конца анализа, анализ не ждёт сводку, сбор идёт своим
// интервалом. Каждая — со своим замком, чтобы не запускаться дважды.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { analyzePending } from './analyze.js';
import { factTask as factPrompt, reviewEntryFor, runDailyFact } from './daily-fact.js';
import { createApi } from './api.js';
import { loadConfig } from './config.js';
import { collectNow, runDigest } from './digest-service.js';
import { serviceCall } from './llm.js';
import { extractScheme as _x, renderSchemePng, sendPhotoBuffer } from './visual.js';
import { watchRestartTrigger } from './reload.js';
import { analyzeDue, collectDue, dueSlot, localClock, sentSlotKeys } from './scheduler.js';
import { seedSources } from './sources-pack.js';
import { analyzeStats, ensureUser, getState, listState, openStore, recentItems, setState } from './store.js';
import { sendHtml, sendHtmlIds, sendQuiz } from './telegram.js';
import { isoNow } from './text.js';

const config = loadConfig();
const chatId = config.allowedChatId;
const log = (...args) => console.log(new Date().toISOString(), ...args);

if (!chatId) {
  console.error('NEWS_CHAT_ID не задан — служба не запускается (fail-closed)');
  process.exit(1);
}

openStore(config.dbPath);
await ensureUser(chatId);
const seeded = await seedSources(chatId, { log });
if (seeded.created || seeded.disabled) log(`посев: +${seeded.created} источников, выключено битых ${seeded.disabled}`);

// Ручная правка прогресса курса «100 дней»: файл fact-day-override с номером уже пройденного
// дня. Нужна, чтобы переставить нумерацию без доступа к базе (один раз при старте).
const overrideFile = join(process.cwd(), 'fact-day-override');
try {
  const value = readFileSync(overrideFile, 'utf8').trim();
  if (/^\d+$/.test(value)) {
    setState('fact_day_done', value);
    setState('fact_day_date', '');
    log(`рубрика: прогресс курса переставлен — пройдено дней ${value}`);
  }
  rmSync(overrideFile, { force: true });
} catch {
  /* файла нет — обычный запуск */
}

const api = createApi({ chatId, log });
await api.listen();

// Правки кода без root: метка в рабочем каталоге службы → штатное завершение → systemd
// поднимает процесс с новым кодом (состояние слотов и метки сбора живут в state).
const restartStamp = join(process.cwd(), config.restartStamp);
const restartWatcher = watchRestartTrigger(restartStamp, { onTrigger: () => shutdown('restart-request'), log });

const locks = { digest: false, collect: false, analyze: false, fact: false };
let stopped = false;

async function digestTask(slot) {
  log(`слот ${slot.key}: собираю сводку`);
  setState('last_digest_attempt', isoNow());
  try {
    // Свежесть: если сбор был давно (служба лежала), один быстрый проход перед сводкой.
    const lastCollect = Date.parse(getState('last_collect_at') ?? '');
    if (!Number.isFinite(lastCollect) || Date.now() - lastCollect > 60 * 60_000) {
      await collectNow({ chatId, log }).catch((error) => log(`сбор перед сводкой: ${error?.message ?? error}`));
    }
    const result = await runDigest({ chatId, profile: 'scheduled', collectFirst: false, send: true, kind: 'scheduled', slot: slot.key, log });
    log(
      `слот ${slot.key}: ${result.empty ? 'пусто, честно сказано' : `отправлено ${result.chunks} сообщ., пунктов ${result.digest?.itemCount ?? 0}`}`,
    );
  } catch (error) {
    if (/уже идёт|уже собирается/.test(String(error?.message ?? ''))) return;
    log(`слот ${slot.key} упал: ${error?.stack ?? error}`);
    setState('last_error', `${isoNow()} слот ${slot.key}: ${String(error?.message ?? error).slice(0, 300)}`);
    // Слот не помечаем отправленным: следующая попытка через минуту (догон ограничен тремя часами).
  }
}

async function collectTask() {
  try {
    await collectNow({ chatId, log });
  } catch (error) {
    // Замок сбора/сводки — это не сбой: второй проход просто не нужен.
    if (/уже идёт|уже собирается/.test(String(error?.message ?? ''))) return;
    log(`сбор упал: ${error?.stack ?? error}`);
    setState('last_error', `${isoNow()} сбор: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

async function analyzeTask() {
  try {
    let rounds = 0;
    for (;;) {
      const result = await analyzePending({ batch: config.service.analyzeBatch, minAgeMs: config.service.analyzeMinAgeMs, log });
      setState('last_analyze_at', isoNow());
      if (result.analyzed) log(`анализ: разобрано ${result.analyzed}${result.failed ? ` (фолбэк ${result.failed})` : ''}${result.skipped ? ` (модель пропустила ${result.skipped})` : ''}`);
      rounds += 1;
      const pending = analyzeStats().pending;
      if (!result.analyzed || rounds >= 8 || pending <= config.service.analyzeCatchUpPending) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (error) {
    log(`анализ упал: ${error?.stack ?? error}`);
    setState('last_error', `${isoNow()} анализ: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

/** Рубрика «день N из 100»: факт + новинки рынка. День считается по отправленным. */
async function factTask(slot) {
  log(`рубрика ${slot.key}: готовлю факт дня`);
  try {
    const result = await runDailyFact({
      chatId,
      slotKey: slot.key,
      todayKey: localClock(Date.now(), config.tz.offsetMin).dateKey,
      deps: {
        getState,
        setState,
        recentItems: (id, sinceMs, limit) => recentItems(id, sinceMs, limit),
        sendQuiz: (id, item) => sendQuiz(id, item, { silent: false }),
        generate: ({ entry, items, reviewEntry }) => {
          const { system, user } = factPrompt({ entry, items, reviewEntry });
          return serviceCall({ system, user, maxTokens: 1200 });
        },
        send: async (id, text) => {
          const ids = await sendHtmlIds(id, text);
          if (ids.length) setState('fact_last_message_ids', JSON.stringify(ids));
          return ids.length;
        },
        sendVisual: async (id, { title, subtitle, lines }) => {
          const png = renderSchemePng({ title, subtitle, lines });
          if (!png) throw new Error('рендер схемы не удался');
          const messageId = await sendPhotoBuffer(id, png, title);
          if (messageId) setState('fact_last_photo_id', String(messageId));
          return messageId;
        },
        log,
      },
    });
    if (result.sent) log(`рубрика ${slot.key}: отправлен день ${result.day} (кусков: ${result.chunks ?? '?'})`);
    else if (result.reason === 'finished') log(`рубрика ${slot.key}: курс пройден`);
  } catch (error) {
    log(`рубрика ${slot.key} упала: ${error?.stack ?? error}`);
    setState('last_error', `${isoNow()} рубрика ${slot.key}: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

function tick() {
  if (stopped) return;
  const now = Date.now();

  if (config.factEnabled && !locks.fact) {
    const factDue = dueSlot({
      nowMs: now,
      times: config.factTimes,
      tzOffsetMin: config.tz.offsetMin,
      sentKeys: sentSlotKeys(listState('factslot:'), 'factslot:'),
      // Догон короткий: факт, приехавший в 13:11, — это уже не «факт в 12:00».
      catchUpMin: config.factCatchUpMin ?? 15,
    });
    if (factDue) {
      locks.fact = true;
      factTask(factDue).finally(() => {
        locks.fact = false;
      });
    }
  }

  if (!locks.digest) {
    const due = dueSlot({ nowMs: now, times: config.sendTimes, tzOffsetMin: config.tz.offsetMin, sentKeys: sentSlotKeys(listState('slot:')) });
    // Пауза между попытками: упавший слот не должен молотить LLM каждые 30 секунд.
    const lastAttempt = Date.parse(getState('last_digest_attempt') ?? '');
    const cooling = Number.isFinite(lastAttempt) && now - lastAttempt < 5 * 60_000;
    if (due && !cooling) {
      locks.digest = true;
      digestTask(due).finally(() => {
        locks.digest = false;
      });
    }
  }

  if (!locks.collect && collectDue({ nowMs: now, lastCollectIso: getState('last_collect_at'), intervalMin: config.service.collectIntervalMin })) {
    locks.collect = true;
    collectTask().finally(() => {
      locks.collect = false;
    });
  }

  const pending = analyzeStats().pending;
  const everyMin = pending > config.service.analyzeCatchUpPending ? 2 : config.service.analyzeEveryMin;
  if (!locks.analyze && analyzeDue({ nowMs: now, lastAnalyzeIso: getState('last_analyze_at'), everyMin })) {
    locks.analyze = true;
    analyzeTask().finally(() => {
      locks.analyze = false;
    });
  }
}

const timer = setInterval(tick, 30_000);
tick();

async function shutdown(signal) {
  stopped = true;
  clearInterval(timer);
  restartWatcher.stop();
  log(`остановка (${signal})`);
  await api.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log(
  `служба новостей запущена: слоты ${config.sendTimes.join(', ')}, сбор каждые ${config.service.collectIntervalMin} мин, ` +
    `анализ каждые ${config.service.analyzeEveryMin} мин по ${config.service.analyzeBatch}, модель ${config.llm.model}`,
);
