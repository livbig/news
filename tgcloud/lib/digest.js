// Сборка входа сводки — чистые функции (без sdk): окно, отбор, формат, заголовок.
// Семантика из Python-версии (bot/digest.py + db.pending_items, iter-19/21),
// плюс решение пользователя 2026-10-19: окно не больше 7 дней.

import { escapeHtml, normalizeTitle, plural } from './text.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Окно сводки: от прошлой отправки до сейчас, но не больше windowDays.
 * Дата берётся по нашей метке fetchedAt — даты публикации в фидах ненадёжны (D26).
 */
export function digestWindow({ nowMs, lastSentAt, windowDays = 7, firstWindowHours = 24 }) {
  const now = nowMs;
  const last = Date.parse(String(lastSentAt ?? ''));
  const from = Number.isFinite(last) ? last : now - firstWindowHours * 60 * 60 * 1000;
  const floor = now - windowDays * DAY_MS;
  const start = Math.min(Math.max(from, floor), now);
  return { fromMs: start, toMs: now, capped: start === floor && from < floor };
}

// --- явный период из свободного текста (FR-1) -------------------------------------

/** Названия месяцев: полные (родительный падеж) и трёхбуквенные сокращения. */
const MONTH_WORD =
  '(янв(?:ар[ья])?|фев(?:рал[ья])?|мар(?:та|т)?|апр(?:ел[ья])?|ма[йя]|июн[ья]?|июл[ья]?|авг(?:уста)?|сен(?:т(?:ябр[ья])?)?|окт(?:ябр[ья])?|ноя(?:бр[ья])?|дек(?:абр[ья])?)';

// \w и \b для кириллицы в JS не работают — хвосты слов только через [а-я].
const WEEKDAY_WORD = '(понедельник[а-я]*|вторник[а-я]*|сред[а-я]*|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*)';

const NUMBER_WORD = '(?:один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)';

const NUMBER_VALUES = { один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 };

function monthIndex(word) {
  const rules = [
    [/^янв/, 0],
    [/^фев/, 1],
    [/^мар/, 2],
    [/^апр/, 3],
    [/^ма[йя]$/, 4],
    [/^июн/, 5],
    [/^июл/, 6],
    [/^авг/, 7],
    [/^сен/, 8],
    [/^окт/, 9],
    [/^ноя/, 10],
    [/^дек/, 11],
  ];
  return rules.find(([re]) => re.test(String(word ?? '')))?.[1] ?? null;
}

function weekdayIndex(word) {
  const rules = [
    [/^понедельник/, 1],
    [/^вторник/, 2],
    [/^сред/, 3],
    [/^четверг/, 4],
    [/^пятниц/, 5],
    [/^суббот/, 6],
    [/^воскресень/, 0],
  ];
  return rules.find(([re]) => re.test(String(word ?? '')))?.[1] ?? null;
}

/** Длительность единицы в днях: «3 дня», «2 недели», «месяц», «полгода». */
function unitDays(word) {
  if (/^(дн|день|сут)/.test(word)) return 1;
  if (/^недел/.test(word)) return 7;
  if (/^полгода/.test(word)) return 180;
  if (/^мес/.test(word)) return 30;
  if (/^(год|лет)/.test(word)) return 365;
  return null;
}

const pad2 = (value) => String(value).padStart(2, '0');

/** Локальная полночь дня, в который попадает ms (пояс — минуты от UTC, не константа). */
function localDayStart(ms, tzOffsetMin) {
  const local = new Date(ms + tzOffsetMin * 60_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - tzOffsetMin * 60_000;
}

function localParts(ms, tzOffsetMin) {
  const local = new Date(ms + tzOffsetMin * 60_000);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), weekday: local.getUTCDay() };
}

const dayStartOf = (year, month, day, tzOffsetMin) => Date.UTC(year, month, day) - tzOffsetMin * 60_000;

const localDayLabel = (ms, tzOffsetMin) => {
  const local = new Date(ms + tzOffsetMin * 60_000);
  return `${pad2(local.getUTCDate())}.${pad2(local.getUTCMonth() + 1)}`;
};

/** «19.10» или «16.10–19.10» — подпись окна для статуса и пустой сводки. */
function spanLabel(fromMs, toMs, tzOffsetMin) {
  const from = localDayLabel(fromMs, tzOffsetMin);
  const to = localDayLabel(toMs, tzOffsetMin);
  return from === to ? to : `${from}–${to}`;
}

