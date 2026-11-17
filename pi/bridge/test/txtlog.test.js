/**
 * Текстовый лог моста: файл на сутки, строка с ISO-временем, обрезка до 120 символов,
 * маскирование токена, ротация старше 14 суток. Полный текст сообщения клиента в лог не идёт.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { clip, createTextLog, KEEP_DAYS, pruneLogs, TEXT_LIMIT } from '../src/txtlog.js';

const dirs = [];
const freshDir = () => {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-log-'));
	dirs.push(dir);
	return dir;
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const NOW = new Date('2026-11-01T09:00:00.000Z');

test('длинный текст обрезается до лимита, переводы строк схлопываются', () => {
	assert.equal(clip('   два\n\nслова  '), 'два слова');
	const long = 'клиент '.repeat(40);
	assert.equal(clip(long).length, TEXT_LIMIT + 1);
});

test('строка лога: время, уровень, имя файла по дате', () => {
	const dir = freshDir();
	const textLog = createTextLog({ dir, now: () => NOW });
	textLog.info('вход: чат -1003432441991 · supergroup · Максим (710223847)');
	assert.match(
		readFileSync(join(dir, 'bridge-2026-11-01.txt'), 'utf8'),
		/^2026-11-01T09:00:00\.000Z \[info\] вход: чат -1003432441991 · supergroup · Максим \(710223847\)\n$/,
	);
});

test('токен бота в лог не попадает', () => {
	const dir = freshDir();
	const textLog = createTextLog({ dir, now: () => NOW });
	textLog.error('Bot API 401 для 123456789:AAexample-not-real-token-000000000');
	const line = readFileSync(join(dir, 'bridge-2026-11-01.txt'), 'utf8');
	assert.ok(!line.includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'), 'секрет замаскирован');
	assert.match(line, /1234…/);
});

test('телефон и почта клиента в лог не попадают, текст сообщения остаётся', () => {
	const dir = freshDir();
	const textLog = createTextLog({ dir, now: () => NOW });
	textLog.info('вход: чат -1003432441991 · supergroup · Максим (710223847) · позвонить Ивану +7 916 123-45-67, почта ivan@example.com');
	const line = readFileSync(join(dir, 'bridge-2026-11-01.txt'), 'utf8');
	assert.equal(line.includes('916'), false, 'телефон замаскирован');
	assert.equal(line.includes('ivan@example.com'), false, 'почта замаскирована');
	assert.match(line, /\[телефон\]/);
	assert.match(line, /\[почта\]/);
	assert.match(line, /позвонить Ивану/, 'суть сообщения для разбора остаётся');
});

test('ошибка записи не роняет мост: предупреждение и undefined', () => {
	const warnings = [];
	const textLog = createTextLog({ dir: '/нет/такого/каталога/x\0', log: { warn: (text) => warnings.push(text) } });
	assert.equal(textLog.info('не запишется'), undefined);
	assert.equal(warnings.length, 1);
});

test('ротация: файлы старше 14 суток удаляются при первой записи дня, чужие не трогаются', () => {
	const dir = freshDir();
	for (const day of ['2026-10-01', '2026-10-17', '2026-10-20']) writeFileSync(join(dir, `bridge-${day}.txt`), 'старое\n');
	writeFileSync(join(dir, 'assistant-2026-10-01.txt'), 'чужой лог\n');

	createTextLog({ dir, now: () => NOW }).info('ротация');
	const left = readdirSync(dir).sort();
	assert.ok(!left.includes('bridge-2026-10-01.txt'), 'месячной давности удалён');
	assert.ok(left.includes('bridge-2026-10-20.txt'), 'свежий оставлен');
	assert.ok(left.includes('assistant-2026-10-01.txt'), 'лог ассистента мост не трогает');
	assert.deepEqual(pruneLogs(dir, 'bridge', { now: NOW }), [], 'повторная ротация ничего не удаляет');
	assert.equal(KEEP_DAYS, 14);
});

test('без каталога лог молчит, а не падает', () => {
	const textLog = createTextLog({});
	assert.equal(textLog.info('нет каталога'), undefined);
});
