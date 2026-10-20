// Интент-роутер (R1): смысл сообщения решает детерминированный код, LLM — только
// когда текст не разобран. Никаких «правильных формулировок»: «ну как там» = сводка.

import { parsePeriod } from './digest.js';

const COMMANDS = ['start', 'digest', 'stats', 'sources', 'settings', 'help', 'stop', 'interests'];

// \b в JS не работает для кириллицы (граница слова считается по [A-Za-z0-9_]),
// поэтому шаблоны — обычные подстроки; ложные срабатывания на этих корнях безвредны.
/** «сводка», «дайджест», «что нового», «как там», «дай новости», «обзор»… */
const DIGEST_PATTERNS = [
  /сводк/,
  /дайджест/,
  /новост/,
  /новенько/,
  /что нового/,
  /что слышно/,
  /как (там|дела|оно|у нас)/,
  /ну как/,
  /обзор/,
  /доклад/,
];

/** Уточнение темы: «сводка по золоту» / «что по ставке» — это вопрос, не сводка.
 * Ищется в любом месте хвоста (FR-4: тема приоритетнее периода), но цифра после маркера —
 * это уже диапазон дат («с 1 по 5 октября»), а не тема.*/
const TOPIC_MARKER = /(?:^|\s)(?:по|об|о|про|насчёт|насчет|касательно)\s+(?!\d)/;

// --- интересы (FR-5, FR-6, FR-7) --------------------------------------------------
// Проверяются раньше DIGEST_PATTERNS: иначе «убери новости» уходит в сводку.

const INTEREST_LIST = [/покаж[а-я]*\s+.*интерес/, /(^|\s)мои интересы/, /что у меня в интерес/, /список интерес/, /какие (у меня )?интересы/];

const INTEREST_REMOVE = [/(^|\s)(убери|удали|убрать|удалить)(\s|$)/, /из интересов/, /больше не интересно/];

/** Текстом — то же, что кнопка «❌ Отмена» (U8): профиль не меняется, предложение снимается. */
const INTEREST_CANCEL = /^(отмени|отмена|отменить)$/;

const INTEREST_ADD = [
  /добав[а-я]*\s+(в\s+)?интерес[а-я]*/,
  /добав[а-я]*\s+тему/,
  /(^|\s)интересно(\s|$)/,
  /углубиться/,
  /хочу больше\s+(про|об|о|по)/,
  /следи(ть)?\s+за/,
  /слежу за/,
];

/** Служебные слова перед термином: «мне интересно было бы углубиться в …». */
const LEAD_FILLER = /^(мне|бы|было|интересно|хочу|больше|про|об|о|по|в|во|на|за|из|следить|следи|слежу|углубиться|добавь|добавить|интерес[а-я]*|тему|тема|это)\s+/;

const CLEAN = /[^\p{L}\p{N}\s/]+/gu;

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(CLEAN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @returns {{kind:'command', command:string, args:string}
 *          |{kind:'digest', periodHint:string|null, text:string}
 *          |{kind:'interests', action:'add'|'remove'|'list'|'cancel', target:string, text:string}
 *          |{kind:'ask', periodHint?:string|null, text:string}}
 */
export function route(text) {
  const raw = String(text ?? '').trim();
  if (raw.startsWith('/')) {
    const [head, ...rest] = raw.split(/\s+/);
    const command = normalize(head.slice(1).split('@')[0]);
    if (COMMANDS.includes(command)) {
      return { kind: 'command', command, args: rest.join(' ').trim() };
    }
    return { kind: 'ask', text: raw };
  }
  const norm = normalize(raw);
  if (!norm) return { kind: 'ask', text: raw };
  // Период ищется и в тексте с пунктуацией: normalize() съедает точки и дефисы дат («с 03.10»).
  const plain = raw.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const periodHint = parsePeriod(plain) ? plain : null;

  // Решение владельца 2026-10-19: действие с интересами приоритетнее периода —
  // «за неделю убери робототехнику» убирает интерес, а не собирает сводку.
  const interests = routeInterests(norm);
  if (interests) {
    // Но если в цели действия сам период («интересно, что там за неделю»), это
    // сводка: период решает, а мусорный термин в профиль не попадает (FR-12).
    const target = interests.target ?? '';
    const targetIsPeriod = Boolean(target) && Boolean(parsePeriod(target));
    // «интересно, что по золоту» — это вопрос по теме, а не новый термин.
    const questionLike = /^(что|как|где|почему|зачем|когда|кто|сколько)\s/.test(target);
    const noTarget = (interests.action === 'add' || interests.action === 'remove') && (!target || questionLike);
    if (!targetIsPeriod && !noTarget) return { ...interests, text: raw };
  }

  // FR-4: период раньше слово-триггера сводки; тема приоритетнее периода:
  // «сводка по золоту за неделю» — вопрос по ленте, период уходит в контекст ответа.
  if (periodHint) {
    if (TOPIC_MARKER.test(plain)) return { kind: 'ask', text: raw, periodHint };
    return { kind: 'digest', periodHint, text: raw };
  }

  const hit = DIGEST_PATTERNS.find((re) => re.test(norm));
  if (hit) {
    // Отрезаем ЦЕЛОЕ слово-триггер (иначе от «сводка» остаётся «а») и смотрим, что
    // осталось: «по золоту» — уже вопрос по теме (R3).
    const match = norm.match(hit);
    const rest = removeWord(norm, match.index, match[0].length).replace(/\s+/g, ' ').trim();
    if (TOPIC_MARKER.test(rest)) return { kind: 'ask', text: raw, periodHint: null };
    return { kind: 'digest', periodHint: null, text: raw };
  }

  return { kind: 'ask', text: raw, periodHint: null };
}

/** Интенты интересов: отмена → показ → удаление → добавление (FR-4: без LLM). */
function routeInterests(norm) {
  if (INTEREST_CANCEL.test(norm)) return { kind: 'interests', action: 'cancel', target: '' };
  if (INTEREST_LIST.some((re) => re.test(norm))) return { kind: 'interests', action: 'list', target: '' };
  const remove = INTEREST_REMOVE.find((re) => re.test(norm));
  if (remove) {
    const match = norm.match(remove);
    return { kind: 'interests', action: 'remove', target: interestTarget(norm.slice(match.index + match[0].length)) };
  }
  const add = INTEREST_ADD.find((re) => re.test(norm));
  if (add) {
    const match = norm.match(add);
    return { kind: 'interests', action: 'add', target: interestTarget(norm.slice(match.index + match[0].length)) };
  }
  return null;
}

/** Хвост после триггера без служебных слов: «в интересы кобальт» → «кобальт». */
function interestTarget(tail) {
  let target = String(tail ?? '').replace(/\s+/g, ' ').trim();
  while (LEAD_FILLER.test(target)) target = target.replace(LEAD_FILLER, '').trim();
  return target.replace(/\s*из интересов$/, '').trim();
}

/** Вырезать слово (или группу слов) вокруг совпадения, не оставляя обрубков. */
function removeWord(text, index, length) {
  const from = text.lastIndexOf(' ', index) + 1;
  const nextSpace = text.indexOf(' ', index + length);
  const to = nextSpace === -1 ? text.length : nextSpace;
  return `${text.slice(0, from)} ${text.slice(to)}`;
}

/** Команда = сводка по запросу (FR-19): /digest и /start после онбординга ведут туда же. */
export function isDigestCommand(command) {
  return command === 'digest';
}
