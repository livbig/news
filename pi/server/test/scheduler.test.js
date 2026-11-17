// Слоты 09:00/21:00 и интервалы: чистая логика времени, без таймеров.
// Ошибка здесь = пропущенная или двойная сводка, поэтому проверяем края: полночь,
// переход суток, пояс, догон после простоя и защиту от повтора.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeDue, collectDue, dueSlot, localClock, nextSlot, parseTime, sentSlotKeys } from '../src/scheduler.js';

const MSK = 180;
const at = (iso) => Date.parse(iso);

test('parseTime: только ЧЧ:ММ в пределах суток', () => {
  assert.equal(parseTime('09:00'), 540);
  assert.equal(parseTime('21:30'), 1290);
  assert.equal(parseTime('9:05'), 545);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('09:60'), null);
  assert.equal(parseTime('утро'), null);
});

test('localClock: дата и минуты в поясе читателя', () => {
  const clock = localClock(at('2026-11-10T21:30:00Z'), MSK); // 00:30 MSK 11 ноября
  assert.equal(clock.dateKey, '2026-11-11');
  assert.equal(clock.minutes, 30);
});

test('слот наступает в 09:00 MSK и не срабатывает раньше', () => {
  const before = at('2026-11-10T05:59:00Z'); // 08:59 MSK
  assert.equal(dueSlot({ nowMs: before, times: ['09:00', '21:00'], tzOffsetMin: MSK }), null);
  const after = at('2026-11-10T06:00:30Z'); // 09:00:30 MSK
  assert.equal(dueSlot({ nowMs: after, times: ['09:00', '21:00'], tzOffsetMin: MSK }).key, '2026-11-10T09:00');
});

test('двойной отправки нет: отправленный слот больше не возвращается', () => {
  const now = at('2026-11-10T06:05:00Z');
  const sent = new Set(['2026-11-10T09:00']);
  assert.equal(dueSlot({ nowMs: now, times: ['09:00', '21:00'], tzOffsetMin: MSK, sentKeys: sent }), null);
});

test('догон после простоя ограничен тремя часами', () => {
  const late = at('2026-11-10T13:00:00Z'); // 16:00 MSK, слот 09:00 прошёл 7 часов назад
  assert.equal(dueSlot({ nowMs: late, times: ['09:00', '21:00'], tzOffsetMin: MSK }), null);
  const ok = at('2026-11-10T08:30:00Z'); // 11:30 MSK — догон в пределах
  assert.equal(dueSlot({ nowMs: ok, times: ['09:00', '21:00'], tzOffsetMin: MSK }).key, '2026-11-10T09:00');
});

test('вечерний слот и переход через полночь', () => {
  const evening = at('2026-11-10T18:10:00Z'); // 21:10 MSK
  assert.equal(dueSlot({ nowMs: evening, times: ['09:00', '21:00'], tzOffsetMin: MSK }).key, '2026-11-10T21:00');
  const night = at('2026-11-10T21:05:00Z'); // 00:05 MSK следующего дня
  assert.equal(dueSlot({ nowMs: night, times: ['09:00', '21:00'], tzOffsetMin: MSK }), null);
  assert.equal(nextSlot({ nowMs: night, times: ['09:00', '21:00'], tzOffsetMin: MSK }).key, '2026-11-11T09:00');
});

test('nextSlot: ближайший слот и его момент в UTC', () => {
  const now = at('2026-11-10T06:10:00Z'); // 09:10 MSK
  const next = nextSlot({ nowMs: now, times: ['09:00', '21:00'], tzOffsetMin: MSK });
  assert.equal(next.time, '21:00');
  assert.equal(new Date(next.ms).toISOString(), '2026-11-10T18:00:00.000Z');
});

test('интервалы сбора и анализа', () => {
  const now = Date.now();
  assert.equal(collectDue({ nowMs: now, lastCollectIso: null, intervalMin: 20 }), true);
  assert.equal(collectDue({ nowMs: now, lastCollectIso: new Date(now - 5 * 60_000).toISOString(), intervalMin: 20 }), false);
  assert.equal(collectDue({ nowMs: now, lastCollectIso: new Date(now - 25 * 60_000).toISOString(), intervalMin: 20 }), true);
  assert.equal(analyzeDue({ nowMs: now, lastAnalyzeIso: null, everyMin: 10 }), true);
  assert.equal(analyzeDue({ nowMs: now, lastAnalyzeIso: new Date(now - 3 * 60_000).toISOString(), everyMin: 10 }), false);
});

test('sentSlotKeys читает только свой префикс', () => {
  const rows = [{ key: 'factslot:2026-11-13T12:00' }, { key: 'slot:2026-11-13T09:00' }, { key: 'fact_day_done' }];
  assert.deepEqual([...sentSlotKeys(rows, 'factslot:')], ['2026-11-13T12:00']);
  assert.deepEqual([...sentSlotKeys(rows)], ['2026-11-13T09:00']);
});

test('sentSlotKeys читает только слоты', () => {
  const keys = sentSlotKeys([{ key: 'slot:2026-11-10T09:00' }, { key: 'last_collect_at' }, { key: 'slot:2026-11-10T21:00' }]);
  assert.deepEqual([...keys].sort(), ['2026-11-10T09:00', '2026-11-10T21:00']);
});
