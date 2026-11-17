import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionPool } from '../src/session-pool.js';

function fakeTimer() {
	let time = 0;
	let seq = 0;
	const timers = new Map();
	return {
		now: () => time,
		setTimer: (fn, ms) => {
			const id = (seq += 1);
			timers.set(id, { fn, at: time + ms });
			return id;
		},
		clearTimer: (id) => timers.delete(id),
		advance(ms) {
			time += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= time) {
					timers.delete(id);
					timer.fn();
				}
			}
		},
	};
}

function makePool({ idleMs = 1000, maxIdle = 3, failStart = false } = {}) {
	const timer = fakeTimer();
	const created = [];
	const pool = createSessionPool({
		cliPath: '/fake/cli.js',
		log: { debug() {}, info() {}, warn() {}, error() {} },
		idleMs,
		maxIdle,
		...timer,
		createPi: (options) => {
			const instance = {
				options,
				stopped: 0,
				listeners: new Set(),
				async start() {
					if (failStart) throw new Error('не поднялся');
				},
				async stop() {
					instance.stopped += 1;
				},
				onEvent(listener) {
					instance.listeners.add(listener);
					return () => instance.listeners.delete(listener);
				},
				emit(event) {
					for (const listener of [...instance.listeners]) listener(event);
				},
				async getState() {
					const bound = options.args?.[0] === '--session' ? options.args[1] : undefined;
					return { sessionFile: bound, sessionId: bound ? 'bound' : undefined, sessionName: undefined };
				},
			};
			created.push(instance);
			return instance;
		},
		onEvent: (entry, event) => entry.received?.push(event),
	});
	return { pool, timer, created };
}

test('один процесс на сессию: повторное открытие переиспользует его', async () => {
	const { pool, created } = makePool();
	const first = await pool.acquire({ sessionPath: '/s/one.jsonl', cwd: '/p' });
	const second = await pool.acquire({ sessionPath: '/s/one.jsonl', cwd: '/p' });
	assert.equal(first, second);
	assert.equal(created.length, 1);
	assert.deepEqual(created[0].options.args, ['--session', '/s/one.jsonl']);
	assert.equal(created[0].options.cwd, '/p');
	assert.equal(pool.size(), 1);
});

test('чат без сессии получает свой процесс, новый /new — ещё один', async () => {
	const { pool, created } = makePool();
	const first = await pool.acquire({ cwd: '/p', chatKey: '100' });
	assert.equal(await pool.acquire({ cwd: '/p', chatKey: '100' }), first, 'тот же чат — тот же процесс');
	const fresh = await pool.acquireNew({ cwd: '/p', chatKey: '100' });
	assert.notEqual(fresh, first);
	assert.equal(created.length, 2);
	assert.equal(created[0].stopped, 1, 'старый несвязанный процесс погашен');
	assert.deepEqual(created[1].options.args, []);
});

test('rekey: появившийся путь сессии становится ключом записи', async () => {
	const { pool } = makePool();
	const entry = await pool.acquire({ cwd: '/p', chatKey: '100' });
	assert.equal(entry.key, 'unbound:1');
	const same = pool.rekey(entry, '/s/mine.jsonl');
	assert.equal(same, entry);
	assert.equal(entry.key, 'session:/s/mine.jsonl');
	assert.equal(pool.get('/s/mine.jsonl'), entry);
	assert.equal(pool.size(), 1);
});

test('rekey: если сессия уже открыта другим чатом — живём в её процессе', async () => {
	const { pool, created } = makePool();
	const opened = await pool.acquire({ sessionPath: '/s/shared.jsonl', cwd: '/p' });
	const unbound = await pool.acquire({ cwd: '/p', chatKey: '100' });
	const merged = pool.rekey(unbound, '/s/shared.jsonl');
	assert.equal(merged, opened);
	assert.equal(pool.size(), 1);
	assert.equal(created[1].stopped, 1, 'лишний процесс погашен');
});

