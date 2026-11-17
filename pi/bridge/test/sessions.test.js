import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	findSession,
	sessionLabel,
	formatRelativeTime,
	formatSessionLine,
	shortId,
	sortSessionsByModified,
} from '../src/sessions.js';

const NOW = new Date('2026-10-11T12:00:00Z').getTime();

function info(overrides = {}) {
	return {
		path: '/sessions/a.jsonl',
		id: 'aaaaaaaa-1111-2222-3333-444444444444',
		cwd: '/Users/me/project',
		name: undefined,
		created: new Date(NOW - 3_600_000),
		modified: new Date(NOW - 120_000),
		messageCount: 12,
		firstMessage: 'Сделай ревью',
		allMessagesText: '',
		...overrides,
	};
}

test('относительное время', () => {
	assert.equal(formatRelativeTime(NOW - 5_000, NOW), 'только что');
	assert.equal(formatRelativeTime(NOW - 5 * 60_000, NOW), '5 мин назад');
	assert.equal(formatRelativeTime(NOW - 3 * 3_600_000, NOW), '3 ч назад');
	assert.equal(formatRelativeTime(NOW - 2 * 86_400_000, NOW), '2 дн назад');
	assert.match(formatRelativeTime(NOW - 30 * 86_400_000, NOW), /^\d{2}\.\d{2}\.\d{4}$/);
});

test('строка сессии: имя, id, cwd, время (FR1)', () => {
	const line = formatSessionLine(info({ name: 'Правки <роутера>' }), 2, NOW);
	assert.match(line, /^<b>3\. Правки &lt;роутера&gt;<\/b>/);
	assert.ok(line.includes('aaaaaaaa'));
	assert.ok(line.includes('12 сообщ.'));
	assert.ok(line.includes('2 мин назад'));
	assert.ok(line.includes('<code>/Users/me/project</code>'));
});

test('без имени берётся первое сообщение, длинное — обрезается', () => {
	const long = formatSessionLine(info({ firstMessage: 'я'.repeat(200) }), 0, NOW);
	assert.match(long, /я{59}…/);
	assert.equal(sessionLabel(info({ firstMessage: 'я'.repeat(200) }), 10).length, 10);
});

test('сортировка по времени изменения', () => {
	const older = info({ id: 'old', modified: new Date(NOW - 100_000) });
	const newer = info({ id: 'new', modified: new Date(NOW) });
	assert.deepEqual(
		sortSessionsByModified([older, newer]).map((s) => s.id),
		['new', 'old'],
	);
});

test('поиск по номеру в списке', () => {
	const sessions = [info({ id: 'first' }), info({ id: 'second' })];
	assert.equal(findSession(sessions, '2').info.id, 'second');
	assert.equal(findSession(sessions, '2').via, 'номер');
});

test('поиск по префиксу id и по имени', () => {
	const sessions = [info({ id: 'aaaa1111-2222' }), info({ id: 'bbbb3333', name: 'Фикс багов' })];
	assert.equal(findSession(sessions, 'aaaa').info.id, 'aaaa1111-2222');
	assert.equal(findSession(sessions, 'фикс багов').info.id, 'bbbb3333');
});

test('неоднозначность и отсутствие сессии — понятный текст', () => {
	const sessions = [info({ id: 'aaaa1' }), info({ id: 'aaaa2' })];
	const ambiguous = findSession(sessions, 'aaaa');
	assert.ok(ambiguous.error.includes('неоднозначно'));
	assert.equal(ambiguous.matches.length, 2);
	assert.ok(findSession(sessions, 'zzz').error.includes('не найдена'));
	assert.ok(findSession(sessions, '').error.includes('пустой'));
});

test('shortId — первые 8 символов', () => {
	assert.equal(shortId(info()), 'aaaaaaaa');
});
