import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createThrottle } from '../src/throttle.js';

function fakeClock() {
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
		pending: () => timers.size,
	};
}

test('первый вызов выполняется сразу', () => {
	const clock = fakeClock();
	const throttle = createThrottle({ intervalMs: 1000, ...clock });
	const calls = [];
	throttle.schedule('chat', () => calls.push('a'));
	assert.deepEqual(calls, ['a']);
});

test('частые вызовы склеиваются в один, с последним текстом', () => {
	const clock = fakeClock();
	const throttle = createThrottle({ intervalMs: 1000, ...clock });
	const calls = [];
	let text = '1';
	throttle.schedule('chat', () => calls.push(text));
	text = '2';
	throttle.schedule('chat', () => calls.push(text));
	text = '3';
	throttle.schedule('chat', () => calls.push(text));

	assert.deepEqual(calls, ['1']);
	assert.equal(clock.pending(), 1);

	clock.advance(1000);
	assert.deepEqual(calls, ['1', '3']);
	assert.equal(clock.pending(), 0);
});

test('после выдержанного интервала следующий вызов снова мгновенный', () => {
	const clock = fakeClock();
	const throttle = createThrottle({ intervalMs: 500, ...clock });
	const calls = [];
	throttle.schedule('c', () => calls.push('a'));
	clock.advance(500);
	throttle.schedule('c', () => calls.push('b'));
	assert.deepEqual(calls, ['a', 'b']);
});

test('ключи независимы: разные чаты не ждут друг друга', () => {
	const clock = fakeClock();
	const throttle = createThrottle({ intervalMs: 1000, ...clock });
	const calls = [];
	throttle.schedule('a', () => calls.push('a'));
	throttle.schedule('b', () => calls.push('b'));
	assert.deepEqual(calls, ['a', 'b']);
});

test('flush выполняет отложенное немедленно', () => {
	const clock = fakeClock();
	const throttle = createThrottle({ intervalMs: 1000, ...clock });
	const calls = [];
	throttle.schedule('c', () => calls.push('a'));
	throttle.schedule('c', () => calls.push('b'));
	throttle.flush('c');
	assert.deepEqual(calls, ['a', 'b']);
	assert.equal(clock.pending(), 0);
});

test('cancel выбрасывает отложенное', () => {
	const clock = fakeClock();
	const throttle = createThrottle({ intervalMs: 1000, ...clock });
	const calls = [];
	throttle.schedule('c', () => calls.push('a'));
	throttle.schedule('c', () => calls.push('b'));
	throttle.cancel('c');
	clock.advance(5000);
	assert.deepEqual(calls, ['a']);
	assert.equal(throttle.isPending('c'), false);
});

test('интервал может быть функцией (зависит от режима)', () => {
	let interval = 100;
	const clock = fakeClock();
	const throttle = createThrottle({ intervalMs: () => interval, ...clock });
	const calls = [];
	throttle.schedule('c', () => calls.push('a'));
	interval = 10_000;
	throttle.schedule('c', () => calls.push('b'));
	assert.deepEqual(calls, ['a']);
	clock.advance(100);
	assert.deepEqual(calls, ['a']);
	clock.advance(9900);
	assert.deepEqual(calls, ['a', 'b']);
});
