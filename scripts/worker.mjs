#!/usr/bin/env node
// Воркер сводки: GitHub Actions (workflow_dispatch от кнопки бота).
// Почему снаружи платформы: замер 2026-10-19 — мега-вызов effort=max идёт 264 с,
// а инвокация платформы живёт 30 с (docs/tgcloud-migration.md §9).
// Здесь только LLM; сбор и запись — эндпоинты платформы (они быстрые).

import { execFileSync } from 'node:child_process';
import { summarizeWith } from '../tgcloud/lib/llm-core.js';
import { SETTINGS } from '../tgcloud/lib/settings.js';
import { EMPTY_TEXT, composeDigest, periodHeader } from '../tgcloud/lib/digest.js';
import { chunkMessage, escapeHtml, plural } from '../tgcloud/lib/text.js';

const CLI = '@tgcloud/cli@0.2.0';
const chatId = Number(process.env.CHAT_ID);
const jobId = Number(process.env.JOB_ID);
const botToken = process.env.BOT_TOKEN;
if (!chatId || !botToken) throw new Error('worker: нужны CHAT_ID и BOT_TOKEN');

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function tg(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) log(`telegram ${method}:`, data.error_code, data.description);
  return data.result ?? null;
}

/** Отправка куска сводки: повтор один раз, при отказе разметки — без parse_mode. */
async function sendChunk(chunk, { plain = false } = {}) {
  const body = { chat_id: chatId, text: plain ? chunk.replace(/<[^>]+>/g, '') : chunk, link_preview_options: { is_disabled: true } };
  if (!plain) body.parse_mode = 'HTML';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await tg('sendMessage', body);
    if (result) return true;
    await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
  }
  return false;
}

/** Статус-сообщение, которое дописывается по шагам: пользователь видит, что бот жив. */
async function status(text, messageId = null) {
  if (!messageId) return (await tg('sendMessage', { chat_id: chatId, text, disable_notification: true }))?.message_id ?? null;
  await tg('editMessageText', { chat_id: chatId, message_id: messageId, text });
  return messageId;
}

