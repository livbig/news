import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addInterestTerms,
  clarifyTerms,
  countInterestSources,
  fallbackTerms,
  googleNewsUrl,
  interestFsmKey,
  interestSourceTitle,
  interestSourcesFor,
  matchInterestTerms,
  containsWholeWords,
  normalizeTerm,
  parseInterestCallback,
  parseInterests,
  parseTermList,
  removeInterestTerm,
} from '../../tgcloud/lib/interests.js';

const PROFILE = 'драгметаллы\nробототехника\nставка фрс\nставки по ипотеке';

test('нормализация термина: регистр, ё, лишние пробелы', () => {
  assert.equal(normalizeTerm('  Ёлка   Рынок '), 'елка рынок');
  assert.equal(normalizeTerm(null), '');
});

test('профиль разбирается на строки без пустых', () => {
  assert.deepEqual(parseInterests('\nзолото\n\n  нефть  \n'), ['золото', 'нефть']);
  assert.deepEqual(parseInterests(null), []);
});

test('добавление терминов: запись в конец и нормализованный дедуп', () => {
  const first = addInterestTerms('', ['Physical AI', 'робототехника']);
  assert.equal(first.ok, true);
  assert.deepEqual(first.added, ['physical ai', 'робототехника']);
  assert.equal(first.text, 'physical ai, робототехника');

  const again = addInterestTerms(first.text, ['Робототехника', 'physical  ai']);
  assert.equal(again.ok, true);
  assert.deepEqual(again.added, [], 'повтор ничего не дописывает');
  assert.deepEqual(again.existing, ['робототехника', 'physical ai']);
  assert.equal(again.text, first.text, 'профиль байт-в-байт тот же');
});

test('лимит профиля 4000 символов: отказ и запись не выполняется', () => {
  const full = 'я'.repeat(3990);
  const result = addInterestTerms(full, ['робототехника']);
  assert.equal(result.ok, false);
  assert.equal(result.text, full, 'текст не меняется при отказе');
  assert.match(result.reason, /профиль заполнен/);
});

test('P1-6: больше трёх терминов — отказ и записи нет (молчаливого усечения нет)', () => {
  const result = addInterestTerms('', ['a1b', 'a2b', 'a3b', 'a4b', 'a5b']);
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.deepEqual(result.added, []);
  assert.match(result.reason, /не больше 3/);
});

test('P1-6: FR-12 — общий/короткий термин и перебор тем требуют переспроса', () => {
  const many = clarifyTerms(['a1b', 'a2b', 'a3b', 'a4b', 'a5b']);
  assert.equal(many.ok, false);
  assert.equal(many.terms.length, 5);
  assert.match(many.problems.join(' '), /больше трёх тем/);

  const generic = clarifyTerms(['новости', 'золото']);
  assert.equal(generic.ok, false);
  assert.deepEqual(generic.rejected, ['новости']);
  assert.deepEqual(generic.terms, ['золото']);

  const short = clarifyTerms(['ai', 'кобальт']);
  assert.equal(short.ok, false);
  assert.deepEqual(short.rejected, ['ai']);

  const fine = clarifyTerms(['золото', 'платина']);
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.terms, ['золото', 'платина']);
});

test('поиск по нормализованному вхождению переживает падеж', () => {
  assert.deepEqual(matchInterestTerms(PROFILE, 'робототехнику'), ['робототехника']);
  assert.deepEqual(matchInterestTerms(PROFILE, 'ставку фрс'), ['ставка фрс']);
  assert.deepEqual(matchInterestTerms(PROFILE, 'криптовалюты'), [], 'чего нет — того нет');
  assert.equal(matchInterestTerms(PROFILE, 'ставк').length, 2, 'неоднозначность — повод уточнить кнопками');
  assert.ok(matchInterestTerms(PROFILE, 'физическое золото').length <= 1);
});

test('удаление строки профиля не трогает соседние', () => {
  const result = removeInterestTerm(PROFILE, 'робототехника');
  assert.ok(!result.text.includes('робототехника'));
  assert.match(result.text, /ставка фрс/);
  assert.equal(removeInterestTerm(PROFILE, 'криптовалюты').text, PROFILE, 'нет термина — профиль тот же');
});

const INTERVIEW = 'Драгметаллы: золото, платина, палладий — глубоко\nAI и робототехника: physical ai, робототехника — глубоко';

test('P1-7: удаление термина из профиля-абзаца не стирает соседние интересы', () => {
  const result = removeInterestTerm(INTERVIEW, 'золото');
  assert.equal(result.removed, 'золото');
  // Контракт: сохраняется набор интересов, а не дословная вёрстка профиля.
  for (const term of ['Драгметаллы:', 'платина', 'палладий', 'physical ai', 'робототехника']) {
    assert.ok(result.text.includes(term) || result.text.toLowerCase().includes(term), `остался ${term}`);
  }
  assert.ok(!/золот/i.test(result.text), 'золота нет');
  const second = removeInterestTerm(result.text, 'палладий');
  assert.ok(!/паллади/i.test(second.text));
  assert.ok(second.text.includes('платина') && second.text.includes('робототехника'));
  assert.equal(removeInterestTerm(INTERVIEW, 'криптовалюты').text, INTERVIEW, 'нет термина — профиль тот же');
});

test('P1-7: источники ищутся по термину, а не по всей строке профиля', () => {
  const sources = [
    { origin: 'interest', topics: '["золото"]', enabled: 1 },
    { origin: 'interest', topics: '["платина"]', enabled: 1 },
    { origin: 'manual', topics: '[]', enabled: 1 },
  ];
  const { removed } = removeInterestTerm(INTERVIEW, 'золото');
  const matched = interestSourcesFor(removed, sources);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].topics, '["золото"]');
  assert.equal(interestSourcesFor('кобальт', sources).length, 0);
  // Строка профиля в целом = несколько терминов: источники удаляются по каждому.
  assert.equal(interestSourcesFor('Драгметаллы: золото, платина, палладий — глубоко', sources).length, 2);
});

