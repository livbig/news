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

const state = await tg('getUpdates', { limit: 1, offset: -1, timeout: 0 });
let offset = state.data?.result?.[0]?.update_id;
offset = offset ? offset + 1 : 0;
// Смещение из БД надёжнее: локальное значение теряется между запусками.
try {
  const stored = run('endpoints/pollState', {});
  const parsed = JSON.parse(stored);
  if (typeof parsed === 'string') offset = Math.max(offset, JSON.parse(parsed).value ?? 0);
  else offset = Math.max(offset, parsed.value ?? 0);
} catch (error) {
  log('смещение из БД не прочитано:', error.message);
}

log('старт, offset =', offset);
let handled = 0;
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
    offset = update.update_id + 1;
    const message = update.message ?? update.callback_query?.message;
    if (!message?.chat?.id) {
      log('пропуск апдейта', update.update_id, '(нет сообщения)');
      continue;
    }
    try {
      run(update.callback_query ? 'handlers/callback_query' : 'handlers/message', update.callback_query ?? message);
      handled += 1;
      log('обработан апдейт', update.update_id, 'chat', message.chat.id);
    } catch (error) {
      log('ошибка обработки', update.update_id, error.message.slice(0, 300));
    }
  }
  try {
    run('endpoints/pollState', { set: offset });
  } catch (error) {
    log('смещение не сохранилось:', error.message);
  }
}
log('выход по бюджету, обработано', handled);
