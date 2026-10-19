import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestWindow, formatItemsInput, periodHeader, selectPending } from '../../tgcloud/lib/digest.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-19T09:00:00Z');
const row = (id, sourceId, title, extra = {}) => ({ id, sourceId, title, url: extra.url ?? `https://ex.com/${id}`, text: extra.text ?? '', gist: extra.gist ?? null, published: extra.published ?? '2026-10-19T08:00:00Z', fetchedAt: extra.fetchedAt ?? '2026-10-19T08:59:00Z' });

test('окно: от прошлой сводки, первая — сутки', () => {
  const first = digestWindow({ nowMs: now, lastSentAt: null });
  assert.equal(now - first.fromMs, DAY);
  const week = digestWindow({ nowMs: now, lastSentAt: new Date(now - 2 * DAY).toISOString() });
  assert.equal(now - week.fromMs, 2 * DAY);
});

test('окно не длиннее 7 дней и помечается capped', () => {
  const old = digestWindow({ nowMs: now, lastSentAt: new Date(now - 30 * DAY).toISOString() });
  assert.equal(now - old.fromMs, 7 * DAY);
  assert.equal(old.capped, true);
});

test('per-source бюджет: болтливый источник не съедает сводку', () => {
  const rows = [row(1, 1, 'A'), row(2, 1, 'B'), row(3, 1, 'C'), row(4, 2, 'D')];
  const { selected } = selectPending(rows, { perSource: 2 });
  assert.deepEqual(selected.map((r) => r.id), [1, 2, 4]);
});

test('дедуп: прямые повторы (url и заголовок) не повторяются', () => {
  const rows = [row(1, 1, 'Золото растёт', { url: 'https://ex.com/z' }), row(2, 2, 'золото  растёт!', { url: 'https://ex.com/other' })];
  assert.deepEqual(selectPending(rows, {}).selected.map((r) => r.id), [1]);
  const again = selectPending(rows, { consumedTitles: new Set() });
  assert.equal(again.selected.length, 1);
});

test('кап по символам входа останавливает отбор, а не режет пункт', () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(i + 1, i + 1, `Пункт ${i}`, { text: 'т'.repeat(1200) }));
  const { selected, chars } = selectPending(rows, { maxChars: 5000 });
  assert.ok(selected.length >= 3 && selected.length < 50);
  assert.ok(chars <= 5000 + 1600);
});

test('вход оборачивается в <новости> и не ломает HTML внешними строками', () => {
  const input = formatItemsInput([row(1, 1, 'a < b', { gist: 'выжимка & вывод' })], 100);
  assert.ok(input.startsWith('<новости>') && input.endsWith('</новости>'));
  assert.match(input, /a &lt; b/);
  assert.match(input, /ВЫЖИМКА: выжимка &amp; вывод/);
});

test('заголовок периода в московском времени', () => {
  assert.equal(periodHeader('2026-10-17T10:00:00Z', '2026-10-19T06:00:00Z', 180), '<b>🎯 ГЛАВНОЕ ЗА ПЕРИОД (17.10 – 19.10)</b>');
  assert.equal(periodHeader('2026-10-19T06:00:00Z', '2026-10-19T09:00:00Z', 180), '<b>🎯 ГЛАВНОЕ ЗА ПЕРИОД (19.10)</b>');
});

test('composeDigest: честные пометки о несобранном и футер', async () => {
  const { composeDigest } = await import('../../tgcloud/lib/digest.js');
  const text = composeDigest({
    header: '<b>🎯 ГЛАВНОЕ ЗА ПЕРИОД (19.10)</b>',
    summary: 'тело',
    capped: true,
    errors: [{ url: 'https://a' }],
    partial: ['https://b'],
    unsupported: ['https://news.ycombinator.com'],
  });
  assert.match(text, /Окно ограничено 7 днями|окно ограничено 7 днями/);
  assert.match(text, /часть источников не отдаёт историю/);
  assert.match(text, /не собираются: https:\/\/news\.ycombinator\.com/);
  assert.match(text, /Не удалось собрать 1 источник/);
  assert.ok(!composeDigest({ header: 'h', summary: 's' }).includes('ℹ️'), 'без проблем — без пометок');
});
