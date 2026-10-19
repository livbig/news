#!/usr/bin/env node
// Временный приём апдейтов без вебхука: long-polling getUpdates.
// Нужен, пока Serverless-приложение не получило новый токен бота (тогда платформа
// ставит вебхук сама и поллер сам замолкает: Telegram отвечает 409).
// Запускается по расписанию GitHub Actions, живёт ~4.5 минуты за раз.

import { execFileSync } from 'node:child_process';

const CLI = '@tgcloud/cli@0.2.0';
const botToken = process.env.BOT_TOKEN;
const budgetMs = Number(process.env.POLL_BUDGET_MS ?? 270000);
if (!botToken) throw new Error('poll: нужен BOT_TOKEN');

const log = (...args) => console.log(new Date().toISOString(), ...args);
const deadline = Date.now() + budgetMs;

async function tg(method, query = {}) {
  const url = new URL(`https://api.telegram.org/bot${botToken}/${method}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { method: 'POST' });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

function run(module, payload) {
  const out = execFileSync('npx', ['--yes', CLI, 'run', module, JSON.stringify(payload)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const line = out.split('\n').reverse().find((l) => l.startsWith('< '));
  return line ? line.slice(2).replace(/\s+\d+(?:\.\d+)?(?:ms|s)$/, '').trim() : '';
}

// Смещение берём ТОЛЬКО из БД. Раньше здесь был bootstrap через offset:-1 —
// он сдвигал offset за последнее сообщение, и непрочитанное терялось навсегда
// (инцидент 2026-10-19: «Сводка» пользователя так и не дошла).
let offset = 0;
try {
  const stored = run('endpoints/pollState', {});
  const parsed = JSON.parse(stored);
  offset = parsed.value ?? 0;
} catch (error) {
  log('смещение из БД не прочитано, начинаю с 0:', error.message);
}

log('старт, offset =', offset);
let handled = 0;
try {
while (Date.now() < deadline) {
  const { status, data } = await tg('getUpdates', { offset, timeout: 50, allowed_updates: JSON.stringify(['message', 'callback_query']) });
  if (status === 409) {
    log('вебхук установлен платформой — поллер больше не нужен, выходим');
    process.exit(0);
  }
  if (!data.ok) {
    log('getUpdates:', data.error_code, data.description);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    continue;
  }
  for (const update of data.result ?? []) {
    const message = update.message ?? update.callback_query?.message;
    const nextOffset = update.update_id + 1;
    if (!message?.chat?.id) {
      offset = nextOffset;
      log('пропуск апдейта', update.update_id, '(нет сообщения)');
      continue;
    }
    // Смещение двигаем ТОЛЬКО после успешной обработки (или после исчерпания повторов):
    // иначе падение платформы съедает сообщение навсегда — инцидент iter-30.
    let delivered = false;
    for (let attempt = 1; attempt <= 2 && !delivered; attempt += 1) {
      try {
        run(update.callback_query ? 'handlers/callback_query' : 'handlers/message', update.callback_query ?? message);
        delivered = true;
      } catch (error) {
        log(`ошибка обработки апдейта ${update.update_id} (попытка ${attempt}/2):`, error.message.slice(0, 300));
      }
    }
    if (delivered) handled += 1;
    offset = nextOffset;
  }
  try {
    run('endpoints/pollState', { set: offset });
  } catch (error) {
    log('смещение не сохранилось:', error.message);
  }
}
log('выход по бюджету, обработано', handled);
} finally {
// Самопродолжение в finally: обрыв цепочки = мёртвый бот. Cron GitHub на публичном
// репозитории с частым force-push не срабатывает вовсе (проверено 2026-10-19).
if (process.env.POLL_CHAIN !== '0' && process.env.DISPATCH_TOKEN) {
  const response = await fetch('https://api.github.com/repos/livbig/news/actions/workflows/poll.yml/dispatches', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  log('следующий прогон поллера:', response.status === 204 ? 'запущен' : `GitHub ${response.status}`);
}
}
