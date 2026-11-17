/**
 * Проверка того, что реально уходит в Bot API: валидный ли HTML и не осталось ли сырого markdown.
 * Тесты (`markdown`, `chunk`, `live`, `test/e2e`) и ручная проверка на Pi после правок отправки:
 *
 *   node -e "import('./src/format-check.js').then(async (c) => {
 *     const { chunkMarkdown, chunkHtml } = await import('./src/chunk.js');
 *     const { toTelegramHtml } = await import('./src/markdown.js');
 *     const parts = chunkMarkdown(require('node:fs').readFileSync('/tmp/answer.md','utf8'))
 *       .flatMap((chunk) => chunkHtml(toTelegramHtml(chunk)));
 *     for (const part of parts) console.log(part.length, [...c.htmlProblems(part), ...c.rawMarkdownProblems(part)]);
 *   })"
 */

const VOID = new Set(['br', 'img', 'hr', 'tg-emoji']);
const ENTITY = /^&(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+|tg-spoiler);?/;

/** Незакрытые/лишние теги, неэкранированные `<` и `&`. Возвращает список проблем. */
export function htmlProblems(text) {
	const problems = [];
	const stack = [];
	for (const match of String(text).matchAll(/<[^>]*>|[^<]+/g)) {
		const token = match[0];
		if (!token.startsWith('<')) {
			// Текст: `<` внутри текста — только как экранированная сущность `&lt;`.
			let rest = token;
			while (rest.length) {
				const amp = rest.indexOf('&');
				if (amp === -1) {
					if (rest.includes('<')) problems.push(`неэкранированный «<»: ${rest.slice(0, 40)}`);
					break;
				}
				if (rest.slice(0, amp).includes('<')) problems.push(`неэкранированный «<»: ${rest.slice(0, amp).slice(0, 40)}`);
				const entity = ENTITY.exec(rest.slice(amp));
				if (!entity) {
					problems.push(`неэкранированный «&»: ${rest.slice(amp, amp + 40)}`);
					rest = rest.slice(amp + 1);
					continue;
				}
				rest = rest.slice(amp + entity[0].length);
			}
			continue;
		}
		const name = /^<\/?([A-Za-z0-9:-]+)/.exec(token)?.[1]?.toLowerCase();
		if (!name) {
			problems.push(`непонятный тег: ${token}`);
			continue;
		}
		if (token.startsWith('</')) {
			const index = stack.lastIndexOf(name);
			if (index === -1) problems.push(`закрыт незакрытый тег </${name}>`);
			else stack.splice(index, 1);
			continue;
		}
		if (!token.endsWith('/>') && !VOID.has(name)) stack.push(name);
	}
	if (stack.length) problems.push(`не закрыты теги: ${stack.join(', ')}`);
	return problems;
}

/** Сырой markdown, который в HTML-режиме Telegram уже не разметит. */
export function rawMarkdownProblems(text) {
	const problems = [];
	const raw = String(text);
	if (/\*\*[^*\n]+\*\*/.test(raw)) problems.push('необработанное **жирное**');
	if (/(^|\n)\s{0,3}#{1,6}\s+\S/.test(raw)) problems.push('заголовок «###» остался текстом');
	if (/(^|\n)\s*\|?\s*:?-{3,}:?/.test(raw)) problems.push('разделитель markdown-таблицы «| ---»');
	if (/(^|\n)\s*```/.test(raw)) problems.push('необработанный блок ```');
	return problems;
}
