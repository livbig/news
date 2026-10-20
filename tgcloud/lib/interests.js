// Интересы (FR-5…FR-8, FR-10, FR-12): чистые функции без sdk — гоняются в node --test.
// Запись в users.interests_text и sources — только store.js, и только после кнопки.

export const PROFILE_LIMIT = 4000;
const MAX_TERMS = 3;

/** Ключ fsm для интересов: отдельный от ожидания ссылки (`await_source`), иначе предложение
 * интереса затирает ожидание ссылки и следующее сообщение с ссылкой уходит в LLM. */
export const interestFsmKey = (chatId) => `interest:${chatId}`;

/** Общие слова, которые ничего не значат как интерес: такой «термин» только шумит. */
const GENERIC = new Set([
  'новости',
  'новость',
  'новостей',
  'технологии',
  'технология',
  'технологий',
  'рынок',
  'рынка',
  'мир',
  'все',
  'разное',
  'интересно',
  'новое',
  'всякое',
]);

// «новостями», «технологиях» — те же общие слова в другой форме.
const isGeneric = (term) => GENERIC.has(term) || /^(новост|технолог|мир|рынок)/.test(term);

export function normalizeTerm(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Профиль из интервью — абзац с запятыми и скобками, а не «термин в строке».
 * Режем по запятым/точкам с запятой/буллетам ВНЕ скобок: иначе «(Au, Pt, Pd)» рвётся.
 */
function segmentRanges(text) {
  const source = String(text ?? '');
  const ranges = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ',' || char === ';' || char === '•' || char === '|' || char === '\n')) {
      ranges.push({ start, end: index, sep: char });
      start = index + 1;
    }
  }
  ranges.push({ start, end: source.length, sep: '' });
  return ranges;
}

function splitSegments(text) {
  return segmentRanges(text).map(({ start, end }) => String(text).slice(start, end).trim()).filter(Boolean);
}

/** Профиль — термины интересов: пустые и короткие не считаются, дубли схлопываются. */
export function parseInterests(text) {
  const terms = [];
  for (const raw of splitSegments(text)) {
    const term = normalizeTerm(raw);
    if (!term || term.length < 3) continue;
    if (terms.some((line) => normalizeTerm(line) === term)) continue;
    terms.push(raw);
  }
  return terms;
}

/** Сам термин или его вхождение уже есть в профиле (FR-10). */
function isExisting(lines, term) {
  return lines.some((line) => {
    const source = normalizeTerm(line);
    return source.includes(term) || term.includes(source);
  });
}

/**
 * Дописать термины в конец профиля, по одному в строке (FR-5).
 * При переполнении 4000 символов запись не выполняется вовсе: профиль возвращается как был.
 * Молчаливого усечения нет: больше трёх новых терминов — отказ с причиной (FR-12).
 */
export function addInterestTerms(text, terms) {
  // Хвостовая точка/запятая от абзаца не должна склеиваться с новым термином («кратко., кобальт»).
  const base = String(text ?? '').trim().replace(/[.,;\s]+$/, '');
  const lines = parseInterests(base);
  const existing = [];
  const fresh = [];
  for (const raw of terms ?? []) {
    const term = normalizeTerm(raw);
    if (!term) continue;
    if (isExisting(lines, term) || fresh.includes(term)) {
      existing.push(term);
      continue;
    }
    fresh.push(term);
  }
  if (fresh.length > MAX_TERMS) {
    return { ok: false, text: base, added: [], existing, reason: `за раз — не больше ${MAX_TERMS} интересов (пришло ${fresh.length}) — уточни, что добавить` };
  }
  // ponytail: профиль пишется нормализованно («термин, термин»), а не абзацем.
  const next = [...lines, ...fresh].join(', ');
  if (next.length > PROFILE_LIMIT) {
    return { ok: false, text: base, added: [], existing: [...existing, ...fresh], reason: `профиль заполнен — сначала убери что-нибудь (лимит ${PROFILE_LIMIT} символов)` };
  }
  return { ok: true, text: next, added: fresh, existing };
}

/**
 * Строки профиля, похожие на термин (FR-6). Падежи и словоформы — по общему префиксу:
 * «робототехнику» находит «робототехника», «ставк» — и «ставка фрс», и «ставки по ипотеке».
 * ponytail: морфология префиксная (1–2 буквы окончания), без словаря и лемматизации;
 * усложнять — если на живом чате появятся промахи, которые не закрываются префиксом.
 */
export function matchInterestTerms(text, target) {
  const wanted = normalizeTerm(target);
  if (!wanted) return [];
  return parseInterests(text).filter((line) => termsMatch(line, wanted));
}

function termsMatch(line, wanted) {
  const source = normalizeTerm(line);
  if (source === wanted || source.includes(wanted)) return true;
  const lineWords = source.split(' ');
  const wantedWords = wanted.split(' ').filter((word) => word.length >= 3);
  if (!wantedWords.length) return false; // «ai» — не повод удалить всё подряд
  return wantedWords.every((word) => lineWords.some((lineWord) => wordsMatch(lineWord, word)));
}

