import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { allowedRoots, backupRules, blockedReason, checkPath, pathsIn } from '../src/memory/guard.js';

const env = {
	PI_HELPER_HOME: '/srv/dvoretsky/users/livbig',
	PI_HELPER_WORK_DIR: '/srv/dvoretsky/users/livbig/work',
	PI_CODING_AGENT_DIR: '/srv/dvoretsky/users/livbig/pi',
	PI_HELPER_MEMORY_DB: '/srv/dvoretsky/users/livbig/memory.db',
	PI_HELPER_TMP: '/srv/dvoretsky/users/livbig/tmp',
};

test('своя зона разрешена, чужая и системная — нет', () => {
	assert.equal(checkPath('/srv/dvoretsky/users/livbig/work/files/outbox/a.pdf', allowedRoots(env)), null);
	assert.equal(checkPath('/srv/dvoretsky/users/livbig/tmp/scratch.txt', allowedRoots(env)), null, 'свой tmp разрешён');
	assert.match(checkPath('/tmp/scratch.txt', allowedRoots(env)), /чужая зона/, 'общий /tmp — нет');
	assert.match(checkPath('/srv/dvoretsky/users/aliiinam/memory.db', allowedRoots(env)), /чужая зона/);
	assert.match(checkPath('/etc/passwd', allowedRoots(env)), /чужая зона/);
	assert.match(checkPath('/srv/dvoretsky/users/livbig/../aliiinam/x', allowedRoots(env)), /чужая зона/);
});

test('пути из аргументов инструментов: read/edit/массивы', () => {
	assert.deepEqual(pathsIn({ path: '/a/b' }), ['/a/b']);
	assert.deepEqual(pathsIn({ edits: [{ oldText: 'x', newText: 'y' }], path: '/w/AGENTS.md' }), ['/w/AGENTS.md']);
	assert.deepEqual(pathsIn({ paths: ['/a', '/b'] }), ['/a', '/b']);
	assert.deepEqual(pathsIn({ text: 'просто текст' }), [], 'свободный текст — не путь');
	// Относительный путь тоже проверяется: раньше `../../x` проходил мимо хука.
	assert.deepEqual(pathsIn({ path: '../../aliiinam/x' }), ['../../aliiinam/x']);
	assert.match(blockedReason('read', { path: '../../aliiinam/work/AGENTS.md' }, env), /чужая зона/);
});

test('блокировка: путь-инструмент с чужим путём, bash не трогаем', () => {
	assert.match(blockedReason('read', { path: '/srv/dvoretsky/users/aliiinam/work/AGENTS.md' }, env), /чужая зона/);
	assert.equal(blockedReason('read', { path: '/srv/dvoretsky/users/livbig/work/AGENTS.md' }, env), null);
	assert.equal(blockedReason('bash', { command: 'cat /etc/passwd' }, env), null, 'bash закрывает ОС, не хук');
});

test('правка AGENTS.md: копия в .history до изменения', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dv-guard-'));
	const work = join(dir, 'work');
	mkdirSync(work, { recursive: true });
	const rules = join(work, 'AGENTS.md');
	writeFileSync(rules, '# правила');
	const copy = backupRules(rules, new Date('2026-10-30T10:00:00Z'));
	assert.ok(copy.startsWith(join(work, '.history')));
	assert.equal(readdirSync(join(work, '.history')).length, 1);
	assert.equal(backupRules(join(work, 'файл.txt')), null);
});
