// Плановая часть: слоты 09:00/21:00 и интервалы сбора/анализа.
// Чистые функции времени — отдельно от таймеров, чтобы проверялись тестом без часов.

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

export const pad2 = (value) => String(value).padStart(2, '0');

/** Локальные дата и минуты суток для пояса-смещения (минуты от UTC). */
export function localClock(nowMs, tzOffsetMin = 180) {
  const local = new Date(nowMs + tzOffsetMin * MIN_MS);
  return {
    dateKey: `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`,
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    weekday: local.getUTCDay(),
  };
}

export function parseTime(time) {
  const match = String(time ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Слот, который уже наступил, но ещё не отправлен. Догоняем не дольше catchUpMin:
 * сводка «за 09:00», отправленная в 15:00, — это не сводка, а сюрприз.
 * @param {{nowMs:number, times:string[], tzOffsetMin?:number, sentKeys?:Set<string>, catchUpMin?:number}} options
 */
export function dueSlot({ nowMs, times, tzOffsetMin = 180, sentKeys = new Set(), catchUpMin = 180 }) {
  const clock = localClock(nowMs, tzOffsetMin);
  const due = [];
  for (const time of times) {
    const minutes = parseTime(time);
    if (minutes === null) continue;
    if (clock.minutes < minutes) continue;
    if (clock.minutes - minutes > catchUpMin) continue;
    const key = `${clock.dateKey}T${time}`;
    if (sentKeys.has(key)) continue;
    due.push({ key, time, minutes });
  }
  due.sort((a, b) => a.minutes - b.minutes);
  return due[0] ?? null;
}

/** Ближайший будущий слот — для статуса и фронтенда. */
export function nextSlot({ nowMs, times, tzOffsetMin = 180 }) {
  const clock = localClock(nowMs, tzOffsetMin);
  const parsed = times
    .map((time) => ({ time, minutes: parseTime(time) }))
    .filter((row) => row.minutes !== null)
    .sort((a, b) => a.minutes - b.minutes);
  if (!parsed.length) return null;
  const upcoming = parsed.find((row) => row.minutes > clock.minutes);
  const next = upcoming ?? parsed[0];
  const dayShift = upcoming ? 0 : 24 * 60 * MIN_MS;
  const startOfLocalDay = nowMs - clock.minutes * MIN_MS;
  const ms = startOfLocalDay + next.minutes * MIN_MS + dayShift;
  const keyDate = localClock(ms, tzOffsetMin).dateKey;
  return { ms, time: next.time, key: `${keyDate}T${next.time}` };
}

/** Пора ли собирать: интервал с последнего сбора (или первый запуск). */
export function collectDue({ nowMs, lastCollectIso = null, intervalMin = 20 }) {
  if (!lastCollectIso) return true;
  const last = Date.parse(lastCollectIso);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMin * MIN_MS;
}

export function analyzeDue({ nowMs, lastAnalyzeIso = null, everyMin = 10 }) {
  if (!lastAnalyzeIso) return true;
  const last = Date.parse(lastAnalyzeIso);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= everyMin * MIN_MS;
}

/** Ключи слотов из базы: `slot:<key>` → отправлен. */
/** Ключи отправленных слотов: префикс задаётся, потому что слотов два вида (`slot:` и `factslot:`). */
export function sentSlotKeys(stateRows, prefix = 'slot:') {
  return new Set(
    (stateRows ?? [])
      .map((row) => String(row.key ?? ''))
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  );
}
