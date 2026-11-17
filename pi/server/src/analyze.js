// Дневной анализ: каждый собранный пункт получает выжимку, важность и темы.
// Это то, что делает сводки плотными: LLM сводки читает ВЫЖИМКУ, а не сырой текст.
// Служебный вызов без мышления; при недоступности LLM — детерминированный фолбэк,
// чтобы пункт не висел «неразобранным» навсегда.

import { serviceCall } from './llm.js';
import { itemsToAnalyze, saveAnalysisBatch } from './store.js';

const SYSTEM = [
  'Ты — редактор новостного потока. Для каждого пункта дай короткую выжимку и оценку.',
  'Выжимка: 1–2 предложения, только факты из текста, без воды и без оценок.',
  'Важность 1–5: 5 — меняет рынок/политику/индустрию, 1 — шум и самореклама.',
  'Темы: 1–3 короткие метки (например «золото», «ФРС», «AI-модели»).',
  'Ответ — строго JSON-массив объектов {"id":число,"gist":"...","importance":1-5,"topics":["..."]} и ничего больше.',
].join(' ');

const FALLBACK_NOTE = ' (без анализа: LLM недоступна)';

function parseAnalysis(raw, ids) {
  const text = String(raw ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const known = new Set(ids);
  const out = [];
  for (const row of parsed) {
    const id = Number(row?.id);
    if (!known.has(id)) continue;
    const gist = String(row?.gist ?? '').trim().slice(0, 1200);
    if (!gist) continue;
    const rawImportance = Number(row?.importance);
    const importance = Number.isFinite(rawImportance) ? Math.min(5, Math.max(1, rawImportance)) : 3;
    const topics = Array.isArray(row?.topics) ? row.topics.map((topic) => String(topic).trim()).filter(Boolean).slice(0, 4) : [];
    out.push({ id, gist, importance, topics });
  }
  return out;
}

/** Детерминированная выжимка: первые предложения текста. Длиннее — не значит точнее. */
export function fallbackGist(row) {
  const text = String(row?.text ?? '').replace(/\s+/g, ' ').trim();
  const base = text || String(row?.title ?? '').trim();
  if (!base) return { gist: String(row?.title ?? '').slice(0, 200), importance: 2, topics: [] };
  const sentence = base.split(/(?<=[.!?])\s+/)[0] ?? base;
  return { gist: sentence.slice(0, 400), importance: 2, topics: [] };
}

/**
 * Один проход анализа. Возвращает {analyzed, failed}.
 * @param {{batch?:number, minAgeMs?:number, call?:Function}} options
 */
export async function analyzePending({ batch = 15, minAgeMs = 0, call = serviceCall, log = console.log } = {}) {
  const rows = itemsToAnalyze(batch, minAgeMs);
  if (!rows.length) return { analyzed: 0, failed: 0 };
  const ids = rows.map((row) => row.id);
  const input = rows
    .map((row) => {
      const text = String(row.text ?? '').replace(/\s+/g, ' ').slice(0, 700);
      return `#${row.id}\nЗАГОЛОВОК: ${row.title}\nТЕКСТ: ${text || '—'}`;
    })
    .join('\n\n');

  let results = [];
  let failure = null;
  try {
    const raw = await call({ system: SYSTEM, user: input, maxTokens: Math.min(8000, 700 + rows.length * 220) });
    results = parseAnalysis(raw, ids);
  } catch (error) {
    failure = error;
    log(`анализ: LLM не ответила (${error?.message ?? error}), фолбэк на выжимку из текста`);
  }

  const byId = new Map(results.map((row) => [row.id, row]));
  const writes = [];
  for (const row of rows) {
    const found = byId.get(row.id);
    if (found) {
      writes.push({ id: row.id, ...found });
      continue;
    }
    // LLM ответила, но пункт пропущен (шум) — сохраняем фолбэк с пометкой, чтобы не крутить вечно.
    const fallback = fallbackGist(row);
    writes.push({ id: row.id, ...fallback, gist: failure ? fallback.gist + FALLBACK_NOTE : fallback.gist });
  }
  const analyzed = saveAnalysisBatch(writes);
  // Модель ответила, но часть пунктов пропустила: это не сбой, но и не «всё хорошо» —
  // такие пункты ушли в сводку выжимкой из первых предложений. Считаем их отдельно.
  const skipped = failure ? 0 : rows.filter((row) => !byId.has(row.id)).length;
  return { analyzed, failed: failure ? rows.length : 0, skipped };
}
