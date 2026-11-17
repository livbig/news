/**
 * Список и выбор сессий (FR1/FR2).
 * Источник данных — SessionManager.listAll() из SDK pi (docs/sdk.md → Sessions example),
 * а не ручной парсинг .jsonl: id/name/cwd/modified отдаёт сам API.
 */

import { escapeHtml } from './markdown.js';

export function shortId(info) {
	return String(info.id ?? '').slice(0, 8);
}

export function sessionLabel(info, limit = 60) {
	const name = (info.name ?? '').trim();
	if (name) return squeeze(name, limit);
	const first = (info.firstMessage ?? '').trim().replace(/\s+/g, ' ');
	if (first) return squeeze(first, limit);
	return shortId(info) || '(без имени)';
}

function squeeze(value, limit) {
	return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value;
}

export function sortSessionsByModified(sessions) {
	return [...sessions].sort((a, b) => toTime(b.modified) - toTime(a.modified));
}

export function formatRelativeTime(date, now = Date.now()) {
	const ms = now - toTime(date);
	if (!Number.isFinite(ms)) return '?';
	if (ms < 60_000) return 'только что';
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes} мин назад`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} ч назад`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days} дн назад`;
	return new Date(toTime(date)).toLocaleDateString('ru-RU');
}

/** Строка сессии для чата (HTML, как его ждёт toTelegramHtml-вывод) — FR1. */
export function formatSessionLine(info, index, now = Date.now()) {
	const title = `${index + 1}. ${escapeHtml(sessionLabel(info))}`;
	const meta = [
		escapeHtml(shortId(info)),
		`${info.messageCount ?? 0} сообщ.`,
		formatRelativeTime(info.modified, now),
	].join(' · ');
	const cwd = info.cwd ? `\n<code>${escapeHtml(info.cwd)}</code>` : '';
	return `<b>${title}</b>\n${meta}${cwd}`;
}

/** Поиск сессии по номеру в списке, id (полному/префиксу), имени или подстроке. */
export function findSession(sessions, query) {
	const q = String(query ?? '').trim();
	if (!q) return { error: 'пустой запрос' };

	if (/^\d+$/.test(q)) {
		const index = Number(q) - 1;
		if (index >= 0 && index < sessions.length) return { info: sessions[index], via: 'номер' };
	}

	const lower = q.toLowerCase();
	const rules = [
		['id', (s) => String(s.id ?? '').toLowerCase() === lower],
		['префиксу id', (s) => String(s.id ?? '').toLowerCase().startsWith(lower)],
		['имени', (s) => (s.name ?? '').toLowerCase() === lower],
	];
	for (const [via, predicate] of rules) {
		const hits = sessions.filter(predicate);
		if (hits.length === 1) return { info: hits[0], via };
		if (hits.length > 1) return { error: `неоднозначно по ${via}: ${hits.length} совпадений`, matches: hits.slice(0, 5) };
	}

	const fuzzy = sessions.filter(
		(s) =>
			(s.name ?? '').toLowerCase().includes(lower) ||
			(s.firstMessage ?? '').toLowerCase().includes(lower) ||
			String(s.id ?? '').toLowerCase().includes(lower),
	);
	if (fuzzy.length === 1) return { info: fuzzy[0], via: 'поиску' };
	if (fuzzy.length > 1) return { error: `неоднозначно: ${fuzzy.length} совпадений`, matches: fuzzy.slice(0, 5) };
	return { error: `сессия «${q}» не найдена` };
}

/**
 * @param {object} options
 * @param {typeof import('@earendil-works/pi-coding-agent').SessionManager} options.SessionManager
 * @param {string} [options.sessionDir] — если задан, смотрим только его
 * @param {string} [options.cwd] — фильтр по рабочему каталогу
 */
export async function listSessions({ SessionManager, sessionDir, cwd, signal } = {}) {
	if (!SessionManager?.listAll) throw new Error('SessionManager.listAll недоступен');
	const all = sessionDir
		? await SessionManager.listAll(sessionDir, undefined, signal)
		: await SessionManager.listAll(undefined, undefined, signal);
	const sorted = sortSessionsByModified(all);
	return cwd ? sorted.filter((info) => info.cwd === cwd) : sorted;
}

function toTime(value) {
	if (value instanceof Date) return value.getTime();
	return new Date(value).getTime();
}
