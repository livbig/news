/**
 * Отметка «мост жив»: файл bridge-heartbeat.json обновляется раз в минуту, пока процесс жив.
 * По его возрасту сторож в ассистенте (scripts/heartbeat.mjs) понимает, что мост молчит.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { HEARTBEAT_FILE, startHeartbeat } from '../src/heartbeat.js';

const dir = mkdtempSync(join(tmpdir(), 'bridge-hb-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const read = () => JSON.parse(readFileSync(join(dir, HEARTBEAT_FILE), 'utf8'));

test('отметка пишется сразу при запуске и несёт pid процесса', () => {
	const beat = startHeartbeat({ dir, now: () => Date.parse('2026-11-01T09:00:00.000Z') });
	try {
		const file = read();
		assert.equal(file.at, '2026-11-01T09:00:00.000Z');
		assert.equal(file.pid, process.pid);
	} finally {
		beat.stop();
	}
});

test('отметка обновляется по таймеру, stop снимает таймер', async () => {
	let now = Date.parse('2026-11-01T09:00:00.000Z');
	const beat = startHeartbeat({ dir, periodMs: 5, now: () => now });
	try {
		now += 60_000;
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(read().at, '2026-11-01T09:01:00.000Z', 'тик переписал файл');
	} finally {
		beat.stop();
	}
	const frozen = read().at;
	now += 60_000;
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(read().at, frozen, 'после stop файл не меняется');
});

test('сбой записи не роняет процесс, а виден в логе', () => {
	const warnings = [];
	const beat = startHeartbeat({ dir: '/нет/такого/каталога/x\0', log: { warn: (text) => warnings.push(text) } });
	try {
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /heartbeat/);
	} finally {
		beat.stop();
	}
});

test('без каталога отметка не пишется, таймер не заводится', () => {
	const beat = startHeartbeat({});
	assert.equal(beat.path, undefined);
	beat.beat();
	beat.stop();
});
