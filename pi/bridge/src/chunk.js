/**
 * Разбивка текста под лимит Telegram (4096 символов, core.telegram.org#sendmessage).
 * Три режима:
 *   chunkText     — простой текст: абзацы → строки → жёсткий разрез;
 *   chunkMarkdown — ответ модели: таблицы режутся по строкам, шапка повторяется;
 *   chunkHtml     — наши сообщения: разрез только по тегам/строкам, таблица остаётся таблицей.
 * shortcut: fence ``` не отслеживается — блок кода может разорваться между сообщениями;
 *           усложнять, если пользователи начнут жаловаться на склейку кода по частям.
 */

import { toTelegramHtml } from './markdown.js';

export const TELEGRAM_MAX_LENGTH = 4096;

export function chunkText(text, limit = TELEGRAM_MAX_LENGTH) {
	if (typeof text !== 'string') throw new TypeError('chunkText: text должен быть строкой');
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError('chunkText: limit должен быть >= 1');
	if (text.length === 0) return [];

	const normalized = text.replace(/\r\n?/g, '\n');
	if (normalized.length <= limit) return [normalized];

	const chunks = [];
	let current = '';

	for (const block of normalized.split(/\n{2,}/)) {
		if (block.length === 0) continue;
		for (const part of splitBlock(block, limit)) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= limit) {
				current = candidate;
			} else {
				if (current) chunks.push(current);
				current = part;
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** Markdown-ответ: таблицу нельзя рвать по символам, иначе Telegram перестаёт видеть разметку. */
export function chunkMarkdown(text, limit = TELEGRAM_MAX_LENGTH) {
	if (typeof text !== 'string') throw new TypeError('chunkMarkdown: text должен быть строкой');
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError('chunkMarkdown: limit должен быть >= 1');
	if (text.length === 0) return [];

	const normalized = text.replace(/\r\n?/g, '\n');
	if (fitsBoth(normalized, limit)) return [normalized];

	const chunks = [];
	let current = '';
	const append = (part) => {
		if (!part) return;
		const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
		if (fitsBoth(candidate, limit)) {
			current = candidate;
			return;
		}
		if (current) chunks.push(current);
		current = part;
	};

	for (const block of normalized.split(/\n{2,}/)) {
		if (!block) continue;
		for (const part of splitMarkdownBlock(block, limit)) append(part);
	}
	if (current) chunks.push(current);
	return chunks;
}

/** Часть ответа уходит и в rich (markdown), и в классику (HTML): обе длины должны влезать. */
function fitsBoth(text, limit) {
	return text.length <= limit && toTelegramHtml(text).length <= limit;
}

function splitMarkdownBlock(block, limit) {
	if (block.length <= limit) return [block];
	const lines = block.split('\n');
	const parts = [];
	let text = [];
	const flushText = () => {
		if (!text.length) return;
		const joined = text.join('\n');
		if (joined) parts.push(...splitBlock(joined, limit));
		text = [];
	};

	for (let index = 0; index < lines.length; ) {
		if (isTableStart(lines, index)) {
			const end = tableEnd(lines, index);
			flushText();
			parts.push(...splitMarkdownTable(lines.slice(index, end), limit));
			index = end;
			continue;
		}
		text.push(lines[index]);
		index += 1;
	}
	flushText();
	return parts.length ? parts : splitBlock(block, limit);
}

function isTableStart(lines, index) {
	return Boolean(lines[index]?.includes('|')) && TABLE_RULE.test(lines[index + 1] ?? '');
}

function tableEnd(lines, start) {
	let end = start + 2;
	while (end < lines.length && lines[end].includes('|')) end += 1;
	return end;
}

/** Первая часть — шапка и сколько влезло строк; следующие — та же шапка и остаток. */
function splitMarkdownTable(lines, limit) {
	const table = lines.join('\n');
	if (fitsBoth(table, limit)) return [table];
	const header = lines.slice(0, 2).join('\n');
	if (!fitsBoth(`${header}\n`, limit) || lines.length <= 2) return splitBlock(table, limit);

	const rows = lines.slice(2);
	const parts = [];
	let current = header;
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (fitsBoth(`${current}\n${row}`, limit)) {
			current = `${current}\n${row}`;
			continue;
		}
		parts.push(current);
		current = header;
		if (!fitsBoth(`${current}\n${row}`, limit)) {
			// Одна строка не влезает даже с шапкой — валимся в обычный разрез (крайний случай).
			parts.push(...splitBlock([header, ...rows.slice(index)].join('\n'), limit));
			return parts;
		}
		current = `${current}\n${row}`;
	}
	parts.push(current);
	return parts;
}

/** HTML наших сообщений: режем по строкам/тегам, таблицу — по строкам с повтором шапки. */
export function chunkHtml(html, limit = TELEGRAM_MAX_LENGTH) {
	if (typeof html !== 'string') throw new TypeError('chunkHtml: html должен быть строкой');
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError('chunkHtml: limit должен быть >= 1');
	if (html.length === 0) return [];
	if (html.length <= limit) return [html];

	const pieces = [];
	let last = 0;
	for (const match of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
		if (match.index > last) pieces.push(...splitHtmlRegion(html.slice(last, match.index), limit));
		pieces.push(...splitHtmlTable(match[0], limit));
		last = match.index + match[0].length;
	}
	if (last < html.length) pieces.push(...splitHtmlRegion(html.slice(last), limit));
	if (!pieces.length) pieces.push(...splitHtmlRegion(html, limit));

	const chunks = [];
	let current = '';
	const append = (piece) => {
		if (current.length === 0) {
			current = piece;
			return;
		}
		const candidate = current + piece;
		if (candidate.length <= limit) {
			current = candidate;
			return;
		}
		chunks.push(current);
		current = piece;
	};
	for (const piece of pieces) append(piece);
	if (current) chunks.push(current);
	return chunks;
}

const VOID_TAGS = new Set(['br', 'img', 'hr', 'tg-map']);

/**
 * HTML-текст (без таблиц) под лимит. Открытые теги не бросаем: часть закрывает их и открывает
 * снова — иначе Telegram отвергает разметку всего сообщения («can't parse entities») и вместо
 * сметы приходит голый текст.
 */
function splitHtmlRegion(text, limit) {
	const parts = [];
	const open = [];
	let current = '';

	const closing = () => [...open].reverse().map((tag) => `</${tag.name}>`).join('');
	const reopening = () => open.map((tag) => tag.open).join('');
	const flush = () => {
		if (!current) return;
		parts.push(current + closing());
		current = reopening();
	};

	for (const token of String(text).match(/<[^>]*>|[^<]+/g) ?? []) {
		if (token.startsWith('<')) {
			const close = /^<\/([A-Za-z0-9:-]+)/.exec(token);
			const name = close?.[1]?.toLowerCase();
			if (name) {
				const index = open.findLastIndex((tag) => tag.name === name);
				if (index !== -1) open.splice(index, 1);
			} else if (!token.endsWith('/>') && !VOID_TAGS.has(/^<([A-Za-z0-9:-]+)/.exec(token)?.[1]?.toLowerCase())) {
				open.push({ name: (/^<([A-Za-z0-9:-]+)/.exec(token)?.[1] ?? '').toLowerCase(), open: token });
			}
			if (current.length + token.length + closing().length > limit) flush();
			current += token;
			continue;
		}

		let rest = token;
		while (rest) {
			const room = limit - current.length - closing().length;
			if (room <= 0) {
				if (!current) return parts.filter(Boolean).concat(rest);
				flush();
				continue;
			}
			if (rest.length <= room) {
				current += rest;
				break;
			}
			const cut = safeCut(rest, room);
			current += rest.slice(0, cut);
			rest = rest.slice(cut);
			flush();
		}
	}
	if (current) parts.push(current + closing());
	return parts.filter(Boolean);
}

/** Не разрываем HTML-сущность (&amp;) и, по возможности, режем по пробелу. */
function safeCut(text, room) {
	let cut = Math.min(room, text.length);
	const space = text.lastIndexOf(' ', cut - 1);
	if (space >= Math.floor(cut / 2)) cut = space + 1;
	if (cut > room) cut = room;
	const semi = text.lastIndexOf(';', cut);
	const amp = text.lastIndexOf('&', cut);
	if (amp > semi) cut = amp;
	return cut > 0 ? cut : Math.min(room, text.length);
}

function splitHtmlTable(table, limit) {
	if (table.length <= limit) return [table];
	const open = /^<table\b[^>]*>/.exec(table)?.[0];
	if (!open || !table.endsWith('</table>')) return splitHtmlRegion(table, limit);
	const inner = table.slice(open.length, -'</table>'.length);
	const rows = [...inner.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
	if (!rows.length) return splitHtmlRegion(table, limit);

	const firstRow = inner.indexOf(rows[0]);
	const caption = /<caption\b[^>]*>[\s\S]*?<\/caption>/i.exec(inner.slice(0, firstRow))?.[0] ?? '';
	const header = rows[0];
	const suffix = '</table>';
	const firstPrefix = `${open}${caption}${header}`;
	const nextPrefix = `${open}${header}`;
	if (firstPrefix.length + suffix.length > limit) return splitHtmlRegion(table, limit);

	const parts = [];
	let current = firstPrefix;
	for (const row of rows.slice(1)) {
		if (current.length + row.length + suffix.length <= limit) {
			current += row;
			continue;
		}
		parts.push(current + suffix);
		current = nextPrefix;
		if (current.length + row.length + suffix.length > limit) {
			// Строка таблицы длиннее сообщения — крайний случай, режем строку по тегам.
			return splitHtmlRegion(table, limit);
		}
		current += row;
	}
	parts.push(current + suffix);
	return parts;
}

function splitBlock(block, limit) {
	if (block.length <= limit) return [block];
	const parts = [];
	let current = '';

	for (const line of block.split('\n')) {
		const candidate = current.length === 0 ? line : `${current}\n${line}`;
		if (candidate.length <= limit) {
			current = candidate;
			continue;
		}
		if (current) parts.push(current);
		current = '';

		let rest = line;
		while (rest.length > limit) {
			parts.push(rest.slice(0, limit));
			rest = rest.slice(limit);
		}
		current = rest;
	}
	if (current) parts.push(current);
	return parts;
}
