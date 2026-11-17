import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TELEGRAM_MAX_LENGTH, chunkHtml, chunkMarkdown, chunkText } from '../src/chunk.js';
import { toTelegramHtml } from '../src/markdown.js';
import { htmlProblems, rawMarkdownProblems } from '../src/format-check.js';

test('короткий текст — один кусок', () => {
	assert.deepEqual(chunkText('привет'), ['привет']);
});

test('пустой текст — ни одного куска', () => {
	assert.deepEqual(chunkText(''), []);
});

test('абзацы склеиваются до лимита и пересобираются без потерь', () => {
	const text = ['a'.repeat(2000), 'b'.repeat(2000), 'c'.repeat(2000)].join('\n\n');
	const chunks = chunkText(text, 4096);
	assert.ok(chunks.length >= 2);
	for (const chunk of chunks) assert.ok(chunk.length <= 4096, `кусок длиной ${chunk.length}`);
	assert.equal(chunks.join('\n\n'), text);
});

test('по умолчанию лимит Telegram', () => {
	const chunks = chunkText('x'.repeat(TELEGRAM_MAX_LENGTH + 10));
	assert.equal(chunks.length, 2);
	assert.equal(chunks[0].length, TELEGRAM_MAX_LENGTH);
	assert.equal(chunks.join('').length, TELEGRAM_MAX_LENGTH + 10);
});

test('одна огромная строка режется жёстко, без потери символов', () => {
	const line = 'y'.repeat(10_000);
	const chunks = chunkText(line, 4096);
	assert.deepEqual(
		chunks.map((chunk) => chunk.length),
		[4096, 4096, 1808],
	);
	assert.equal(chunks.join(''), line);
});

test('переносы CRLF нормализуются', () => {
	assert.deepEqual(chunkText('a\r\nb'), ['a\nb']);
});

test('нечисловой лимит — ошибка', () => {
	assert.throws(() => chunkText('x', 0), RangeError);
	assert.throws(() => chunkText('x', 1.5), RangeError);
	assert.throws(() => chunkText(42), TypeError);
});

test('markdown-таблица режется по строкам, шапка повторяется в каждой части', () => {
	const header = '| № | Позиция | Сумма |';
	const rule = '|---:|---|---:|';
	const rows = Array.from(
		{ length: 60 },
		(_, index) => `| ${index + 1} | ${'очень длинное описание позиции '.repeat(3)}${index} | ${(index + 1) * 1000} |`,
	);
	const text = [header, rule, ...rows].join('\n');
	assert.ok(text.length > TELEGRAM_MAX_LENGTH, 'тест должен задевать разбивку');

	const chunks = chunkMarkdown(text);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= TELEGRAM_MAX_LENGTH, `кусок длиной ${chunk.length}`);
		const lines = chunk.split('\n');
		assert.equal(lines[0], header, 'шапка таблицы повторяется');
		assert.equal(lines[1], rule);
		assert.ok(lines.slice(2).every((line) => line.startsWith('|')), 'в части только строки таблицы');
	}
	const restoredRows = chunks.reduce((sum, chunk) => sum + chunk.split('\n').length - 2, 0);
	assert.equal(restoredRows, rows.length, 'ни одна строка не потерялась');
});

test('HTML-таблица режется по строкам, шапка повторяется и теги не рвутся', () => {
	const rows = Array.from(
		{ length: 60 },
		(_, index) => `<tr><td>${index + 1}</td><td>${'значение '.repeat(12)}${index}</td></tr>`,
	);
	const html = `<b>Отчёт</b>\n<table bordered striped compact><tr><th>№</th><th>Значение</th></tr>${rows.join('')}</table>\n<code>конец</code>`;
	assert.ok(html.length > TELEGRAM_MAX_LENGTH, 'тест должен задевать разбивку');

	const chunks = chunkHtml(html);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= TELEGRAM_MAX_LENGTH, `кусок длиной ${chunk.length}`);
		assert.equal(/<[^>]*$/.test(chunk), false, 'кусок не обрывается посреди тега');
		assert.equal((chunk.match(/<table\b/g) ?? []).length, (chunk.match(/<\/table>/g) ?? []).length);
		if (chunk.includes('<table')) {
			assert.match(chunk, /<tr><th>№<\/th><th>Значение<\/th><\/tr>/, 'шапка таблицы повторяется');
		}
	}
	const dataRows = chunks.join('').match(/<tr><td>/g) ?? [];
	assert.equal(dataRows.length, rows.length, 'ни одна строка таблицы не потерялась');
});

