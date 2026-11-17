/**
 * Живой прогон боевого пути без Telegram-сообщения: реальная модель → реальные дельты →
 * тот же `live.js` (черновики/правка/final) → реальный чат владельца.
 *
 *   npm run rehearse -- "промпт"
 *
 * Отправляет в спаренный чат из state.json. Проверяет то, чего не покрывает `npm run smoke`:
 * стрим, разбивку длинного ответа и rich-разметку живьём.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';

import { loadConfig } from '../src/config.js';
import { createLiveMessage } from '../src/live.js';
import { createLogger } from '../src/log.js';
import { createPi, resolveCliPath } from '../src/pi.js';
import { formatStatusHtml } from '../src/status.js';

const prompt = process.argv[2];
const wantStatus = process.argv.includes('--status');
if (!prompt && !wantStatus) throw new Error('нужен промпт или --status');
const config = loadConfig();
const log = createLogger({ level: 'warn' });
const stateFile = join(homedir(), '.pi', 'agent', 'pi-telegram-bridge', 'state.json');
const chatId = Number(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).chats ?? {})[0] ?? '');
if (!Number.isInteger(chatId) || chatId <= 0) throw new Error('в state.json нет ни одного чата — сначала напишите боту в Telegram');
console.log('чат:', chatId);

const bot = new Bot(config.botToken);
const pi = createPi({ cliPath: resolveCliPath(config.cliPath), cwd: config.cwd, args: [], log });
await pi.start();

// --status: ровно то сообщение, которое отдаёт команда /status, но по реальным данным pi
if (wantStatus) {
	const [current, stats] = await Promise.all([pi.getState(), pi.getSessionStats().catch(() => undefined)]);
	const html = formatStatusHtml({ state: current, stats, queue: 0, busy: false, processes: 1, cwd: config.cwd });
	await bot.api.sendRichMessage(chatId, { html });
	console.log('статус отправлен как rich-сообщение');
	await pi.stop();
	process.exit(0);
}

const live = createLiveMessage({ api: bot.api, chatId, rich: config.rich, draftEnabled: config.draftEnabled, log });
live.start();
const blocks = new Map();
let final;
let settled;
const done = new Promise((resolve) => (settled = resolve));

pi.onEvent((event) => {
	if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
		const update = event.assistantMessageEvent;
		blocks.set(update.contentIndex, `${blocks.get(update.contentIndex) ?? ''}${update.delta}`);
		live.update({ text: [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join(''), status: 'думаю…' });
	}
	if (event?.type === 'tool_execution_start') live.update({ status: `⚙ ${event.toolName}` });
	if (event?.type === 'agent_end') {
		const last = [...(event.messages ?? [])].reverse().find((m) => m?.role === 'assistant');
		final = Array.isArray(last?.content)
			? last.content.filter((b) => b?.type === 'text').map((b) => b.text).join('').trim()
			: undefined;
	}
	if (event?.type === 'agent_settled') settled();
});

const started = Date.now();
const disposition = await pi.prompt(prompt);
await done;
const text = final ?? [...blocks.values()].join('');
await live.finish({ text });
await pi.stop();
console.log(`готово за ${Math.round((Date.now() - started) / 1000)} с · формат живого сообщения: ${live.format} · ответ ${text.length} символов`);
