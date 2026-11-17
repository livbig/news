import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DatabaseSync } from 'node:sqlite';
import { pruneOlder, pruneSessions, sha256, snapshotDb } from '../src/ops.js';

test('снимок базы читается и содержит данные', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dv-ops-'));
	const src = join(dir, 'memory.db');
	const db = new DatabaseSync(src);
	db.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, status TEXT)');
	db.prepare("INSERT INTO facts (status) VALUES ('active')").run();
	db.close();

	const copy = join(dir, 'backup', 'memory-copy.db');
	assert.equal(snapshotDb(src, copy), true);
	const restored = new DatabaseSync(copy, { readOnly: true });
	assert.equal(restored.prepare("SELECT COUNT(*) n FROM facts WHERE status='active'").get().n, 1);
	restored.close();
});

test('снимок отсутствующей базы — false, без падения', () => {
	assert.equal(snapshotDb('/nope/memory.db', '/tmp/x.db'), false);
});

test('уборка логов и сессий: старое уходит, свежее остаётся', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dv-prune-'));
	const old = join(dir, 'bridge-old.txt');
	const fresh = join(dir, 'bridge-new.txt');
	writeFileSync(old, 'x');
	writeFileSync(fresh, 'y');
	const monthAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
	utimesSync(old, monthAgo, monthAgo);

	assert.equal(pruneOlder(dir, 14, { keepExtensions: ['.txt'] }), 1);
	assert.equal(pruneSessions(dir, 30), 0, 'логи — не сессии');

	const sessions = join(dir, 'sessions');
	mkdirSync(sessions);
	const stale = join(sessions, 'a.jsonl');
	writeFileSync(stale, '{}');
	utimesSync(stale, monthAgo, monthAgo);
	assert.equal(pruneSessions(sessions, 30), 1);
});

test('sha256 считается по файлу', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dv-hash-'));
	const file = join(dir, 'a.txt');
	writeFileSync(file, 'abc');
	assert.equal(sha256(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
