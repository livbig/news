import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestWindow, formatItemsInput, joinDigestParts, mergeSections, periodHeader, periodSpan, rowsInRecent, selectPending, shortHistorySources, splitEditor, splitIntoParts } from '../../_archive/tgcloud-2026-11-16/tgcloud/lib/digest.js';

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

test('обычная сводка за сутки: старое окно режется до 24 часов', () => {
  const old = digestWindow({ nowMs: now, lastSentAt: new Date(now - 3 * DAY).toISOString(), windowDays: 1 });
  assert.equal(now - old.fromMs, DAY);
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

test('период для текстов: те же даты, что и в заголовке, без разметки', () => {
  assert.equal(periodSpan('2026-10-17T10:00:00Z', '2026-10-19T06:00:00Z', 180), '17.10 – 19.10');
  assert.equal(periodSpan('2026-10-19T06:00:00Z', '2026-10-19T09:00:00Z', 180), '19.10');
});

test('composeDigest: пометка «те же пункты», когда набор совпал с прошлой сводкой', async () => {
  const { composeDigest } = await import('../../_archive/tgcloud-2026-11-16/tgcloud/lib/digest.js');
  const text = composeDigest({ header: 'h', summary: 's', sameAs: '2026-10-19T06:05:00Z', tzOffsetMin: 180 });
  assert.match(text, /Это те же пункты, что в сводке от 19\.10 09:05/);
  assert.ok(!composeDigest({ header: 'h', summary: 's', sameAs: null }).includes('те же пункты'));
});

test('composeDigest: честные пометки о несобранном и футер', async () => {
  const { composeDigest } = await import('../../_archive/tgcloud-2026-11-16/tgcloud/lib/digest.js');
  const text = composeDigest({
    header: '<b>🎯 ГЛАВНОЕ ЗА ПЕРИОД (19.10)</b>',
    summary: 'тело',
    capped: true,
    errors: [{ url: 'https://a' }],
    partial: ['https://b'],
    unsupported: ['https://news.ycombinator.com'],
  });
  assert.match(text, /Окно ограничено 7 днями|окно ограничено 7 днями/);
  assert.match(composeDigest({ header: 'h', summary: 's', capped: true, capText: 'показаны новости за последние сутки' }), /показаны новости за последние сутки/);
  assert.match(text, /собрана неполно/);
  assert.match(text, /история недоступна/);
  assert.match(text, /не собираются: https:\/\/news\.ycombinator\.com/);
  assert.match(text, /Не удалось собрать 1 источник/);
  assert.ok(!composeDigest({ header: 'h', summary: 's' }).includes('ℹ️'), 'без проблем — без пометок');
});

test('P1-4: пометка о несобранных медленных источниках', async () => {
  const { composeDigest } = await import('../../_archive/tgcloud-2026-11-16/tgcloud/lib/digest.js');
  const text = composeDigest({ header: 'h', summary: 's', deferred: 2 });
  assert.match(text, /каналы и страницы \(2\) в эту сводку не собирались/);
  assert.ok(!composeDigest({ header: 'h', summary: 's', deferred: 0 }).includes('не собирались'));
});

test('P1-8: пометка о неполной истории источников выводится в сводке', async () => {
  const { composeDigest } = await import('../../_archive/tgcloud-2026-11-16/tgcloud/lib/digest.js');
  const text = composeDigest({ header: 'h', summary: 's', shortHistory: [1, 2] });
  assert.match(text, /часть источников не отдаёт историю за период \(2\)/);
  assert.ok(!composeDigest({ header: 'h', summary: 's' }).includes('историю за период'));
});

test('P1-8: источник, у которого самый старый пункт новее начала периода', () => {
  const fromMs = Date.parse('2026-10-12T09:00:00Z');
  const rows = [
    { sourceId: 1, fetchedAt: '2026-10-12T10:00:00Z' },
    { sourceId: 1, fetchedAt: '2026-10-18T10:00:00Z' },
    { sourceId: 2, fetchedAt: '2026-10-15T10:00:00Z' }, // добавлен позже — истории за период нет
    { sourceId: 2, fetchedAt: '2026-10-18T10:00:00Z' },
  ];
  assert.deepEqual(shortHistorySources(rows, fromMs), [2]);
  assert.deepEqual(shortHistorySources([], fromMs), []);
});

test('свежесть по published: старая статья не выдаётся за новость за сутки', () => {
  const rows = [
    row(1, 1, 'свежая', { published: '2026-10-19T08:00:00Z' }),
    row(2, 2, 'старая', { published: '2026-10-17T08:00:00Z' }),
    { id: 3, sourceId: 3, title: 'без даты', published: null, fetchedAt: '2026-10-19T08:59:00Z' },
  ];
  assert.deepEqual(rowsInRecent(rows, now - DAY).map((r) => r.id), [1, 3]);
});

test('веер делит пункты без потерь и склеивает части с номерами', () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(i + 1, 1, `Пункт ${i}`));
  assert.deepEqual(splitIntoParts(rows, 2).map((part) => part.map((r) => r.id)), [[1, 2, 3], [4, 5]]);
  assert.deepEqual(splitIntoParts(rows, 1).map((part) => part.length), [5]);
  assert.deepEqual(splitIntoParts([], 2), []);
  assert.equal(
    joinDigestParts([{ index: 0, text: 'A' }, { index: 1, text: 'B' }]),
    '<b>— ЧАСТЬ 1 —</b>\n\nA\n\n<b>— ЧАСТЬ 2 —</b>\n\nB',
  );
  assert.equal(joinDigestParts([{ index: 0, text: 'A' }]), 'A');
  assert.equal(joinDigestParts([{ index: 1, text: 'B' }]), '<b>— ЧАСТЬ 2 —</b>\n\nB');
});

