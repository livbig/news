import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeriod, rowsInPeriod } from '../../tgcloud/lib/digest.js';

const DAY = 24 * 60 * 60 * 1000;
// 12:00 MSK понедельника 19.10.2026 — от него считаются все окна.
const now = Date.parse('2026-10-19T09:00:00Z');
const tz = 180; // Europe/Moscow, значение users.tz_offset_min по умолчанию
const parse = (hint, options = {}) => parsePeriod(hint, { nowMs: now, tzOffsetMin: tz, ...options });

test('«за 3 дня» — ровно 72 часа назад и до сейчас', () => {
  const period = parse('за 3 дня');
  assert.equal(period.toMs, now);
  assert.ok(Math.abs(now - period.fromMs - 3 * DAY) <= 60_000, `fromMs=${new Date(period.fromMs).toISOString()}`);
  assert.equal(period.capped, false);
  assert.ok(period.label);
});

test('«за неделю», «за последние 2 недели», «за сутки» — относительные окна', () => {
  assert.equal(now - parse('за неделю').fromMs, 7 * DAY);
  assert.equal(now - parse('за сутки').fromMs, DAY);
  const two = parse('за последние 2 недели');
  assert.equal(two.capped, true, '14 дней усекаются до 7');
  assert.equal(now - two.fromMs, 7 * DAY);
});

test('«за месяц» и «за 10 дней» усекаются до 7 дней с пометкой', () => {
  for (const hint of ['за месяц', 'за 10 дней', 'за год']) {
    const period = parse(hint);
    assert.equal(period.capped, true, hint);
    assert.equal(now - period.fromMs, 7 * DAY, hint);
    assert.equal(period.toMs, now);
  }
});

test('«за сегодня» — от полуночи MSK до сейчас', () => {
  const period = parse('за сегодня');
  assert.equal(period.fromMs, Date.parse('2026-10-18T21:00:00Z'));
  assert.equal(period.toMs, now);
});

test('P1-2: знак препинания не убивает период', () => {
  const cases = [
    ['а что было вчера?', Date.parse('2026-10-17T21:00:00Z')],
    ['за 3 дня.', now - 3 * DAY],
    ['за 3 дня,', now - 3 * DAY],
    ['с 16 октября?', Date.parse('2026-10-15T21:00:00Z')],
    ['что было с понедельника?', Date.parse('2026-10-18T21:00:00Z')],
  ];
  for (const [hint, fromMs] of cases) {
    const period = parse(hint);
    assert.ok(period, `период разобран: ${hint}`);
    assert.equal(period.fromMs, fromMs, hint);
  }
});

test('«за вчера» и «а что было вчера» — сутки MSK, конец в полночь сегодня', () => {
  for (const hint of ['за вчера', 'а что было вчера']) {
    const period = parse(hint);
    assert.equal(period.fromMs, Date.parse('2026-10-17T21:00:00Z'), hint);
    assert.equal(period.toMs, Date.parse('2026-10-18T21:00:00Z'), hint);
  }
});

test('«за позавчера» — сутки до вчерашней полуночи', () => {
  const period = parse('за позавчера');
  assert.equal(period.fromMs, Date.parse('2026-10-16T21:00:00Z'));
  assert.equal(period.toMs, Date.parse('2026-10-17T21:00:00Z'));
});

test('«с понедельника» и «со вторника» — от полуночи этого дня недели', () => {
  assert.equal(parse('с понедельника').fromMs, Date.parse('2026-10-18T21:00:00Z'));
  assert.equal(parse('со вторника').fromMs, Date.parse('2026-10-12T21:00:00Z'), 'вторник прошлой недели');
});

test('«с прошлой пятницы» — день недели неделей раньше, глубина усекается', () => {
  const period = parse('с прошлой пятницы');
  assert.equal(period.fromMs, now - 7 * DAY);
  assert.equal(period.capped, true);
  assert.equal(parse('с пятницы').fromMs, Date.parse('2026-10-15T21:00:00Z'), 'ближайшая пятница — без усечения');
});