function wordsMatch(a, b) {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 4) return a.startsWith(b) || b.startsWith(a);
  let prefix = 0;
  while (prefix < min && a[prefix] === b[prefix]) prefix += 1;
  return prefix >= min - 2;
}

/** Термин назван в профиле целиком, как слово («золото» в «золото физическое»), а не
 * обрывком по префиксу («ставк» в «ставка фрс»): обрывок — повод для кнопок, целое слово — нет (P2-7). */
export function containsWholeWords(text, target) {
  const words = normalizeTerm(text).split(' ').filter(Boolean);
  const wanted = normalizeTerm(target).split(' ').filter(Boolean);
  return wanted.length > 0 && wanted.every((word) => words.includes(word));
}

/** Степень проработки темы в профиле («глубоко», «очень кратко») — подпись, а не интерес:
 * без этой проверки после удаления термина она становилась новым интересом (P2-6). */
const DEGREE = /^(?:(?:очень|максимально|крайне|совсем)\s+)?(?:кратко|коротко|глубоко|детально|подробно)$/;

/** Разделители терминов внутри строки профиля: «золото, платина», «палладий — глубоко». */
const TERM_SEPARATOR = /(\s*[,;]\s*|\s+[—–-]\s+|\s*\/\s*)/;

/**
 * Удалить интерес из профиля (FR-6). Профиль из интервью — структурированный текст
 * («Драгметаллы: золото, платина, палладий — глубоко»), поэтому убирается только сам термин:
 * соседние термины, подпись строки и остальные строки остаются. Нет совпадения — профиль байт-в-байт.
 * all — убрать все вхождения термина («убери золото» текстом, P2-7); выбор кнопкой указывает
 * на конкретную строку профиля, поэтому там удаляется только первое совпадение.
 */
export function removeInterestTerm(text, target, all = false) {
  const base = String(text ?? '').trim();
  const wanted = normalizeTerm(target);
  if (!wanted) return { text: base, removed: null };
  let terms = parseInterests(base);
  const removed = [];
  for (;;) {
    const index = terms.findIndex((term) => termsMatch(term, wanted));
    if (index < 0) break;
    const term = terms[index];
    // Выбор из кнопок приходит целым термином — тогда убирается он; иначе режем слово
    // внутри термина, сохраняя соседей («убери робототехнику» из «индустриальная робототехника»).
    const cut = normalizeTerm(term) === wanted ? { text: '', removed: term } : cutTermFromLine(term, wanted);
    if (!cut.removed) break;
    removed.push(cut.removed);
    // ponytail: профиль после правки нормализуется в «термин, термин» вместо сохранения
    // исходного абзаца; когда понадобится дословная вёрстка профиля — хранить термины списком.
    terms = terms.filter((_, i) => i !== index);
    const rest = cut.text.trim();
    if (rest.length >= 3 && !DEGREE.test(normalizeTerm(rest))) terms.splice(index, 0, rest);
    if (!all) break;
  }
  if (!removed.length) return { text: base, removed: null };
  return { text: terms.join(', '), removed: [...new Set(removed)].join(', ') };
}

/** Вырезать термин из строки профиля. Подпись блока («Драгметаллы:») — имя категории:
 * она остаётся, когда убирают термин, а если совпала сама подпись — блок убирается целиком.
 * Чанк без подписи — это один интерес («ставка фрс»): совпадение убирает его целиком, а не
 * оставляет от него «фрс». */
function cutTermFromLine(line, wanted) {
  const wantedWords = wanted.split(' ').filter(Boolean);
  // Короткие слова в составе термина значимы («physical ai»), но «ai» само по себе — нет.
  if (!wantedWords.some((word) => word.length >= 3)) return { text: line, removed: '' };
  const chunks = line.split(TERM_SEPARATOR); // чётные — текст, нечётные — разделитель
  const kept = [];
  const removed = [];
  for (let i = 0; i < chunks.length; i += 2) {
    const raw = chunks[i];
    const sepBefore = i > 0 ? chunks[i - 1] : '';
    const words = raw.trim().split(/\s+/).filter(Boolean);
    const labelEnd = words.findIndex((word) => /:$/.test(word));
    const label = labelEnd < 0 ? [] : words.slice(0, labelEnd + 1);
    const content = labelEnd < 0 ? words : words.slice(labelEnd + 1);
    const hits = termHits(content, wantedWords);
    // Совпадение в подписи больше не сносит весь кусок («Кратко:» уносило с собой
    // соседний «Physical AI»): подпись чистится как обычные слова.
    const labelHits = label.length ? termHits(label, wantedWords) : [];
    if (!hits.length && !labelHits.length) {
      kept.push({ text: raw, sepBefore });
      continue;
    }
    removed.push(...hits, ...labelHits);
    const rest = [...label.filter((word) => !labelHits.includes(word)), ...content.filter((word) => !hits.includes(word))].join(' ');
    if (rest) kept.push({ text: rest, sepBefore });
  }
  if (!removed.length) return { text: line, removed: '' };
  let result = '';
  for (const chunk of kept) {
    const text = chunk.text.trim();
    if (!text) continue;
    // После подписи идёт пробел, а не запятая: «Драгметаллы: платина, палладий».
    if (!result) result = text;
    else result += /[:—–-]$/.test(result) ? ` ${text}` : `${chunk.sepBefore || ' '}${text}`;
  }
  // «Драгметаллы:» без содержимого — это ещё подпись соседей, её не выбрасываем.
  return { text: result, removed: removed.map((word) => word.replace(/:+$/, '')).join(' ') };
}