test('длинная inline-разметка не рвёт теги и не теряет текст', () => {
	const html = `<b>${'жирный текст '.repeat(700)}</b>`;
	const chunks = chunkHtml(html);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= TELEGRAM_MAX_LENGTH);
		assert.equal(/<[^>]*$/.test(chunk), false);
		assert.equal((chunk.match(/<b>/g) ?? []).length, (chunk.match(/<\/b>/g) ?? []).length);
	}
	assert.equal(chunks.join('').replace(/<\/?b>/g, '').replace(/\s/g, ''), 'жирныйтекст'.repeat(700));
});

const TABLE = (rows) =>
	[
		'| Позиция | Кол-во | Сумма |',
		'| --- | ---: | ---: |',
		...rows.map((index) => `| Позиция сметы ${index} — описание подлиннее | ${index} | ${index * 100} |`),
	].join('\n');

test('длинный текст режется под 4096, ни одна часть не теряет разметку', () => {
	const text = ['**Жирный заголовок**', '', ...Array.from({ length: 90 }, (_, index) => `строка ${index} с *курсивом* и <скобками> & амперсандом`)].join('\n\n');
	const chunks = chunkMarkdown(text);
	assert.ok(chunks.length >= 1);
	const parts = chunks.flatMap((chunk) => chunkHtml(toTelegramHtml(chunk)));
	for (const part of parts) {
		assert.ok(part.length <= TELEGRAM_MAX_LENGTH, `часть длиной ${part.length}`);
		assert.deepEqual(htmlProblems(part), []);
		assert.deepEqual(rawMarkdownProblems(part), []);
	}
});

test('таблица длиннее лимита: каждая часть начинается с шапки и HTML валиден', () => {
	const chunks = chunkMarkdown(TABLE(Array.from({ length: 120 }, (_, index) => index + 1)));
	assert.ok(chunks.length > 1, `частей: ${chunks.length}`);
	for (const chunk of chunks) {
		const lines = chunk.split('\n');
		assert.equal(lines[0], '| Позиция | Кол-во | Сумма |', 'шапка повторяется');
		const html = toTelegramHtml(chunk);
		assert.ok(html.length <= TELEGRAM_MAX_LENGTH, `HTML части ${html.length}`);
		assert.ok(html.startsWith('<pre>'), 'таблица остаётся таблицей');
		assert.ok(html.includes('Позиция'));
		assert.deepEqual(htmlProblems(html), []);
		assert.deepEqual(rawMarkdownProblems(html), []);
	}
});

test('нарезка HTML: нет непарных тегов даже внутри блока кода и цитаты', () => {
	const code = `\`\`\`js\n${'const a = 1 < 2;\n'.repeat(400)}\`\`\``;
	const html = [toTelegramHtml('до'), toTelegramHtml(code), toTelegramHtml('> длинная цитата\n'.repeat(200)), toTelegramHtml('**жирный** текст '.repeat(300))].join('\n');
	const chunks = chunkHtml(html, 1000);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= 1000, `часть длиной ${chunk.length}`);
		assert.deepEqual(htmlProblems(chunk), [], 'все теги закрыты в каждой части');
	}
});

test('нарезка не рвёт HTML-сущности &amp; и &lt;', () => {
	const html = `${'&amp;'.repeat(500)}${'&lt;'.repeat(500)}`;
	const chunks = chunkHtml(html, 100);
	for (const chunk of chunks) {
		assert.deepEqual(htmlProblems(chunk), []);
		assert.ok(!/[^&]amp;/.test(chunk.replace(/^amp;/, '')), 'сущность не разорвана');
	}
});