test('P2-5: частичное совпадение подписи не сносит содержимое блока', () => {
  const result = removeInterestTerm('AI и робототехника: новые модели, промпт-инжиниринг', 'робототехнику');
  assert.equal(result.removed, 'робототехника');
  assert.ok(!/робототехник/i.test(result.text), result.text);
  for (const kept of ['новые модели', 'промпт-инжиниринг']) assert.ok(result.text.includes(kept), `остался ${kept}`);
});

test('P2-6: после удаления не остаётся мусорного «интереса» из подписи', () => {
  const result = removeInterestTerm('Крипта — очень кратко', 'крипта');
  assert.equal(result.text, '', 'степень проработки — не интерес');
  assert.equal(result.removed, 'Крипта');
  // у соседей подпись-степень остаётся: она относится к оставшимся терминам
  const shared = removeInterestTerm('Драгметаллы: золото, платина — глубоко', 'золото');
  assert.match(shared.text, /платина/);
  assert.match(shared.text, /глубоко/);
});

test('P2-7: термин в нескольких местах профиля убирается сразу', () => {
  const result = removeInterestTerm('золото\nзолото физическое', 'золото', true);
  assert.ok(!/золот/i.test(result.text), result.text);
  assert.equal(result.removed, 'золото');
  // выбор кнопкой указывает на конкретную строку — остальные вхождения не трогаем
  const picked = removeInterestTerm('золото\nзолото физическое', 'золото');
  assert.ok(/золот/i.test(picked.text));
});

test('P2-7: цель названа целым словом — уточнять кнопками нечего', () => {
  assert.equal(containsWholeWords('золото физическое', 'золото'), true);
  assert.equal(containsWholeWords('золото физическое', 'физическое золото'), true);
  assert.equal(containsWholeWords('ставка фрс', 'ставк'), false, 'обрывок — неоднозначность');
  assert.equal(containsWholeWords('робототехника — глубоко', 'робототехнику'), false, 'падеж — кнопки как раньше');
});

test('P2: отдельный ключ fsm для интересов — не затирает ожидание ссылки', () => {
  assert.notEqual(interestFsmKey(42), '42');
  assert.equal(interestFsmKey(42), interestFsmKey('42'));
});

test('URL Google News собирается через encodeURIComponent и не содержит конструктора URL', () => {
  const url = googleNewsUrl('physical ai & робототехника');
  assert.ok(url.startsWith('https://news.google.com/rss/search?q='));
  assert.ok(url.includes('physical%20ai%20%26%20%D1%80%D0%BE%D0%B1%D0%BE%D1%82%D0%BE%D1%82%D0%B5%D1%85%D0%BD%D0%B8%D0%BA%D0%B0'));
  assert.ok(url.endsWith('&hl=ru&gl=RU&ceid=RU:ru'));
  assert.equal(interestSourceTitle('Физика'), 'Google News: Физика');
});

test('ответ LLM разбирается как JSON-массив и как список; отбор — в clarifyTerms', () => {
  assert.deepEqual(parseTermList('```json\n["Physical AI", "робототехника"]\n```'), ['physical ai', 'робототехника']);
  assert.deepEqual(parseTermList('["новости", "ai", "кобальт", "литий", "медь"]'), ['новости', 'ai', 'кобальт', 'литий', 'медь']);
  assert.deepEqual(parseTermList('не понял запрос'), []);
  assert.deepEqual(parseTermList(null), []);
  const check = clarifyTerms(parseTermList('["новости", "ai", "кобальт", "литий", "медь"]'));
  assert.equal(check.ok, false);
  assert.deepEqual(check.rejected, ['новости', 'ai']);
});

test('фолбэк без LLM: слова после маркера как есть, отбор — в clarifyTerms', () => {
  assert.deepEqual(fallbackTerms('physical ai и робототехнику'), ['physical ai', 'робототехнику']);
  assert.deepEqual(fallbackTerms('золото, серебро, платина, палладий'), ['золото', 'серебро', 'платина', 'палладий']);
  assert.equal(clarifyTerms(fallbackTerms('технологии')).ok, false, 'общее слово — повод переспросить');
  assert.equal(clarifyTerms(fallbackTerms('технологиях')).ok, false, 'общее слово в любой форме');
  assert.equal(clarifyTerms(fallbackTerms('золото, серебро, платина, палладий')).ok, false, 'четыре термина');
  assert.deepEqual(fallbackTerms(''), []);
});

test('callback_data интересов: add/cancel/undo/pick, чужие — null', () => {
  assert.deepEqual(parseInterestCallback('int:add'), { action: 'add' });
  assert.deepEqual(parseInterestCallback('int:cancel'), { action: 'cancel' });
  assert.deepEqual(parseInterestCallback('int:undo'), { action: 'undo' });
  assert.deepEqual(parseInterestCallback('int:pick:2'), { action: 'pick', index: 2 });
  assert.equal(parseInterestCallback('src:add'), null);
  assert.equal(parseInterestCallback('int:add:1'), null);
});

test('источники по интересам считаются по темам', () => {
  const sources = [
    { origin: 'interest', topics: '["робототехника"]', enabled: 1 },
    { origin: 'interest', topics: '["робототехника"]', enabled: 0 },
    { origin: 'manual', topics: '["робототехника"]', enabled: 1 },
  ];
  assert.deepEqual(countInterestSources(['робототехника', 'золото'], sources), [
    { term: 'робототехника', total: 2, active: 1 },
    { term: 'золото', total: 0, active: 0 },
  ]);
});