/** Слова чанка, совпавшие с термином: однословный — по словам, многословный — только целиком. */
function termHits(words, wantedWords) {
  const normalized = words.map((word) => normalizeTerm(word));
  if (wantedWords.length === 1) return words.filter((word, index) => wordsMatch(normalized[index], wantedWords[0]));
  const found = wantedWords.every((wantedWord) => normalized.some((word) => wordsMatch(word, wantedWord)));
  return found ? words : [];
}

/** Источник интереса — Google News RSS по термину (FR-8). Конструктора URL в изоляте нет. */
export function googleNewsUrl(term) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(normalizeTerm(term))}&hl=ru&gl=RU&ceid=RU:ru`;
}

export function interestSourceTitle(term) {
  return `Google News: ${term}`;
}

/** Фрагмент профиля → термины для поиска источников: строка интервью — это несколько тем. */
function termParts(fragment) {
  return String(fragment ?? '')
    .split(/[,;:/]|\s+[—–-]\s+/)
    .map((part) => normalizeTerm(part))
    .filter((term) => term.length >= 3);
}

/** Ответ LLM → термины как есть (нормализованные): отбор и лимит — clarifyTerms (FR-12). */
export function parseTermList(raw) {
  const source = String(raw ?? '').trim();
  if (!source) return [];
  const json = source.match(/\[[\s\S]*\]/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      if (Array.isArray(parsed)) return uniqueTerms(parsed);
    } catch {
      // не JSON — ниже попробуем разобрать как список
    }
  }
  if (!/[,;\n]/.test(source)) return [];
  return uniqueTerms(source.split(/[,;\n]+/));
}

/** Уникальные нормализованные строки без отбора: отбор — задача clarifyTerms. */
function uniqueTerms(items) {
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const term = normalizeTerm(item.replace(/^["'[\]\s]+|["'[\]\s]+$/g, ''));
    if (!term || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

/**
 * FR-12: неоднозначный запрос — переспрос вариантами, запись не выполняется.
 * Общие слова («новости», «технологии»), термины короче 3 символов и больше трёх тем
 * здесь отсеиваются явно, а не молча.
 * @returns {{ok:boolean, terms:string[], rejected:string[], problems:string[]}}
 */
export function clarifyTerms(items) {
  const all = uniqueTerms(items ?? []);
  const rejected = all.filter((term) => term.length < 3 || isGeneric(term));
  const terms = all.filter((term) => !rejected.includes(term));
  const problems = [];
  if (rejected.length) problems.push(`не подходит как интерес: ${rejected.join(', ')}`);
  if (terms.length > MAX_TERMS) problems.push(`больше трёх тем (${terms.length}) — за раз беру не больше ${MAX_TERMS}`);
  return { ok: !problems.length, terms, rejected, problems };
}

/** Детерминированный фолбэк, когда LLM недоступна (FR-5): фразы после маркера, как есть.
 * Общие слова не выкидываются здесь — их назовёт clarifyTerms (FR-12: переспрос). */
export function fallbackTerms(phrase) {
  const text = normalizeTerm(phrase);
  if (!text) return [];
  return uniqueTerms(text.split(/,|;|\/| и /));
}

/** callback_data кнопок интересов (FR-5, FR-6). */
export function parseInterestCallback(data) {
  const match = String(data ?? '').match(/^int:(add|cancel|undo|pick:(\d{1,2}))$/);
  if (!match) return null;
  if (match[1].startsWith('pick:')) return { action: 'pick', index: Number(match[2]) };
  return { action: match[1] };
}

/** topics в БД — JSON-строка; сбой разбора не должен ломать список (FR-7). */
export function parseTopics(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Источники интереса по термину: origin='interest' и термин в topics (FR-6).
 * Термином может быть строка профиля из интервью — тогда совпадает любой термин внутри неё. */
export function interestSourcesFor(term, sources) {
  const wanted = termParts(term);
  if (!wanted.length) return [];
  return (sources ?? []).filter(
    (row) => row.origin === 'interest' && parseTopics(row.topics).some((topic) => wanted.some((part) => termsMatch(topic, part))),
  );
}

/** Для списка интересов: сколько источников по термину и есть ли активный (FR-7). */
export function countInterestSources(terms, sources) {
  const interest = (sources ?? []).filter((row) => row.origin === 'interest');
  return (terms ?? []).map((term) => {
    const matched = interestSourcesFor(term, interest);
    return { term, total: matched.length, active: matched.filter((row) => Number(row.enabled) === 1).length };
  });
}