/** «ДД.ММ ЧЧ:ММ» в поясе читателя — для пометки «те же пункты, что в сводке от…». */
function localDateTimeLabel(iso, tzOffsetMin) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const local = new Date(ms + tzOffsetMin * 60_000);
  return `${localDayLabel(ms, tzOffsetMin)} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
}

/**
 * Период из свободного текста (FR-1). Чистая функция, покрыта tests/js/period.test.js.
 * Глубина не больше maxDays (7): «за месяц» и «за всё время» усекаются с пометкой capped.
 * Дата в будущем — не пустое окно, а признак future: сводку не пишем, отвечаем честно.
 * Несуществующая дата — признак invalid: окно не выдумываем, просим уточнить.
 * openEnd — окно открыто до момента запроса («за 3 дня», «сегодня»): верхней границы нет.
 * ponytail: распознаём формулировки из FR-1, а не язык целиком; расширять — при реальных
 * промахах живого чата (сначала добавить фразу в period.test.js).
 * @param {string|null} hint
 * @returns {{fromMs:number, toMs:number, capped:boolean, label:string, future:boolean, openEnd:boolean}|{invalid:true, label:string}|null}
 */
export function parsePeriod(hint, { nowMs = Date.now(), tzOffsetMin = 180, maxDays = 7 } = {}) {
  const text = String(hint ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Знак препинания — не часть периода: «а что было вчера?», «за 3 дня, пожалуйста»,
    // «сводка (за 3 дня)». Точку снимаем только вне чисел — она разделяет даты («12.10»).
    .replace(/[«»"'(),;:!?…]/g, ' ')
    .replace(/\./g, (dot, index, all) => (/\d/.test(all[index - 1] ?? '') && /\d/.test(all[index + 1] ?? '') ? '.' : ' '))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  const tz = tzOffsetMin;
  const todayStart = localDayStart(nowMs, tz);
  const today = localParts(nowMs, tz);
  const floor = nowMs - maxDays * DAY_MS;

  /** Конец периода по умолчанию — сейчас; границы усекаются на месте, а не в вызывающем коде.
   * Старый диапазон целиком до пола глубины схлопывается в пустое окно: пунктов за него
   * всё равно нет (retention 10 дней), а отдавать окно задом наперёд нельзя. */
  const finish = (fromMs, toMs, label) => {
    if (fromMs > nowMs) return { fromMs, toMs: nowMs, capped: false, future: true, openEnd: true, label };
    const capped = fromMs < floor;
    const start = capped ? floor : fromMs;
    const end = Math.min(toMs, nowMs);
    return { fromMs: capped ? Math.min(start, end) : start, toMs: end, capped, future: false, openEnd: end >= nowMs, label };
  };
  const invalid = (label) => ({ invalid: true, label });

  if (/за все время|за весь период|с самого начала/.test(text)) return finish(nowMs - 400 * DAY_MS, nowMs, 'всё время');

  if (/(^|\s)позавчера(\s|$)/.test(text)) return finish(todayStart - 2 * DAY_MS, todayStart - DAY_MS, 'позавчера');
  if (/(^|\s)вчера(\s|$)/.test(text)) return finish(todayStart - DAY_MS, todayStart, 'вчера');
  if (/(^|\s)сегодня(\s|$)/.test(text)) return finish(todayStart, nowMs, 'сегодня');

  // «с 1 по 5 октября» / «с 12 октября по 18 октября»: месяц может стоять после каждой
  // даты — «с 30 сентября по 2 октября» раньше читалось как «с первой даты» без конца (P2-1).
  const range = text.match(
    new RegExp(
      `(?:^|\\s)(?:с|со)\\s+(?<fromDay>\\d{1,2})(?:[./](?<fromNum>\\d{1,2}))?(?:\\s+(?<fromWord>${MONTH_WORD}))?`
        + `\\s+по\\s+(?<toDay>\\d{1,2})(?:[./](?<toNum>\\d{1,2}))?(?:\\s+(?<toWord>${MONTH_WORD}))?(?:\\s|$)`,
    ),
  );
  if (range) {
    const { fromDay, fromNum, fromWord, toDay, toNum, toWord } = range.groups;
    const from = Number(fromDay);
    const to = Number(toDay);
    const fromMonth = monthIndex(fromWord) ?? numberMonth(fromNum) ?? monthIndex(toWord) ?? numberMonth(toNum) ?? today.month;
    // Месяц конца берётся из его собственной даты: диапазон может идти через границу месяца.
    const toMonth = monthIndex(toWord) ?? numberMonth(toNum) ?? fromMonth;
    let year = today.year;
    if (dayStartOf(year, fromMonth, from, tz) > nowMs) year -= 1;
    const toYear = toMonth < fromMonth ? year + 1 : year; // «с 28 декабря по 3 января»
    // Один день одним числом: «с 25 по 25 октября» — это «25.10», а не «25.10–25.10».
    const label = fromMonth === toMonth && from === to
      ? `${pad2(from)}.${pad2(fromMonth + 1)}`
      : `${pad2(from)}.${pad2(fromMonth + 1)}–${pad2(to)}.${pad2(toMonth + 1)}`;
    // «с 31 февраля» и «с 25 по 5» — не окно, а опечатка: кривое окно хуже отказа.
    if (invalidDay(from, fromMonth, year) || invalidDay(to, toMonth, toYear) || (toMonth === fromMonth && to < from)) return invalid(label);
    return finish(dayStartOf(year, fromMonth, from, tz), dayStartOf(toYear, toMonth, to + 1, tz), label);
  }

  const iso = text.match(/(?:^|\s)(?:с|со|за)\s+(\d{4})-(\d{1,2})-(\d{1,2})(?:\s|$)/);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
    if (invalidDay(day, month, year)) return invalid(`${pad2(day)}.${pad2(month + 1)}`);
    return finish(dayStartOf(year, month, day, tz), nowMs, `${pad2(day)}.${pad2(month + 1)}`);
  }

  const wordDate = text.match(new RegExp(`(?:^|\\s)(?:с|со|за)\\s+(\\d{1,2})\\s+(${MONTH_WORD})(?:\\s|$)`));
  if (wordDate) {
    const day = Number(wordDate[1]);
    const month = monthIndex(wordDate[2]);
    let year = today.year;
    if (dayStartOf(year, month, day, tz) > nowMs) year -= 1; // год текущий, будущее — предыдущий
    if (invalidDay(day, month, year)) return invalid(`${pad2(day)}.${pad2(month + 1)}`);
    return finish(dayStartOf(year, month, day, tz), nowMs, `${pad2(day)}.${pad2(month + 1)}`);
  }

  const numDate = text.match(/(?:^|\s)(?:с|со|за)\s+(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:\s|$)/);
  if (numDate) {
    const day = Number(numDate[1]);
    const month = Number(numDate[2]) - 1;
    const explicitYear = numDate[3] ? (Number(numDate[3]) < 100 ? 2000 + Number(numDate[3]) : Number(numDate[3])) : null;
    let year = explicitYear ?? today.year;
    if (!explicitYear && dayStartOf(year, month, day, tz) > nowMs) year -= 1;
    if (invalidDay(day, month, year)) return invalid(`${pad2(day)}.${pad2(month + 1)}`);
    return finish(dayStartOf(year, month, day, tz), nowMs, `${pad2(day)}.${pad2(month + 1)}`);
  }

  const weekday = text.match(new RegExp(`(?:^|\\s)(?:с|со)\\s+(?:(прошл[а-я]*)\\s+)?(${WEEKDAY_WORD})(?:\\s|$)`));
  if (weekday) {
    const target = weekdayIndex(weekday[2]);
    if (target !== null) {
      const back = (today.weekday - target + 7) % 7;
      const from = todayStart - back * DAY_MS - (weekday[1] ? 7 * DAY_MS : 0);
      return finish(from, nowMs, spanLabel(from, nowMs, tz));
    }
  }

  const relative = text.match(
    new RegExp(`(?:^|\\s)за\\s+(?:последн[а-я]*\\s+)?(\\d+|${NUMBER_WORD})\\s*(дн[а-я]*|день|сут[а-я]*|недел[а-я]*|мес[а-я]*|год[а-я]*|лет)(?:\\s|$)`),
  );
  if (relative) {
    const count = Number(relative[1]) || NUMBER_VALUES[relative[1]];
    const days = unitDays(relative[2]);
    if (count && days) return finish(nowMs - count * days * DAY_MS, nowMs, `${relative[1]} ${relative[2]}`);
  }

  const unit = text.match(/(?:^|\s)за\s+(неделю|недели|недель|сутки|суток|день|месяц|месяца|месяцев|полгода|год|года|лет)(?:\s|$)/);
  if (unit) return finish(nowMs - unitDays(unit[1]) * DAY_MS, nowMs, unit[1]);

  return null;
}

function numberMonth(value) {
  if (value == null) return null;
  const month = Number(value) - 1;
  return month >= 0 && month <= 11 ? month : null;
}

/** Есть ли такой день в месяце: «31 февраля» и «30.02.2024» — не даты (FR-1). */
function invalidDay(day, month, year) {
  if (month == null || month < 0 || month > 11 || day < 1 || day > 31) return true;
  return day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Пункты в явном периоде (FR-2). Верхняя граница — только у закрытого окна, конец которого
 * в прошлом («за вчера», «с A по B»): у «за 3 дня» конец = момент запроса, а fetchedAt
 * свежесобранного пункта ставится на 5–14 с позже — фильтр выбрасывал весь текущий сбор.
 * Закрытое окно считается по дате публикации (P2-8): пункт, опубликованный вчера и
 * собранный сегодня, обязан попасть в «за вчера». fetchedAt — запасной вариант без published.
 */
export function rowsInPeriod(candidates, period) {
  if (!period || period.invalid || period.openEnd) return candidates;
  return candidates.filter((row) => {
    const ms = Date.parse(row.published ?? '') || Date.parse(row.fetchedAt ?? '');
    return ms >= period.fromMs && ms < period.toMs;
  });
}

/**
 * Источники, у которых самый старый пункт новее начала периода: историю за период они
 * не отдают (RSS с «последними 20»), и сводка по ним неполная (FR-3).
 */
export function shortHistorySources(rows, fromMs, { slackMs = DAY_MS } = {}) {
  const oldest = new Map();
  for (const row of rows ?? []) {
    const ms = Date.parse(row.fetchedAt ?? '');
    if (!Number.isFinite(ms)) continue;
    const previous = oldest.get(row.sourceId);
    if (previous === undefined || ms < previous) oldest.set(row.sourceId, ms);
  }
  return [...oldest.entries()].filter(([, ms]) => ms > fromMs + slackMs).map(([sourceId]) => sourceId);
}

/**
 * Отбор пунктов: без повторов прошлых сводок, не больше perSource на источник,
 * не больше maxItems вообще и maxChars по символам входа.
 * rows: {id, sourceId, title, url, text, gist, published, fetchedAt} — уже отсортированы
 * по published DESC (свежая копия дубля выигрывает).
 */
export function selectPending(rows, {
  perSource = 15,
  maxItems = 800,
  maxChars = 600000,
  consumedUrls = new Set(),
  consumedTitles = new Set(),
}) {
  const perSourceCount = new Map();
  const seenUrls = new Set();
  const seenTitles = new Set();
  const selected = [];
  let chars = 0;
  for (const row of rows) {
    if (selected.length >= maxItems) break;
    const url = String(row.url ?? '').trim();
    const titleKey = normalizeTitle(row.title);
    if (!url || consumedUrls.has(url) || (titleKey && consumedTitles.has(titleKey))) continue;
    if (seenUrls.has(url) || (titleKey && seenTitles.has(titleKey))) continue; // дубль внутри выборки
    const used = perSourceCount.get(row.sourceId) ?? 0;
    if (used >= perSource) continue;
    const size = entrySize(row);
    if (selected.length > 0 && chars + size > maxChars) break;
    perSourceCount.set(row.sourceId, used + 1);
    seenUrls.add(url);
    if (titleKey) seenTitles.add(titleKey);
    chars += size;
    selected.push(row);
  }
  return { selected, chars };
}

function entrySize(row) {
  const title = String(row.title ?? '');
  const url = String(row.url ?? '');
  const body = String(row.gist ?? '').trim() || String(row.text ?? '').trim();
  return title.length + url.length + Math.min(body.length, 1200) + 24;
}

/** Вход мега-вызова: блок <новости> (контракт промпта). Внешние строки экранируются (FR-16). */
export function formatItemsInput(rows, textCap = 1200) {
  const lines = rows.map((row) => {
    let line = `${escapeHtml(row.title)} — ${escapeHtml(row.url)}`;
    const gist = String(row.gist ?? '').trim();
    if (gist) {
      line += `\nВЫЖИМКА: ${escapeHtml(gist)}`;
      return line;
    }
    const text = String(row.text ?? '').trim();
    if (text) {
      const excerpt = text.length > textCap ? `${text.slice(0, textCap)}…` : text;
      line += `\nТЕКСТ: ${escapeHtml(excerpt)}`;
    }
    return line;
  });
  return `<новости>\n${lines.join('\n\n')}\n</новости>`;
}

/** Детерминированный заголовок периода (iter-17): LLM лид форматировала нестабильно. */
/** Подпись периода «ДД.ММ – ДД.ММ» в поясе читателя (одна дата, если день тот же). */
export function periodSpan(fromIso, toIso, tzOffsetMin = 180) {
  const fmt = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? localDayLabel(ms, tzOffsetMin) : '—';
  };
  const from = fmt(fromIso);
  const to = fmt(toIso);
  return from === to ? to : `${from} – ${to}`;
}

export function periodHeader(fromIso, toIso, tzOffsetMin = 180) {
  return `<b>🎯 ГЛАВНОЕ ЗА ПЕРИОД (${periodSpan(fromIso, toIso, tzOffsetMin)})</b>`;
}

export const EMPTY_TEXT = 'Новых с прошлой сводки нет. Можно попросить «сводка за неделю» — покажу всё за 7 дней.';

/** Футер о несобранных источниках: предупреждение в самой сводке, подробности — /sources. */
export function degradedFooter(errors) {
  if (!errors?.length) return '';
  const listing = errors.map((e) => escapeHtml(e.url)).join(', ');
  return `\n\n⚠ Не удалось собрать ${errors.length} источник(ов): ${listing}\nПодробности — /sources.`;
}

/** Итоговый текст сводки: заголовок + тело + честные пометки о несобранном.
 * Чистая функция — покрыта тестом (ревью 2026-10-19: футер был объявлен, но не вызывался).
 * sameAs — время прошлой сводки, если набор пунктов совпал (FR-3): повтор честно назван повтором.
 * deferred — сколько медленных источников в эту сводку не собирались (FR-9): молчать нельзя.
 * shortHistory — сколько источников не отдают историю за запрошенный период (FR-3).
 */
export function composeDigest({ header, summary, capped = false, errors = [], partial = [], unsupported = [], deferred = 0, shortHistory = [], sameAs = null, tzOffsetMin = 180 }) {
  const notes = [];
  if (capped) notes.push('окно ограничено 7 днями — более старое не запрашивается');
  if (sameAs) notes.push(`Это те же пункты, что в сводке от ${localDateTimeLabel(sameAs, tzOffsetMin)}`);
  if (deferred) notes.push(`каналы и страницы (${deferred}) в эту сводку не собирались — их пункты уйдут в следующую`);
  if (shortHistory.length) notes.push(`часть источников не отдаёт историю за период (${shortHistory.length}) — по ним сводка неполная`);
  if (partial.length) {
    const reasons = [...new Set(partial.map((p) => (typeof p === 'string' ? 'история недоступна' : p.reason)))];
    notes.push(`часть источников собрана неполно (${partial.length}): ${reasons.join('; ')}`);
  }
  if (unsupported.length) notes.push(`не собираются: ${unsupported.map((url) => escapeHtml(url)).join(', ')} (тип источника пока не перенесён)`);
  const noteBlock = notes.length ? `\n\nℹ️ ${notes.join('; ')}.` : '';
  return `${header}\n\n${summary}${noteBlock}${degradedFooter(errors)}`;
}

/** Пустой явный период (FR-11): цифры сбора честные — медленные источники отдельным счётом,
 * иначе «собрано 0 источников» врёт про те, которые в этом вызове не трогали (FR-9).
 * Число называется опросом, а не сбором: это источники, которые тронули в вызове, а не
 * те, что дали пункты (P2-10); числа согласуются с существительным. */
export function emptyPeriodText({ span, polled, deferred = 0, errors = 0 }) {
  const counted = deferred
    ? `опрошено ${plural(polled, 'быстрый источник', 'быстрых источника', 'быстрых источников')}; каналы и страницы (${deferred}) в эту сводку не собирались`
    : `опрошено ${plural(polled, 'источник', 'источника', 'источников')}`;
  return `За период ${span} пунктов нет (${counted}, ошибок ${errors}).`;
}

