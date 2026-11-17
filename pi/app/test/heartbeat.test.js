import assert from 'node:assert/strict';
import { test } from 'node:test';

import { telegramProblems } from '../src/heartbeat-check.js';

const ok = (pending = 0) => ({ ok: true, result: { pending_update_count: pending } });

test('канал живой, очередь пуста, мост запущен — проблем нет', () => {
	assert.deepEqual(telegramProblems(ok(), { bridgeActive: true }), []);
});

test('Telegram не ответил или токен отвергнут', () => {
	assert.match(telegramProblems({ ok: false, description: 'Unauthorized' }, { bridgeActive: true }).join(), /Telegram недоступен/);
	assert.match(telegramProblems(undefined, { bridgeActive: true }).join(), /Telegram недоступен/);
});

test('мост не забирает апдейты (та же беда 16.11: сеть есть, long poll повис)', () => {
	const problems = telegramProblems(ok(3), { bridgeActive: true });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /не забирает апдейты: 3/);
});

test('служба моста не запущена — отдельная строка', () => {
	const problems = telegramProblems(ok(), { bridgeActive: false });
	assert.match(problems.join(), /news-bridge не запущена/);
});
