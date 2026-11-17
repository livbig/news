/**
 * Выбор режима rich-сообщения: Telegram рисует markdown-таблицы встроенной таблицей,
 * а HTML-режим оставил бы их текстом с палками. Всё остальное отправляем как HTML —
 * меню и команды собираются тегами.
 */
export const RICH_TABLE_RE = /\|\s*:?-{3,}/;

export function richMessageFor(text) {
	const chunk = String(text ?? '');
	return RICH_TABLE_RE.test(chunk) ? { markdown: chunk } : { html: chunk };
}