test('«с 3 октября» и «с 03.10» — полночь MSK указанного дня', () => {
  assert.equal(parse('с 16 октября').fromMs, Date.parse('2026-10-15T21:00:00Z'));
  const old = parse('с 03.10');
  assert.equal(old.fromMs, now - 7 * DAY, 'старше 7 дней — усечение до пола');
  assert.equal(old.capped, true);
});

test('«с 1 по 5 октября» — конец в полночь дня после конца диапазона', () => {
  const period = parse('с 14 по 16 октября');
  assert.equal(period.fromMs, Date.parse('2026-10-13T21:00:00Z'));
  assert.equal(period.toMs, Date.parse('2026-10-16T21:00:00Z'));
});

test('«с 1 по 5» без месяца — текущий месяц', () => {
  const period = parse('с 14 по 16');
  assert.equal(period.fromMs, Date.parse('2026-10-13T21:00:00Z'));
  assert.equal(period.toMs, Date.parse('2026-10-16T21:00:00Z'));
});

test('диапазон целиком старше 7 дней — пустое окно с пометкой, а не задом наперёд', () => {
  const period = parse('с 1 по 5 октября');
  assert.equal(period.capped, true);
  assert.equal(period.fromMs, period.toMs);
  assert.equal(period.toMs, Date.parse('2026-10-05T21:00:00Z'));
});

test('«за всё время» и «с самого начала» — максимум 7 дней с пометкой', () => {
  for (const hint of ['за все время', 'с самого начала']) {
    const period = parse(hint);
    assert.equal(period.capped, true, hint);
    assert.equal(now - period.fromMs, 7 * DAY, hint);
  }
});

test('дата в будущем — отдельный признак, а не пустой период', () => {
  const period = parse('с 2027-01-01');
  assert.equal(period.future, true);
  assert.equal(period.fromMs, Date.parse('2026-12-31T21:00:00Z'));
});

test('период в тексте не меняет пояс: смещение берётся из настроек', () => {
  const utc = parsePeriod('за сегодня', { nowMs: now, tzOffsetMin: 0 });
  assert.equal(utc.fromMs, Date.parse('2026-10-19T00:00:00Z'));
});

test('без периода — null (свободный текст не превращается в сводку)', () => {
  for (const hint of ['', null, 'пожалуйста', 'по золоту', 'что у меня в интересах']) {
    assert.equal(parse(hint), null, String(hint));
  }
});

test('P2: несуществующая дата — честный отказ, а не тихо неверное окно', () => {
  for (const hint of ['с 31 февраля', 'с 30 февраля 2024', 'с 30.02.2024', 'с 25 по 5', 'с 1.13']) {
    const period = parse(hint);
    assert.equal(period?.invalid, true, `${hint} → ${JSON.stringify(period)}`);
    assert.ok(period.label, hint);
  }
  assert.equal(parse('с 28 февраля').invalid, undefined, 'существующая дата остаётся периодом');
});

// P0-1: сводка за относительный период не выбрасывает то, что собрала сама.
const started = now; // начало вызова: в этот момент считаются все окна
const fetched = (id, iso) => ({ id, sourceId: 1, fetchedAt: iso });
const freshRows = [
  fetched(1, '2026-10-19T08:59:00Z'),
  fetched(2, '2026-10-19T09:00:04Z'), // собрано этим же вызовом
  fetched(3, '2026-10-19T09:00:12Z'),
];

test('P0-1: свежесобранные пункты входят в сводку за относительный период', () => {
  for (const hint of ['за 3 дня', 'за неделю', 'за сегодня']) {
    const period = parse(hint);
    assert.equal(period.openEnd, true, hint);
    assert.deepEqual(rowsInPeriod(freshRows, period).map((row) => row.id), [1, 2, 3], hint);
  }
});

test('P0-1: у окна с концом в прошлом верхняя граница работает', () => {
  const yesterday = parse('за вчера');
  assert.equal(yesterday.openEnd, false);
  const rows = [fetched(4, '2026-10-18T08:00:00Z'), ...freshRows];
  assert.deepEqual(rowsInPeriod(rows, yesterday).map((row) => row.id), [4]);
  assert.equal(parse('с 14 по 16 октября').openEnd, false);
  assert.deepEqual(rowsInPeriod(freshRows, parse('с 14 по 16 октября')), []);
});
