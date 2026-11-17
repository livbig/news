import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTurnWatchdog, formatSpan } from '../src/watchdog.js';

function fakeTimers() {
	let time = 0;
	let seq = 0;
	const timers = new Map();
	return {
		now: () => time,
		setTimer: (fn, ms) => {
			const id = (seq += 1);
			timers.set(id, { fn, at: time + ms });
			return id;
		},
		clearTimer: (id) => timers.delete(id),
		advance(ms) {
			time += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= time) {
					timers.delete(id);
					timer.fn();
				}
			}
		},
	};
}

test('watchdog: тишина пишет заметку, событие сбрасывает таймер', () => {
	const timer = fakeTimers();
	let idle = 0;
	const watchdog = createTurnWatchdog({
		inactivityMs: 1000,
		ceilingMs: 10_000,
		onIdle: () => (idle += 1),
		onCeiling: () => assert.fail('потолок не должен срабатывать'),
		...timer,
	});

	timer.advance(999);
	assert.equal(idle, 0);
	timer.advance(1);
	assert.equal(idle, 1, 'тишина N — заметка');

	timer.advance(500);
	watchdog.touch();
	timer.advance(999);
	assert.equal(idle, 1, 'событие сбросило таймер');
	timer.advance(1);
	assert.equal(idle, 2);

	watchdog.stop();
	timer.advance(20_000);
	assert.equal(idle, 2, 'после остановки заметок нет');
});

test('watchdog: абсолютный потолок не сбрасывается событиями и срабатывает один раз', () => {
	const timer = fakeTimers();
	let ceiling = 0;
	let idle = 0;
	const watchdog = createTurnWatchdog({
		inactivityMs: 1000,
		ceilingMs: 5000,
		onIdle: () => (idle += 1),
		onCeiling: () => (ceiling += 1),
		...timer,
	});

	timer.advance(4000);
	watchdog.touch();
	timer.advance(1000);
	assert.equal(ceiling, 1, 'потолок считается от старта хода, а не от последнего события');
	assert.equal(watchdog.closed, true);
	const idleBefore = idle;
	timer.advance(10_000);
	assert.equal(ceiling, 1, 'второго потолка нет');
	assert.equal(idle, idleBefore, 'таймер тишины снят вместе с потолком');
});

test('formatSpan — минуты, секунды, миллисекунды', () => {
	assert.equal(formatSpan(20 * 60_000), '20 мин');
	assert.equal(formatSpan(12_000), '12 с');
	assert.equal(formatSpan(40), '40 мс');
	assert.equal(formatSpan(0), '0 с');
});
