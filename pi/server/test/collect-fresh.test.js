// Отбор собранного: старьё и лишний объём отсекаются до записи в базу.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { freshEntries } from '../src/collect.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-10T12:00:00Z');
const entry = (daysAgo, index) => ({
  title: `t${index}`,
  url: `https://ex.com/${index}`,
  published: new Date(now - daysAgo * DAY).toISOString(),
  text: '',
});

test('архив старше трёх дней не попадает в базу', () => {
  const rows = freshEntries([entry(0, 1), entry(1, 2), entry(4, 3), entry(10, 4)], { nowMs: now });
  assert.deepEqual(rows.map((row) => row.title), ['t1', 't2']);
});

test('объём ограничен: 500 архивных пунктов не забивают базу', () => {
  const many = Array.from({ length: 500 }, (_, index) => entry(0, index));
  assert.equal(freshEntries(many, { nowMs: now, max: 60 }).length, 60);
});

test('пункт без даты доверяем: парсер уже поставил «сейчас»', () => {
  const rows = freshEntries([{ title: 'x', url: 'https://ex.com/x', published: '' }], { nowMs: now });
  assert.equal(rows.length, 1);
});