/** Эндпоинт платформы. Возвращает JSON-строку (CLI печатает `< "..."`). */
function run(module, payload) {
  let out;
  try {
    out = execFileSync('npx', ['--yes', CLI, 'run', module, JSON.stringify(payload)], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: process.env,
    });
  } catch (error) {
    // stderr CLI — единственный способ понять отказ платформы (нет снапшота, 401, ошибка модуля)
    const raw = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim();
    const detail = raw.split(String.fromCharCode(10)).slice(-6).join(' | ');
    throw new Error(`${module} не выполнился: ${detail.slice(0, 600)}`);
  }
  const line = out
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('< '));
  if (!line) throw new Error(`${module}: нет ответа от платформы\n${out.slice(-800)}`);
  // CLI печатает `< <значение>  1234ms`: значение уже JSON-объект (он разбирает нашу
  // JSON-строку и печатает результат), поэтому парсим один раз и разворачиваем строку.
  const value = line.slice(2).replace(/\s+\d+(?:\.\d+)?(?:ms|s)$/, '').trim();
  if (value === 'undefined') throw new Error(`${module}: платформа вернула undefined`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${module}: ответ не JSON (${error.message}): ${value.slice(0, 300)}`);
  }
  if (typeof parsed !== 'string') return parsed;
  return JSON.parse(parsed);
}

const config = {
  llm: {
    ...SETTINGS.llm,
    apiKey: process.env.LLM_API_KEY ?? '',
    baseUrl: process.env.LLM_BASE_URL || SETTINGS.llm.baseUrl,
    model: process.env.LLM_MODEL || SETTINGS.llm.model,
  },
  digest: SETTINGS.digest,
  tz: SETTINGS.tz,
};

const started = Date.now();
let statusId = null;
let heartbeat = null;

try {
  statusId = await status('🔎 Собираю ленту…');
  // Сбор партиями по 8 источников: один вызов платформы живёт 30 с, а сеть медленная.
  // Типы: rss, twitter (RSS-мост), tgweb (последовательно, через зеркало).
  const collected = { sources: 0, added: 0, errors: [], partial: [], unsupported: [] };
  for (const kind of ['rss', 'twitter', 'tgweb']) {
    let offset = 0;
    for (let round = 0; round < 10; round += 1) {
      let batch;
      try {
        batch = run('endpoints/collect', { chatId, jobId: round === 0 ? jobId : 0, kind, offset, limit: 8 });
      } catch (error) {
        // Сбой партии не отменяет сводку: фиксируем и идём дальше (NFR-02).
        collected.errors.push(`${kind}[${offset}]`);
        log(`партия ${kind}@${offset} упала:`, error.message.slice(0, 200));
        break;
      }
      collected.sources += batch.sources;
      collected.added += batch.added;
      collected.errors.push(...batch.errors);
      collected.partial.push(...batch.partial);
      collected.unsupported.push(...(batch.unsupported ?? []));
      if (!batch.remaining) break;
      offset += batch.sources;
    }
  }
  collected.unsupported = [...new Set(collected.unsupported)];
  log('сбор:', JSON.stringify(collected));

  await status(`🧠 Отбираю новости из ${plural(collected.sources, 'источника', 'источников', 'источников')}…`, statusId);
  const picked = run('endpoints/select', { chatId, jobId });
  log('отбор:', picked.count, 'пунктов,', picked.itemsText.length, 'символов');

  if (!picked.count) {
    await status(`📭 ${EMPTY_TEXT}`, statusId);
    run('endpoints/jobState', { jobId, status: 'done', stage: 'empty', detail: 'новостей нет' });
    process.exit(0);
  }

  await status(`🧠 Думаю над ${plural(picked.count, 'пунктом', 'пунктами', 'пунктами')} (effort=max, обычно 4-6 минут)…`, statusId);
  // Живой прогресс: пока идёт генерация, раз в минуту показываем, сколько уже прошло.
  heartbeat = setInterval(() => {
    const minutes = Math.floor((Date.now() - started) / 60000);
    status(`🧠 Думаю… ${minutes} мин, ${plural(picked.count, 'пункт', 'пункта', 'пунктов')} на входе`, statusId).catch(() => {});
  }, 60000);

  const summary = await summarizeWith({
    http: fetch,
    config,
    itemsText: picked.itemsText,
    interests: picked.interests,
    onProgress: () => {},
  });
  clearInterval(heartbeat);
  heartbeat = null;

  const text = composeDigest({
    header: periodHeader(picked.periodFrom, picked.periodTo, config.tz.offsetMin),
    summary,
    capped: picked.capped,
    errors: collected.errors,
    partial: collected.partial,
    unsupported: collected.unsupported,
  });

  if (statusId) {
    await tg('deleteMessage', { chat_id: chatId, message_id: statusId }).catch(() => {});
    statusId = null;
  }
  // Отправляем сами: токен бота у воркера живой, а Bot API-доступ платформы
  // может быть недоступен (перепривязка в BotFather) — сводка не должна от этого зависеть.
  const chunks = chunkMessage(text, config.digest.messageLimit);
  let sent = 0;
  for (const chunk of chunks) {
    let ok = await sendChunk(chunk);
    if (!ok) ok = await sendChunk(chunk, { plain: true }); // 400 из-за разметки — шлём текстом
    if (!ok) {
      // Не помечаем пункты прочитанными: они уйдут в следующую сводку.
      throw new Error(`не удалось отправить часть ${sent + 1} из ${chunks.length}`);
    }
    sent += 1;
  }
  const ingested = run('endpoints/ingest', { chatId, jobId, text, sent, ids: picked.ids, periodFrom: picked.periodFrom, periodTo: picked.periodTo });
  log('отправлено:', JSON.stringify({ chunks: sent, ...ingested }), 'за', Math.round((Date.now() - started) / 1000), 'с');
} catch (error) {
  if (heartbeat) clearInterval(heartbeat);
  log('ошибка:', error?.stack ?? error);
  if (statusId) await tg('deleteMessage', { chat_id: chatId, message_id: statusId }).catch(() => {});
  const reason = String(error?.message ?? error)
    .replace(/\b(sk|key)[-_A-Za-z0-9]{8,}/gi, '[ключ]')
    .replace(/\bapp\d+:[A-Za-z0-9_-]+/g, '[токен платформы]')
    .replace(/\b\d{8,}:[A-Za-z0-9_-]{30,}/g, '[токен бота]')
    .slice(0, 300);
  await tg('sendMessage', { chat_id: chatId, text: `⚠️ Сводка не удалась: ${escapeHtml(reason)}` });
  try {
    run('endpoints/jobState', { jobId, status: 'failed', stage: 'error', detail: reason });
  } catch {}
  process.exit(1);
}