test('бездействующий процесс гасится сам', async () => {
	const { pool, timer, created } = makePool({ idleMs: 1000 });
	const entry = await pool.acquire({ sessionPath: '/s/one.jsonl', cwd: '/p' });
	pool.release(entry);
	assert.equal(pool.size(), 1);
	timer.advance(999);
	assert.equal(pool.size(), 1);
	timer.advance(1);
	assert.equal(pool.size(), 0);
	assert.equal(created[0].stopped, 1);
});

test('занятый процесс не гасится, но и не остаётся навсегда', async () => {
	const { pool, timer, created } = makePool({ idleMs: 1000 });
	const entry = await pool.acquire({ sessionPath: '/s/one.jsonl', cwd: '/p' });
	entry.busy = true;
	pool.release(entry);
	timer.advance(1000);
	assert.equal(pool.size(), 1, 'идёт прогон — не трогаем');
	entry.busy = false;
	timer.advance(1000);
	assert.equal(pool.size(), 0);
	assert.equal(created[0].stopped, 1);
});

test('пул не разрастается: лишние бездействующие гасятся по LRU', async () => {
	// maxIdle=1: держим активный процесс и один бездействующий
	const { pool, created } = makePool({ maxIdle: 1 });
	await pool.acquire({ sessionPath: '/s/1.jsonl', cwd: '/p' });
	await pool.acquire({ sessionPath: '/s/2.jsonl', cwd: '/p' });
	assert.equal(pool.size(), 2);
	await pool.acquire({ sessionPath: '/s/3.jsonl', cwd: '/p' });
	assert.equal(pool.size(), 2, 'самый старый погашен');
	assert.equal(pool.get('/s/1.jsonl'), undefined);
	assert.equal(pool.get('/s/3.jsonl')?.session.path, '/s/3.jsonl');
	assert.equal(created[0].stopped, 1);
	assert.equal(created[1].stopped, 0);
});

test('если процесс не поднялся, запись не остаётся в пуле', async () => {
	const { pool } = makePool({ failStart: true });
	await assert.rejects(() => pool.acquire({ sessionPath: '/s/one.jsonl', cwd: '/p' }), /не поднялся/);
	assert.equal(pool.size(), 0);
});

test('события процесса приходят вместе с его записью', async () => {
	const { pool, created } = makePool();
	const entry = await pool.acquire({ sessionPath: '/s/one.jsonl', cwd: '/p' });
	entry.received = [];
	created[0].emit({ type: 'agent_start' });
	assert.deepEqual(entry.received, [{ type: 'agent_start' }]);
});

test('stopAll гасит всё', async () => {
	const { pool, created } = makePool();
	await pool.acquire({ sessionPath: '/s/1.jsonl', cwd: '/p' });
	await pool.acquire({ sessionPath: '/s/2.jsonl', cwd: '/p' });
	await pool.stopAll();
	assert.equal(pool.size(), 0);
	assert.deepEqual(
		created.map((instance) => instance.stopped),
		[1, 1],
	);
});

test('контекст сообщения уходит в процесс pi: PI_CHAT_* из апдейта', async () => {
	const { pool, created } = makePool();
	const env = { PI_CHAT_ID: '-1003432441991', PI_CHAT_TYPE: 'supergroup', PI_USER_ID: '710223847', PI_USER_NAME: 'Максим' };
	await pool.acquire({ cwd: '/p', chatKey: 'group-1', env });
	assert.deepEqual(created[0].options.env, env, 'без env агент не знает, где его попросили поставить напоминание');
});

test('сессия, открытая заново после простоя, поднимается с контекстом нового сообщения', async () => {
	const { pool, timer, created } = makePool({ idleMs: 1000 });
	await pool.acquire({ sessionPath: '/s/one.jsonl', cwd: '/p', env: { PI_CHAT_ID: '1' } });
	timer.advance(1000);
	await pool.acquire({ sessionPath: '/s/one.jsonl', cwd: '/p', env: { PI_CHAT_ID: '2' } });
	assert.equal(created.length, 2);
	assert.equal(created[1].options.env.PI_CHAT_ID, '2');
});
