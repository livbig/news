import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeHtml, hardenLineBreaks, headingsToBold, toTelegramHtml } from '../src/markdown.js';
import { htmlProblems, rawMarkdownProblems } from '../src/format-check.js';

test('html в ответе модели не превращается в теги', () => {
	const html = toTelegramHtml('<script>alert(1)</script> & "кавычки"');
	assert.ok(!html.includes('<script>'));
	assert.ok(html.includes('&lt;script&gt;'));
	assert.ok(html.includes('&amp;'));
});

test('блок кода превращается в pre/code с языком', () => {
	const html = toTelegramHtml('до\n```js\nconst a = 1 < 2;\n```\nпосле');
	assert.ok(html.includes('<pre><code class="language-js">'));
	assert.ok(html.includes('const a = 1 &lt; 2;'));
	assert.ok(html.includes('до'));
	assert.ok(html.includes('после'));
});

test('блок кода без языка — просто pre', () => {
	assert.ok(toTelegramHtml('```\nx\n```').includes('<pre>x</pre>'));
});

test('инлайн-код и подчёркивания в snake_case не ломаются', () => {
	const html = toTelegramHtml('вызови `foo_bar` и some_var_name');
	assert.ok(html.includes('<code>foo_bar</code>'));
	assert.ok(html.includes('some_var_name'));
	assert.ok(!html.includes('<i>'));
});

test('жирный, курсив, зачёркнутый и ссылка', () => {
	const html = toTelegramHtml('**жирный** и *курсив* и ~~нет~~ и [сайт](https://example.com)');
	assert.ok(html.includes('<b>жирный</b>'));
	assert.ok(html.includes('<i>курсив</i>'));
	assert.ok(html.includes('<s>нет</s>'));
	assert.ok(html.includes('<a href="https://example.com">сайт</a>'));
});

test('заголовок и цитата', () => {
	const html = toTelegramHtml('# Заголовок\n\n> цитата\n> вторая строка');
	assert.ok(html.includes('<b>Заголовок</b>'));
	assert.ok(html.includes('<blockquote>цитата\nвторая строка</blockquote>'));
});

test('незакрытый fence остаётся текстом', () => {
	const html = toTelegramHtml('```js\nconst a = 1');
	assert.ok(!html.includes('<pre>'));
	assert.ok(html.includes('```js'));
});

test('экранирование самостоятельной функцией', () => {
	assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');
});

test('пустая строка — пустой результат', () => {
	assert.equal(toTelegramHtml(''), '');
});

test('заголовки становятся жирным текстом: serif-шрифт в чате не нужен', () => {
	assert.equal(headingsToBold('# Отчёт'), '**Отчёт**');
	assert.equal(headingsToBold('## Что сделал\n\nтекст'), '**Что сделал**\n\nтекст');
	// внутри код-блока и инлайн-кода решётка — часть текста, а не заголовок
	assert.equal(headingsToBold('```sh\n# комментарий\n```'), '```sh\n# комментарий\n```');
	assert.equal(headingsToBold('`# тег`'), '`# тег`');
	assert.equal(headingsToBold('#без пробела'), '#без пробела');
});

const TABLE = [
	'| Позиция | Кол-во | Сумма |',
	'| --- | ---: | ---: |',
	'| Камера Dahua | 4 | 28 760 |',
	'| **Итого** | | **48 260** |',
].join('\n');

test('markdown-таблица становится <pre> с шапкой и выровненными числами', () => {
	const html = toTelegramHtml(`Смета:\n\n${TABLE}\n\nГотово.`);
	assert.ok(html.startsWith('Смета:\n\n<pre>'), 'таблица — моноширинный блок');
	assert.ok(html.includes('Позиция'));
	assert.ok(html.includes('│ Кол-во │'));
	assert.ok(html.includes('─────'), 'под шапкой линейка');
	assert.ok(!html.includes('| ---'), 'сырого разделителя markdown нет');
	assert.ok(!html.includes('**'), 'жирный внутри ячейки снят');
	assert.ok(html.includes('Итого'));
	assert.deepEqual(htmlProblems(html), [], 'HTML валиден');
});

test('таблица и текст экранируют &, < и >', () => {
	const html = toTelegramHtml('| Что | Сколько |\n| --- | --- |\n| кабель < 900 & гофра | 1 |\n\nсмета < 50 000 ₽ & запас');
	assert.ok(!/[^&]<(?!\/?(pre|b|i|code|a|s|blockquote|u|tg-emoji)\b)/.test(html.replace(/<pre>[\s\S]*<\/pre>/, '')), 'нет неэкранированных <');
	assert.ok(html.includes('&lt; 900 &amp; гофра'));
	assert.ok(html.includes('смета &lt; 50 000 ₽ &amp; запас'));
	assert.deepEqual(htmlProblems(html), []);
});

test('эмодзи и юникод не ломают выравнивание таблицы', () => {
	const html = toTelegramHtml('| Камера | Кол-во |\n| --- | --- |\n| 🎥 купольная | 4 |\n| ✅ итого | 1 |');
	assert.ok(html.includes('🎥 купольная'));
	assert.ok(html.includes('✅ итого'));
	assert.deepEqual(htmlProblems(html), []);
	assert.equal(toTelegramHtml('🎥✅ «Ромашка» — 48 260 ₽'), '🎥✅ «Ромашка» — 48 260 ₽');
});

test('смешанный ответ: код, таблица, список, заголовок и цитата — всё валидно', () => {
	const html = toTelegramHtml(
		[
			'# Отчёт',
			'',
			'```js',
			'const a = 1 < 2;',
			'```',
			'',
			TABLE,
			'',
			'- гарантия 12 месяцев;',
			'- скидка 5 %;',
			'',
			'> цитата & <стрелка>',
		].join('\n'),
	);
	assert.ok(html.includes('<b>Отчёт</b>'));
	assert.ok(html.includes('<pre><code class="language-js">'));
	assert.ok(html.includes('<pre>'));
	assert.ok(html.includes('- гарантия 12 месяцев;'), 'список остаётся текстом — Telegram его не размечает');
	assert.deepEqual(htmlProblems(html), []);
	assert.deepEqual(rawMarkdownProblems(html), []);
});

test("++текст++ — подчёркивание, а не сырые плюсы", () => {
	const html = toTelegramHtml("важно: ++около 350 000 атомов++");
	assert.equal(html, "важно: <u>около 350 000 атомов</u>");
});

test('rich markdown: одиночный перевод строки становится жёстким переносом', () => {
	assert.equal(hardenLineBreaks('раз\nдва'), 'раз  \nдва');
	assert.equal(hardenLineBreaks('раз\n\nдва'), 'раз\n\nдва', 'пустая строка — граница абзаца');
});

test('rich markdown: таблицу, список, заголовок, код и цитату переносы не ломают', () => {
	const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
	assert.equal(hardenLineBreaks(table), table);
	const list = '- раз\n- два';
	assert.equal(hardenLineBreaks(list), list);
	const heading = '# Отчёт\nтекст';
	assert.equal(hardenLineBreaks(heading), '# Отчёт\nтекст');
	const quote = '> цитата\nпродолжение';
	assert.equal(hardenLineBreaks(quote), quote);
	const code = '```sh\necho раз\necho два\n```';
	assert.equal(hardenLineBreaks(code), code);
});

test('rich markdown: таблица в середине ответа остаётся целой', () => {
	const source = 'До таблицы.\n| a | b |\n| --- | --- |\n| 1 | 2 |\nПосле.';
	const hardened = hardenLineBreaks(source);
	assert.equal(hardened, source, 'строки таблицы — не жёсткие переносы');
});
