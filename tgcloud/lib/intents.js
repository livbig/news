// Интент-роутер (R1): смысл сообщения решает детерминированный код, LLM — только
// когда текст не разобран. Никаких «правильных формулировок»: «ну как там» = сводка.

const COMMANDS = ['start', 'digest', 'stats', 'sources', 'settings', 'help', 'stop'];

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

/** Уточнение темы: «сводка по золоту» / «что по ставке» — это вопрос, не сводка. */
const TOPIC_MARKER = /^(по|об|о|про|насчёт|насчет|касательно)\s+/;

/** Окно в самом сообщении: «сводка за неделю», «новости с понедельника». */
const WINDOW_MARKER = /^(за|с)\s+\S+.*$/;

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
 *          |{kind:'digest', windowHint:string|null, text:string}
 *          |{kind:'ask', text:string}}
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

  const hit = DIGEST_PATTERNS.find((re) => re.test(norm));
  if (!hit) return { kind: 'ask', text: raw };

  // Отрезаем ЦЕЛОЕ слово-триггер (иначе от «сводка» остаётся «а») и смотрим, что
  // осталось: «за неделю» — то же окно, «по золоту» — уже вопрос по теме (R3).
  const match = norm.match(hit);
  const rest = removeWord(norm, match.index, match[0].length).replace(/\s+/g, ' ').trim();
  if (!rest) return { kind: 'digest', windowHint: null, text: raw };
  if (TOPIC_MARKER.test(rest)) return { kind: 'ask', text: raw };
  if (WINDOW_MARKER.test(rest)) return { kind: 'digest', windowHint: rest, text: raw };
  // «дай сводку пожалуйста», «сводка сейчас»: служебные слова не мешают сводке,
  // а вот «по золоту» после них — уже вопрос по теме.
  const filler = /^(сейчас|пожалуйста|плиз|давай|дай|мне|быстро|кратко|полную|новую|сводку|сводка)\s*/;
  let tail = rest;
  while (filler.test(tail)) tail = tail.replace(filler, '').trim();
  if (!tail) return { kind: 'digest', windowHint: null, text: raw };
  if (TOPIC_MARKER.test(tail)) return { kind: 'ask', text: raw };
  return { kind: 'digest', windowHint: null, text: raw };
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
