#!/usr/bin/env node
/**
 * Ручная проверка связки с pi без Telegram (FR1/FR2/FR3, без вызовов модели).
 *
 *   npm run smoke                  # только RPC-команды и список сессий, денег не тратит
 *   npm run smoke -- --prompt "ок" # + реальный прогон модели (тратит токены)
 *
 * Печатает отчёт и выходит с кодом 1 при любой ошибке.
 */

import { SessionManager } from '@earendil-works/pi-coding-agent';

import { createLogger } from '../src/log.js';
import { errorText } from '../src/mask.js';
import { createPi, resolveCliPath } from '../src/pi.js';
import { chunkText } from '../src/chunk.js';
import { listSessions, sessionLabel } from '../src/sessions.js';

const promptIndex = process.argv.indexOf('--prompt');
const promptText = promptIndex === -1 ? undefined : process.argv[promptIndex + 1];
const longRun = process.argv.includes('--long');
const LONG_PROMPT =
	'Напиши нумерованный список из 300 пунктов вида «N. краткое описание пункта». ' +
	'Без вступлений, без выводов, только сам список.';

function report(ok, title, detail) {
	process.stdout.write(`${ok ? '✔' : '✖'} ${title}${detail ? `\n    ${detail}` : ''}\n`);
}

async function main() {
	const config = { cwd: process.env.PI_TG_CWD?.trim() || process.cwd(), logLevel: process.env.PI_TG_LOG ?? 'warn' };
	const log = createLogger({ level: config.logLevel });
	const cliPath = resolveCliPath(config.cliPath);
	report(true, 'CLI pi найден', cliPath);

	const pi = createPi({ cliPath, cwd: config.cwd, args: [], log });
	await pi.start();

	const state = await pi.getState();
	report(true, 'get_state', `сессия ${state.sessionId?.slice(0, 8)} · ${state.sessionFile ?? '(файла ещё нет)'} · ${state.model?.provider}/${state.model?.id} · thinking ${state.thinkingLevel}`);

	const models = await pi.getAvailableModels();
	report(models.length > 0, 'get_available_models', `${models.length} моделей, например ${models[0]?.provider}/${models[0]?.id}`);

	const commands = await pi.getCommands();
	report(true, 'get_commands', commands.length ? commands.slice(0, 3).map((c) => `/${c.name}`).join(', ') : 'расширения/шаблоны/скиллы не найдены');

	const stats = await pi.getSessionStats();
	report(true, 'get_session_stats', `${stats.totalMessages ?? 0} сообщений, контекст ${stats.contextUsage?.percent ?? '?'}%`);

	// FR1 — список сессий через API SDK
	const sessions = await listSessions({ SessionManager });
	report(sessions.length > 0, 'SessionManager.listAll (FR1)', `найдено сессий: ${sessions.length}`);
	for (const [index, info] of sessions.slice(0, 3).entries()) {
		process.stdout.write(`    ${index + 1}. ${sessionLabel(info)} · ${info.id.slice(0, 8)} · ${info.cwd}\n`);
	}

	await pi.stop();

	// FR2 — поднять процесс pi прямо на нужной сессии (так работает /open: один процесс на сессию)
	const target = sessions.find((info) => info.path !== state.sessionFile) ?? sessions[0];
	if (target) {
		const bound = createPi({ cliPath, cwd: target.cwd || cwd, args: ['--session', target.path], log });
		await bound.start();
		const after = await bound.getState();
		report(
			after.sessionId === target.id,
			'запуск pi на конкретной сессии (FR2)',
			`${sessionLabel(target)}: ожидали ${target.id.slice(0, 8)}, получили ${after.sessionId?.slice(0, 8)}, сообщений ${after.messageCount}`,
		);
		await bound.stop();
	} else {
		report(false, 'запуск pi на конкретной сессии (FR2)', 'сессий нет — сначала создайте хотя бы одну');
	}

	/** Реальный прогон модели: собираем дельты стрима и итоговый текст. */
	async function runPrompt(text) {
		process.stdout.write(`    прогон модели (${text.length} симв. промпта)…\n`);
		const seen = [];
		let final;
		const unsubscribe = pi.onEvent((event) => {
			if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
				seen.push(event.assistantMessageEvent.delta);
			}
			if (event?.type === 'agent_end') {
				const last = [...(event.messages ?? [])].reverse().find((message) => message?.role === 'assistant');
				final = Array.isArray(last?.content)
					? last.content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
					: undefined;
			}
		});
		const disposition = await pi.prompt(text);
		await pi.waitForIdle(300_000);
		unsubscribe();
		const body = final ?? seen.join('');
		report(disposition === 'started' && seen.length > 0, 'prompt + message_update/text_delta (FR4)', `дельт: ${seen.length}, ответ: ${body.slice(0, 80).replace(/\n/g, ' ')}…`);
		return body;
	}

	if (promptText) await runPrompt(promptText);

	if (longRun) {
		const body = await runPrompt(LONG_PROMPT);
		const chunks = chunkText(body);
		report(
			body.length > 4096 && chunks.every((chunk) => chunk.length <= 4096),
			'разбивка длинного ответа (FR4)',
			`${body.length} символов → ${chunks.length} сообщений, максимум ${Math.max(0, ...chunks.map((chunk) => chunk.length))}`,
		);
	}

	process.stdout.write('\nПроверка связки с pi пройдена.\n');
}

main().catch(async (error) => {
	process.stderr.write(`\n✖ Проверка упала: ${errorText(error)}\n`);
	process.exit(1);
});
