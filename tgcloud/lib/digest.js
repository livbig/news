// Сборка входа сводки — чистые функции (без sdk): окно, отбор, формат, заголовок.
// Семантика из Python-версии (bot/digest.py + db.pending_items, iter-19/21),
// плюс решение пользователя 2026-10-19: окно не больше 7 дней.

import { escapeHtml, normalizeTitle } from './text.js';

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
export function periodHeader(fromIso, toIso, tzOffsetMin = 180) {
  const fmt = (iso) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    const local = new Date(ms + tzOffsetMin * 60 * 1000);
    const day = String(local.getUTCDate()).padStart(2, '0');
    const month = String(local.getUTCMonth() + 1).padStart(2, '0');
    return `${day}.${month}`;
  };
  const from = fmt(fromIso);
  const to = fmt(toIso);
  const span = from === to ? to : `${from} – ${to}`;
  return `<b>🎯 ГЛАВНОЕ ЗА ПЕРИОД (${span})</b>`;
}

export const EMPTY_TEXT = 'Новых новостей с прошлой сводки нет.';

/** Футер о несобранных источниках: предупреждение в самой сводке, подробности — /sources. */
export function degradedFooter(errors) {
  if (!errors?.length) return '';
  const listing = errors.map((e) => e.url).join(', ');
  return `\n\n⚠ Не удалось собрать ${errors.length} источник(ов): ${listing}\nПодробности — /sources.`;
}

/** Итоговый текст сводки: заголовок + тело + честные пометки о несобранном.
 * Чистая функция — покрыта тестом (ревью 2026-10-19: футер был объявлен, но не вызывался). */
export function composeDigest({ header, summary, capped = false, errors = [], partial = [], unsupported = [] }) {
  const notes = [];
  if (capped) notes.push('окно ограничено 7 днями — более старое не запрашивается');
  if (partial.length) notes.push(`часть источников не отдаёт историю за период (${partial.length}) — по ним сводка неполная`);
  if (unsupported.length) notes.push(`не собираются: ${unsupported.join(', ')} (тип источника пока не перенесён)`);
  const noteBlock = notes.length ? `\n\nℹ️ ${notes.join('; ')}.` : '';
  return `${header}\n\n${summary}${noteBlock}${degradedFooter(errors)}`;
}

/** В сводке должна быть честная пометка пробелов: источник отдал только свежее (R2). */
export function coverageNote({ capped, missingSources = [] }) {
  const parts = [];
  if (capped) parts.push('окно ограничено 7 днями — более старое не запрашивается');
  if (missingSources.length) {
    parts.push(`часть источников не отдаёт историю за период (${missingSources.length}) — по ним сводка неполная`);
  }
  return parts.length ? `\n\nℹ️ ${parts.join('; ')}.` : '';
}
