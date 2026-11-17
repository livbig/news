/**
 * GFM → Telegram HTML. Нужен потому, что агент отвечает markdown, а Telegram не понимает GFM.
 * HTML выбран вместо MarkdownV2: в MarkdownV2 пришлось бы экранировать ~18 символов в уже
 * готовом тексте, т.е. ломать форматирование агента (docs: core.telegram.org#formatting-options).
 *
 * Всё, что не распознано, проходит как экранированный текст — сырой `<` в ответе модели не
 * превратится в тег.
 */

const TOKEN = '\u0000';

/** Строка-разделитель GFM-таблицы: `| --- | :---: | ---: |`. */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** Широкие символы (CJK, эмодзи) занимают в моноширинном шрифте две клетки. */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;

export function escapeHtml(value) {
	return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Обратное превращение: если Telegram отверг нашу разметку, отправляем чистый текст. */
export function htmlToPlain(html) {
	return String(html)
		.replace(/<[^>]*>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&');
}

/**
 * Rich-сообщения рисуют `# заголовок` крупным шрифтом с засечками — в чате это чужеродно
 * (владелец: «заголовки шрифтом с serifs, а базовый текст нет»). Код-блоки не трогаем.
 */
export function headingsToBold(markdown) {
	return String(markdown)
		.split(/(```[\s\S]*?```)/)
		.map((part, index) =>
			index % 2 === 1 ? part : part.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/gm, '**$1**'),
		)
		.join('');
}

/**
 * GFM-таблица → `<pre>` с выровненными столбцами. Telegram с `parse_mode: HTML` таблиц не знает
 * (docs/RESEARCH.md §8.5): без этого ответ сметы доходил палками и `| --- |` — то есть сырым markdown.
 * `<pre>` — единственный валидный HTML, который сохраняет таблицу похожей на таблицу.
 */
export function tableToPreHtml(tableLines) {
	const lines = tableLines.map((line) => String(line));
	const header = tableCells(lines[0] ?? '');
	const aligns = tableCells(lines[1] ?? '').map((mark) => (mark.endsWith(':') ? 'right' : 'left'));
	const rows = lines.slice(2).map(tableCells);
	const columns = Math.max(header.length, ...rows.map((row) => row.length), 1);

	const widths = Array.from({ length: columns }, (_, column) =>
		Math.max(1, ...[header, ...rows].map((row) => displayWidth(row[column] ?? ''))),
	);
	const pad = (value, column) => {
		const text = cellText(value ?? '');
		const fill = ' '.repeat(Math.max(0, widths[column] - displayWidth(text)));
		return aligns[column] === 'right' ? fill + text : text + fill;
	};
	const render = (row) => row.map(pad).join(' │ ').trimEnd();

	const body = [
		render(header),
		widths.map((width) => '─'.repeat(width)).join('─┼─'),
		...rows.map(render),
	];
	return `<pre>${escapeHtml(body.join('\n'))}</pre>`;
}

/** Ячейки строки таблицы: `| a | b |` → ['a', 'b']; `\\|` внутри ячейки не разделяет. */
function tableCells(line) {
	const raw = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
	return raw.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** Разметка внутри ячейки в `<pre>` не рисуется, поэтому маркеры снимаем, а не показываем как есть. */
function cellText(value) {
	return String(value)
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/__(.+?)__/g, '$1')
		.replace(/~~(.+?)~~/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*(.+?)\*/g, '$1')
		.replace(/(?<![A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/g, '$1')
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
}

function displayWidth(value) {
	let width = 0;
	for (const char of String(value)) width += WIDE.test(char) ? 2 : 1;
	return width;
}

/** Таблицы в тексте → сохранённые HTML-фрагменты (до экранирования, как и блоки кода). */
function tablesToHtml(text, keep) {
	const lines = String(text).split('\n');
	const out = [];
	for (let index = 0; index < lines.length; ) {
		if (lines[index].includes('|') && TABLE_RULE.test(lines[index + 1] ?? '')) {
			let end = index + 2;
			while (end < lines.length && lines[end].includes('|')) end += 1;
			out.push(keep(tableToPreHtml(lines.slice(index, end))));
			index = end;
			continue;
		}
		out.push(lines[index]);
		index += 1;
	}
	return out.join('\n');
}

export function toTelegramHtml(markdown) {
	if (typeof markdown !== 'string' || markdown.length === 0) return '';

	const store = [];
	const keep = (html) => `${TOKEN}${store.push(html) - 1}${TOKEN}`;

	// 1. Блоки кода целиком (включая язык), затем инлайн-код — до экранирования.
	let text = markdown.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
		const language = String(lang).trim().replace(/[^A-Za-z0-9+#._-]/g, '');
		const body = escapeHtml(code.replace(/\n$/, ''));
		return language
			? keep(`<pre><code class="language-${language}">${body}</code></pre>`)
			: keep(`<pre>${body}</pre>`);
	});
	text = text.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${escapeHtml(code)}</code>`));

	// 2. Таблицы (GFM) — в `<pre>`: в HTML-режиме Telegram другой возможности показать таблицу нет.
	text = tablesToHtml(text, keep);

	// 3. Цитаты (до экранирования, чтобы отличать `>` от `&gt;`).
	text = text.replace(/(?:^>[^\n]*(?:\n|$))+/gm, (block) =>
		keep(`<blockquote>${escapeHtml(block.replace(/^>[ \t]?/gm, '').trimEnd())}</blockquote>`),
	);

	// 4. Экранирование всего остального.
	text = escapeHtml(text);

	// 5. Разметка поверх экранированного текста.
	text = text.replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, '<b>$1</b>');
	text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
	text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
	text = text.replace(/__([^_\n]+)__/g, '<b>$1</b>');
	text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
	text = text.replace(/\+\+([^+\n]+)\+\+/g, '<u>$1</u>');
	text = text.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
	text = text.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '<i>$1</i>');

	// 6. Возврат сохранённых фрагментов.
	return text.replace(new RegExp(`${TOKEN}(\\d+)${TOKEN}`, 'g'), (_m, index) => store[Number(index)] ?? '');
}

/** Markdown → безопасный простой текст: последний резерв, когда Telegram отверг разметку. */
export function markdownToPlain(markdown) {
	return htmlToPlain(toTelegramHtml(markdown));
}

/**
 * Rich markdown идёт по правилам GFM: одиночный перевод строки — это пробел, поэтому
 * абзацы модели «склеиваются» в одну простыню (проверено на Bot API 10.4: `A\nB` → «A B»,
 * `A  \nB` → перенос). Ставим жёсткий перенос там, где модель начала новую строку, но
 * не трогаем таблицы, списки, заголовки, цитаты и код: у них свои правила и свои баги.
 */
export function hardenLineBreaks(markdown) {
	const lines = String(markdown ?? '').split('\n');
	let inFence = false;
	return lines
		.map((line, index) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;
			const next = lines[index + 1];
			if (next === undefined || !next.trim() || !line.trim()) return line;
			if (/^\s*\|/.test(line) || /^\s*\|/.test(next)) return line; // таблица: строки слитные
			if (/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|-{3,}|\*{3,})/.test(line)) return line;
			return `${line}  `;
		})
		.join('\n');
}
