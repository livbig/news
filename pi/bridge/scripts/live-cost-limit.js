#!/usr/bin/env node
/**
 * Живая проверка потолка стоимости прогона (PI_TG_TURN_MAX_COST_USD) на настоящем pi.
 * Telegram не задействован: бот — grammY с transformer вместо Bot API, поэтому все сообщения,
 * которые ушли бы владельцу, печатаются и проверяются здесь. pi, модель, расход и остановка — настоящие.
 *
 *   PI_TG_TURN_MAX_COST_USD=0.0001 node --env-file-if-exists=.env scripts/live-cost-limit.js
 *   node --env-file-if-exists=.env scripts/live-cost-limit.js --expect 0.0001 --prompt "…"
 *
 * Код выхода: 0 — прогон остановлен по лимиту и сообщение сформировано; 1 — не сработало.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bot } from 'grammy';

import { createBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { createPi, resolveCliPath } from '../src/pi.js';
import { createState } from '../src/state.js';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
	const at = args.indexOf(name);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const EXPECT = Number(argValue('--expect', process.env.PI_TG_TURN_MAX_COST_USD ?? 2));
const PROMPT = argValue('--prompt', 'Посчитай вслух: 17*23 и 41*19. Ответь двумя строками, без инструментов.');
const CWD = argValue('--cwd', process.env.PI_TG_CWD ?? tmpdir());
const USER = 424242;
const CHAT = 424242;
const TIMEOUT_MS = Number(argValue('--timeout', '240000'));

const config = loadConfig({ ...process.env, PI_TG_TURN_MAX_COST_USD: String(EXPECT) });
const api = [];
const bot = new Bot(config.botToken, {
	botInfo: { id: 1, is_bot: true, first_name: 'limit-check', username: 'limit_check_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false },
});
bot.api.config.use(async (_prev, method, payload) => {
	api.push({ method, payload });
	return { ok: true, result: { message_id: api.length } };
});

const state = createState({ file: join(mkdtempSync(join(tmpdir(), 'limit-state-')), 'state.json') });
await state.load();
const bridge = createBridge({
	bot,
	state,
	config: { ...config, cwd: CWD, allowedUserIds: [USER] },
	log: createLogger({ level: process.env.PI_TG_LOG ?? 'info' }),
	SessionManager: { listAll: async () => [] },
	cliPath: resolveCliPath(config.cliPath),
	createPi: (options) => createPi({ ...options, log: createLogger({ level: 'warn' }) }),
});
bridge.install();

console.log(`лимит прогона: $${EXPECT}, каталог ${CWD}, модель ${config.piArgs.join(' ') || 'по умолчанию'}`);
await bot.handleUpdate({
	update_id: 1,
	message: {
		message_id: 1,
		date: Math.floor(Date.now() / 1000),
		chat: { id: CHAT, type: 'private' },
		from: { id: USER, is_bot: false, first_name: 'Фаундер' },
		text: PROMPT,
	},
});

const started = Date.now();
let stopped = false;
while (Date.now() - started < TIMEOUT_MS) {
	await new Promise((resolve) => setTimeout(resolve, 200));
	if (api.some((call) => /остановил себя/.test(JSON.stringify(call.payload ?? {})))) {
		stopped = true;
		break;
	}
	// Финал пришёл, а лимита в нём нет — дальше ждать нечего.
	if (api.some((call) => call.method === 'sendMessage' || call.method === 'sendRichMessage')) break;
}
await new Promise((resolve) => setTimeout(resolve, 800));

const shown = api
	.filter((call) => /send|edit/.test(call.method))
	.map((call) => `${call.method}: ${(call.payload?.text ?? call.payload?.rich_message?.markdown ?? call.payload?.rich_message?.html ?? '').slice(0, 300)}`);
console.log(`сообщений бота: ${shown.length}`);
for (const line of shown) console.log(`  ${line}`);
await bridge.stop();
await bot.stop();
process.exit(stopped ? 0 : 1);
