/**
 * Обёртка pi-package: проверяем логику команд напрямую (без запуска демона).
 * Node 24 удаляет типы у .ts сам, поэтому расширение импортируется как есть.
 * Путь к pid-файлу расширение вычисляет при загрузке модуля, поэтому песочница одна на файл.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let sandboxPromise;

function sandbox() {
	sandboxPromise ??= (async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pi-tg-ext-'));
		const stateFile = join(dir, 'state.json');
		const pidFile = join(dir, 'bridge.pid');
		process.env.PI_TG_STATE_FILE = stateFile;

		const module = await import('../extensions/pi-telegram-bridge.ts');
		let handler;
		const events = new Map();
		module.default({
			registerCommand(name, options) {
				assert.equal(name, 'telegram-bridge');
				handler = options.handler;
			},
			on(event, eventHandler) {
				events.set(event, eventHandler);
			},
		});
		assert.ok(handler, 'команда /telegram-bridge должна регистрироваться');

		const notified = [];
		const statuses = [];
		const ctx = {
			cwd: '/tmp',
			ui: {
				notify: (message) => notified.push(message),
				setStatus: (key, text) => statuses.push([key, text]),
			},
		};
		return {
			dir,
			stateFile,
			pidFile,
			context: ctx,
			statuses,
			events,
			async emit(event) {
				await events.get(event)?.({}, ctx);
			},
			async run(args) {
				await handler(args, ctx);
				return notified.at(-1) ?? '';
			},
		};
	})();
	return sandboxPromise;
}

test('status без запущенного демона честно об этом говорит', async () => {
	const { pidFile, run } = await sandbox();
	await writeFile(pidFile, '999999999\n', 'utf8');
	assert.match(await run('status'), /Мост не запущен/);
});

test('status видит живой процесс и считает чаты в состоянии', async () => {
	const { pidFile, stateFile, run } = await sandbox();
	await writeFile(pidFile, `${process.pid}\n`, 'utf8');
	await writeFile(stateFile, JSON.stringify({ version: 1, chats: { 100: { sessionPath: '/s.jsonl' } } }), 'utf8');
	const text = await run('status');
	assert.match(text, new RegExp(`pid ${process.pid}`));
	assert.match(text, /чатов в маппинге: 1/);
});

test('start не поднимает второй демон поверх живого', async () => {
	const { pidFile, run } = await sandbox();
	// Живой pid = pid этого теста: start обязан отказаться и ничего не запускать.
	await writeFile(pidFile, `${process.pid}\n`, 'utf8');
	assert.match(await run('start'), /уже запущен/);
	assert.equal((await readFile(pidFile, 'utf8')).trim(), String(process.pid));
});

test('stop без живого процесса убирает pid-файл и не падает', async () => {
	const { pidFile, run } = await sandbox();
	await writeFile(pidFile, '999999999\n', 'utf8');
	assert.match(await run('stop'), /Мост не запущен/);
	assert.equal(existsSync(pidFile), false);
});

test('📡 в нижней панели появляется, когда демон жив, и убирается, когда умирает', async () => {
	const { pidFile, statuses, emit, run } = await sandbox();
	await writeFile(pidFile, `${process.pid}\n`, 'utf8');
	await emit('session_start');
	assert.deepEqual(statuses.at(-1), ['2-telegram-bridge', '📡']);

	await writeFile(pidFile, '999999999\n', 'utf8');
	await run('status');
	assert.deepEqual(statuses.at(-1), ['2-telegram-bridge', undefined], 'индикатор убирается');

	await writeFile(pidFile, `${process.pid}\n`, 'utf8');
	await run('status');
	assert.deepEqual(statuses.at(-1), ['2-telegram-bridge', '📡'], 'возвращается, когда мост снова жив');

	await emit('session_shutdown');
	assert.deepEqual(statuses.at(-1), ['2-telegram-bridge', undefined]);
});

test('индикатор не мигает: повторный вызов не шлёт setStatus зря', async () => {
	const { pidFile, statuses, emit } = await sandbox();
	await writeFile(pidFile, `${process.pid}\n`, 'utf8');
	await emit('session_start');
	const before = statuses.length;
	await emit('session_start');
	assert.equal(statuses.length, before, 'состояние не менялось — вывода нет');
});

test('неизвестное действие подсказывает доступные', async () => {
	const { run } = await sandbox();
	const text = await run('logs');
	assert.match(text, /Неизвестное действие/);
	assert.match(text, /start \| stop \| status/);
});

test('расширение не печатает токен', async () => {
	const { pidFile, run } = await sandbox();
	await writeFile(pidFile, `${process.pid}\n`, 'utf8');
	process.env.PI_TG_BOT_TOKEN = '123456789:TESTTOKENFORUNITSONLY';
	try {
		const text = await run('status');
		assert.equal(text.includes('123456789:TESTTOKENFORUNITSONLY'), false);
	} finally {
		delete process.env.PI_TG_BOT_TOKEN;
	}
});

test('песочница убирается', async () => {
	const { dir } = await sandbox();
	await rm(dir, { recursive: true, force: true });
	assert.equal(existsSync(dir), false);
});
