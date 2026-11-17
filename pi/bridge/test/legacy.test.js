import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { adoptLegacyPairing } from '../src/legacy.js';
import { createState } from '../src/state.js';

const TOKEN = '123456789:TESTTOKENFORUNITSONLY';

async function legacyFile(content) {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-legacy-'));
	const file = join(dir, 'telegram.json');
	await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
	return file;
}

async function emptyState() {
	const state = createState({ file: join(await mkdtemp(join(tmpdir(), 'pi-tg-legacy-')), 'state.json') });
	await state.load();
	return state;
}

test('переносит спаренного пользователя и offset того же бота', async () => {
	const state = await emptyState();
	const file = await legacyFile({ botToken: TOKEN, allowedUserId: 123456789, lastUpdateId: 626004921, botUsername: 'x' });
	const result = await adoptLegacyPairing({ state, botToken: TOKEN, file });
	assert.equal(result.adopted, true);
	assert.equal(state.get().allowedUserId, 123456789);
	assert.equal(state.get().lastUpdateId, 626004921);
});

test('чужой бот не переносится', async () => {
	const state = await emptyState();
	const file = await legacyFile({ botToken: '999999999:ZZZ', allowedUserId: 1, lastUpdateId: 2 });
	const result = await adoptLegacyPairing({ state, botToken: TOKEN, file });
	assert.equal(result.adopted, false);
	assert.equal(state.get().allowedUserId, undefined);
	assert.equal(state.get().lastUpdateId, undefined);
});

test('свои данные важнее старых', async () => {
	const state = await emptyState();
	state.setPairedUser(777);
	state.setLastUpdateId(500);
	const file = await legacyFile({ botToken: TOKEN, allowedUserId: 111, lastUpdateId: 222 });
	await adoptLegacyPairing({ state, botToken: TOKEN, file });
	assert.equal(state.get().allowedUserId, 777);
	assert.equal(state.get().lastUpdateId, 500);
});

test('битый или отсутствующий файл не ломает старт', async () => {
	const state = await emptyState();
	const broken = await legacyFile('{ это не json');
	assert.equal((await adoptLegacyPairing({ state, botToken: TOKEN, file: broken })).adopted, false);
	assert.equal((await adoptLegacyPairing({ state, botToken: TOKEN, file: '/nope/nope.json' })).adopted, false);
	assert.equal(state.get().allowedUserId, undefined);
});

test('токен не переносится на диск', async () => {
	const state = await emptyState();
	const file = await legacyFile({ botToken: TOKEN, allowedUserId: 5 });
	await adoptLegacyPairing({ state, botToken: TOKEN, file });
	assert.equal(JSON.stringify(state.get()).includes(TOKEN), false);
});
