// Единая точка входа бота: гейт → интент → действие.
// Сводка выполняется воркером (GitHub Actions): мега-вызов effort=max идёт 264 с,
// а инвокация платформы живёт 30 с (замер 2026-10-19, docs/tgcloud-migration.md §9).
// Здесь — мгновенные шаги: задача в БД, запуск воркера, ответ пользователю.

import { fetch } from 'sdk';
import { botApi } from '../lib/telegram.js';
import { gate, loadConfig } from '../lib/config.js';
import { route } from '../lib/intents.js';
import { digestWindow } from '../lib/digest.js';
import { LlmError, ask } from '../lib/llm.js';
import * as store from '../lib/store.js';
import { chunkMessage, escapeHtml } from '../lib/text.js';
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
      await dispatchDigest(chatId);
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
    await dispatchDigest(chatId);
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

/** Задача в БД + запуск воркера. Пользователь сразу видит, что работа пошла. */
async function dispatchDigest(chatId) {
  const config = await loadConfig();
  // Защита от параллельных прогонов (ревью 2026-10-19): второй воркер вычитывает
  // те же пункты и дублирует сообщения.
  const running = await store.latestJob(chatId);
  if (running?.status === 'running' && Date.now() - Date.parse(running.updatedAt ?? '') < 15 * 60 * 1000) {
    await send(chatId, `⏳ Сводка уже собирается (задача ${running.id}). Дождись результата — пришлю сюда.`);
    return;
  }
  const jobId = await store.createJob(chatId);
  if (!config.github.token || !config.github.repo) {
    await store.setJob(jobId, { status: 'failed', stage: 'dispatch', detail: 'нет GITHUB_DISPATCH_TOKEN/GITHUB_REPO' });
    await send(chatId, '⚠️ Воркер не настроен (нет GITHUB_DISPATCH_TOKEN и GITHUB_REPO). Сводка не запущена.');
    return;
  }
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${config.github.repo}/actions/workflows/${config.github.workflow}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.github.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: config.github.ref, inputs: { chat_id: String(chatId), job_id: String(jobId) } }),
    });
  } catch (error) {
    await store.setJob(jobId, { status: 'failed', stage: 'dispatch', detail: `сеть: ${String(error?.message ?? error).slice(0, 120)}` });
    await send(chatId, '⚠️ Не смог запустить воркер: сеть недоступна. Попробуй ещё раз.');
    return;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`dispatch ${response.status}: ${body.slice(0, 200)}`);
    await store.setJob(jobId, { status: 'failed', stage: 'dispatch', detail: `GitHub ${response.status}` });
    await send(chatId, `⚠️ GitHub не принял запуск (${response.status}). Проверь токен и workflow.`);
    return;
  }
  await store.setJob(jobId, { status: 'running', stage: 'dispatched', detail: `job ${jobId}` });
  await send(chatId, `🔎 Запустил сбор и анализ (задача ${jobId}). Обычно ${config.worker.eta} — прогресс увидишь сообщением ниже, сводку пришлю сюда.`);
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