test('редактор веера: лид отдельно, синтез и радар в конце', () => {
  const split = splitEditor('Лид\n\n<b>🧠 СИНТЕЗ</b>\nS\n\n<b>👀 НА РАДАРЕ</b>\nR');
  assert.equal(split.lead, 'Лид');
  assert.match(split.tail, /^<b>🧠 СИНТЕЗ<\/b>/);
  assert.match(split.tail, /НА РАДАРЕ/);
  assert.deepEqual(splitEditor('только лид'), { lead: 'только лид', tail: '' });
  assert.deepEqual(splitEditor(''), { lead: '', tail: '' });
});

test('mergeSections: одинаковые разделы двух частей склеиваются, лид и синтез на местах', () => {
  const text = 'Лид\n\n<b>— ЧАСТЬ 1 —</b>\n\n<b>📈 РЫНОК США</b>\nA\n\n<b>💵 ВАЛЮТЫ</b>\nB\n\n<b>— ЧАСТЬ 2 —</b>\n\n<b>📈 РЫНОК США</b>\nC\n\n<b>💵 ВАЛЮТЫ</b>\nD\n\n<b>🧠 СИНТЕЗ</b>\nS';
  const out = mergeSections(text);
  assert.equal((out.match(/РЫНОК США/g) ?? []).length, 1);
  assert.match(out, /A\nC/);
  assert.match(out, /B\nD/);
  assert.ok(out.startsWith('Лид'));
  assert.ok(out.endsWith('<b>🧠 СИНТЕЗ</b>\nS'));
  const prefix = mergeSections('<b>💡 ИНВЕСТ-ИДЕИ / ФОРУМЫ</b>\nA\n\n<b>💡 ИНВЕСТ-ИДЕИ</b>\nB');
  assert.equal((prefix.match(/ИНВЕСТ-ИДЕИ/g) ?? []).length, 1);
  const ai = mergeSections('<b>🤖 AI-МОДЕЛИ И ИНФРАСТРУКТУРА</b>\nA\n\n<b>🤖 AI-МОДЕЛИ И ИНСТРУМЕНТЫ</b>\nB');
  assert.equal((ai.match(/AI-МОДЕЛИ/g) ?? []).length, 1);
  assert.match(ai, /A\nB/);
  const macro = mergeSections('<b>🏦 МАКРО И ЦБ</b>\nA\n\n<b>🏦 МАКРО И РЕГУЛИРОВАНИЕ</b>\nB');
  assert.equal((macro.match(/МАКРО/g) ?? []).length, 1);
  const robots = mergeSections('<b>🚀 IPO/РОБОТЫ/БИОТЕХ</b>\nA\n\n<b>🚀 ФИЗИЧЕСКИЙ AI / РОБОТЫ</b>\nB');
  assert.equal((robots.match(/РОБОТЫ/g) ?? []).length, 1);
});

test('P1-4: пустой период не врёт про «собрано 0», когда медленные не трогали', async () => {
  const { emptyPeriodText } = await import('../../_archive/tgcloud-2026-11-16/tgcloud/lib/digest.js');
  const text = emptyPeriodText({ span: '13.10 – 19.10', polled: 0, deferred: 3, errors: 0 });
  assert.match(text, /За период 13\.10 – 19\.10 пунктов нет/);
  assert.match(text, /каналы и страницы \(3\) в эту сводку не собирались/);
});

test('P2-10: пустой период согласует число и не называет опрос сбором', async () => {
  const { emptyPeriodText } = await import('../../_archive/tgcloud-2026-11-16/tgcloud/lib/digest.js');
  assert.equal(emptyPeriodText({ span: '19.10', polled: 4, errors: 1 }), 'За период 19.10 пунктов нет (опрошено 4 источника, ошибок 1).');
  assert.match(emptyPeriodText({ span: '19.10', polled: 1, errors: 0 }), /опрошено 1 источник,/);
  assert.match(emptyPeriodText({ span: '19.10', polled: 5, errors: 0 }), /опрошено 5 источников,/);
  const slow = emptyPeriodText({ span: '19.10', polled: 3, deferred: 2, errors: 1 });
  assert.match(slow, /опрошено 3 быстрых источника/);
  assert.match(slow, /каналы и страницы \(2\)/);
});
