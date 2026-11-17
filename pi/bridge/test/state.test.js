import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createState, sessionKey } from '../src/state.js';

async function tempFile(name = 'state.json') {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-state-'));
	return join(dir, name);
}

test('маппинг чат → сессия переживает перезапуск', async () => {
	const file = await tempFile();
	const first = createState({ file });
	await first.load();
	first.setSession(100, { sessionPath: '/tmp/s.jsonl', sessionId: 'abc', name: 'работа' });
	first.setLastUpdateId(42);
	await first.save();

	const second = createState({ file });
	await second.load();
	assert.deepEqual(
		{ path: second.getSession(100)?.sessionPath, id: second.getSession(100)?.sessionId, name: second.getSession(100)?.name },
		{ path: '/tmp/s.jsonl', id: 'abc', name: 'работа' },
	);
	assert.equal(second.get().lastUpdateId, 42);
});

test('ключ сессии: личка — dm:<userId>, группа — group:<chatId>, тема не учитывается', async () => {
	assert.equal(sessionKey(710223847), 'dm:710223847');
	assert.equal(sessionKey(-1003432441991), 'group:-1003432441991');

	const state = createState({ file: await tempFile() });
	await state.load();
	state.setSession(710223847, { sessionPath: '/a.jsonl' });
	assert.equal(state.getSession(710223847).sessionPath, '/a.jsonl');
	assert.equal(state.getSession(-1003432441991), undefined, 'у группы своя запись');
});

test('старые ключи с темой форума сводятся к ключу чата, свежая запись побеждает', async () => {
	const file = await tempFile();
	await writeFile(
		file,
		JSON.stringify({
			version: 1,
			chats: {
				'-1003432441991:32846': { sessionPath: '/topic-32846.jsonl', updatedAt: '2026-10-28T09:25:27.000Z' },
				'-1003432441991': { sessionPath: '/group.jsonl', updatedAt: '2026-10-28T09:32:07.000Z' },
				'-1003432441991:32587': { sessionPath: '/topic-32587.jsonl', updatedAt: '2026-10-27T14:54:34.000Z' },
				'710223847': { sessionPath: '/dm.jsonl', updatedAt: '2026-10-28T10:57:25.000Z' },
			},
		}),
		'utf8',
	);
	const state = createState({ file });
	await state.load();
	assert.deepEqual(Object.keys(state.get().chats).sort(), ['dm:710223847', 'group:-1003432441991']);
	assert.equal(state.getSession(-1003432441991).sessionPath, '/group.jsonl');
	assert.equal(state.getSession(710223847).sessionPath, '/dm.jsonl');
});

test('пустая сессия снимает маппинг', async () => {
	const state = createState({ file: await tempFile() });
	await state.load();
	state.setSession(7, { sessionPath: '/x.jsonl' });
	state.setSession(7, { sessionPath: undefined, sessionId: undefined });
	assert.equal(state.getSession(7), undefined);
});

test('битый json уезжает в бэкап, мост стартует пустым', async () => {
	const file = await tempFile();
	await writeFile(file, '{ это не json', 'utf8');
	const warnings = [];
	const state = createState({ file, log: { warn: (m) => warnings.push(m) } });
	await state.load();
	assert.deepEqual(state.get().chats, {});
	assert.equal(warnings.length, 1);
	const backups = (await readdir(join(file, '..'))).filter((name) => name.includes('corrupt'));
	assert.equal(backups.length, 1);
});

	test('чужие поля не ломают загрузку', async () => {
	const file = await tempFile();
	await writeFile(file, JSON.stringify({ version: 99, chats: { 5: { sessionPath: '/s.jsonl' } }, мусор: true }), 'utf8');
	const state = createState({ file });
	await state.load();
	assert.equal(state.getSession(5).sessionPath, '/s.jsonl');
	assert.equal(state.get().allowedUserId, undefined);
	assert.equal(state.get().version, 1);
});

test('файл состояния не содержит токен', async () => {
	const file = await tempFile();
	const state = createState({ file });
	await state.load();
	state.setPairedUser(123);
	await state.save();
	const raw = await readFile(file, 'utf8');
	assert.equal(/[0-9]{5,}:[A-Za-z0-9_-]{15,}/.test(raw), false);
});
