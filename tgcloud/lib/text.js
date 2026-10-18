// Чистые функции текста и хешей. Без импортов платформы — гоняются в node --test.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** Экранирование внешнего текста для Telegram-HTML (FR-16). Кавычки не трогаем:
 * они нужны как есть в URL внутри href. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>]/g, (ch) => HTML_ESCAPES[ch]);
}

/** LLM любит <br> и буллеты — в Telegram-HTML такого тега нет (инцидент 2026-09-14). */
export function normalizeLlmText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/^[ \t]*[•·]\s*/gm, '');
}

/** Срезать теги из HTML-фрагмента источника и раскодировать базовые entity. */
export function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Нормализация заголовка для анти-дедупа прямых повторов (iter-19): регистр и
 * небуквенная обвязка не важны. Развитие темы с новой формулировкой не режется. */
export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Боевая формула дедупа (D19/R5): URL без query и хвостового слеша + нормализованный
 * заголовок. В Python — sha256 hex; здесь то же через WebCrypto изолята. */
export async function urlHash(url, title) {
  const base = String(url ?? '').split('?')[0].replace(/\/+$/, '');
  const norm = String(title ?? '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const bytes = new TextEncoder().encode(`${base}|${norm}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Режем текст на сообщения ≤ limit (критерий 5: 4000 символов), не разрывая
 * HTML-тег и entity. Сначала по абзацам, длинный абзац — по строкам, затем по словам.
 */
export function chunkMessage(text, limit = 4000) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  if (source.length <= limit) return [source];
  const chunks = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const paragraph of source.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    flush();
    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }
    for (const piece of splitLongBlock(paragraph, limit)) chunks.push(piece);
  }
  flush();
  return chunks;
}

function splitLongBlock(block, limit) {
  const out = [];
  let rest = block;
  while (rest.length > limit) {
    let cut = safeCut(rest, limit);
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Внутри тега? Между последним '<' и последним '>' стоит '<'. */
function insideTag(text, pos) {
  return text.lastIndexOf('<', pos - 1) > text.lastIndexOf('>', pos - 1);
}

/** Внутри entity (&…; без завершающей точки с запятой)? */
function insideEntity(text, pos) {
  const amp = text.lastIndexOf('&', pos - 1);
  return amp >= 0 && pos - amp <= 10 && !text.slice(amp, pos).includes(';');
}

/**
 * Граница разреза: не внутри тега и не внутри entity — иначе Telegram отклонит HTML.
 * Приоритет — пробел, чтобы куски не рвались посреди слова.
 *
 * shortcut: тег, открытый в одном сообщении и закрытый в следующем, не балансируется;
 * при появлении в выводе LLM многоабзацных <a> — добавить перенос незакрытых тегов.
 */
function safeCut(text, limit) {
  const floor = Math.floor(limit * 0.5);
  for (let pos = limit; pos > floor; pos -= 1) {
    if (text[pos - 1] !== ' ') continue;
    if (insideTag(text, pos) || insideEntity(text, pos)) continue;
    return pos;
  }
  if (insideTag(text, limit)) {
    const open = text.lastIndexOf('<', limit - 1);
    return Math.max(1, open);
  }
  if (insideEntity(text, limit)) {
    const amp = text.lastIndexOf('&', limit - 1);
    return Math.max(1, amp);
  }
  return limit;
}

export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseIso(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

/** «5 пункт(ов)» — чтобы тексты не выглядели машинными. */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}
