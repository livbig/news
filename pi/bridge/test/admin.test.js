import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendAudit, listZoneFiles, readHistory } from '../src/admin.js';

const entry = (role, text) =>
	JSON.stringify({ type: 'message', timestamp: '2026-10-30T10:00:00.000Z', message: { role, content: [{ type: 'text', text }] } });

test('история: только user/assistant, старые раньше новых', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dv-hist-'));
	await writeFile(join(dir, 'a.jsonl'), ['header', entry('system', 'правила'), entry('user', 'привет'), entry('assistant', 'здравствуй')].join('\n'));
	await writeFile(join(dir, 'b.jsonl'), [entry('user', 'второй файл')].join('\n'));
	await new Promise((resolve) => setTimeout(resolve, 10));
	await writeFile(join(dir, 'b.jsonl'), [entry('user', 'второй файл')].join('\n'));

	const rows = await readHistory(dir, 5);
	assert.deepEqual(rows.map((row) => row.text), ['привет', 'здравствуй', 'второй файл']);
	assert.equal(rows.at(-1).role, 'user');
});

test('история: пустой каталог и мусор в строках не роняют', async () => {
	assert.deepEqual(await readHistory('/nope'), []);
	const dir = await mkdtemp(join(tmpdir(), 'dv-hist2-'));
	await writeFile(join(dir, 'x.jsonl'), '{не json}\n{"type":"message","message":{"role":"user","content":"строка текстом"}}');
	const rows = await readHistory(dir, 5);
	assert.deepEqual(rows.map((row) => row.text), ['строка текстом']);
});

test('файлы зоны: имена и размеры, без содержимого', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dv-files-'));
	await mkdir(join(dir, 'inbox'), { recursive: true });
	await writeFile(join(dir, 'inbox', 'фото.jpg'), 'xx');
	const listed = await listZoneFiles(dir);
	assert.equal(listed.inbox.length, 1);
	assert.equal(listed.inbox[0].name, 'фото.jpg');
	assert.equal(listed.outbox.length, 0);
});

test('аудит: строка JSONL с кем/что/когда', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dv-audit-'));
	const file = join(dir, 'nested', 'admin-audit.log');
	await appendAudit(file, { at: '2026-10-30T10:00:00.000Z', by: 'livbig', action: 'admin-view', target: 'aliiinam', summary: 'history 20' });
	const text = await (await import('node:fs/promises')).readFile(file, 'utf8');
	const row = JSON.parse(text.trim());
	assert.equal(row.by, 'livbig');
	assert.equal(row.target, 'aliiinam');
	assert.equal(row.action, 'admin-view');
});
