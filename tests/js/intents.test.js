import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../../tgcloud/lib/intents.js';
import { parsePeriod } from '../../tgcloud/lib/digest.js';

const digest = (text) => assert.equal(route(text).kind, 'digest', text);
const ask = (text) => assert.equal(route(text).kind, 'ask', text);

test('сводку просят любыми словами', () => {
  for (const text of ['сводка', 'Сводку!', 'ну как там', 'что нового', 'дайджест', 'дай новости', 'как дела', 'новости', 'что слышно', 'дай сводку пожалуйста', 'сводка сейчас']) digest(text);
});

test('уточнение темы после слова «сводка» — это вопрос, а не сводка', () => {
  for (const text of ['сводка по золоту', 'сводка про IPO', 'новости о ставке ФРС']) ask(text);
});

test('тема приоритетнее периода: «сводка по золоту за неделю» — вопрос', () => {
  for (const text of ['сводка по золоту за неделю', 'новости про ставку за 3 дня']) ask(text);
});

test('P1-1: тема в любом месте хвоста приоритетнее периода', () => {
  for (const text of ['сводка за неделю по золоту', 'сводка за 3 дня про ставку', 'новости за месяц о ФРС', 'а что по золоту за неделю']) {
    ask(text);
  }
});

test('P1-2: пунктуация не убивает период в фразе без слова-триггера', () => {
  const cases = ['а что было вчера?', 'с 1 октября?', 'что было с понедельника?', 'за 3 дня.', 'за 3 дня,'];
  for (const text of cases) {
    const intent = route(text);
    assert.equal(intent.kind, 'digest', text);
    assert.ok(intent.periodHint, text);
  }
});

test('P2-2: пунктуация внутри фразы — период находится и уходит в интент', () => {
  for (const text of ['за 3 дня, пожалуйста', 'дай новости за 3 дня, пожалуйста', 'сводка (за 3 дня)', 'за 3 дня!']) {
    const intent = route(text);
    assert.equal(intent.kind, 'digest', text);
    assert.ok(parsePeriod(intent.periodHint), text);
  }
});

test('P1-3: период раньше интересов — «интересно, что там за неделю» это сводка', () => {
  const intent = route('интересно, что там за неделю');
  assert.equal(intent.kind, 'digest');
  assert.equal(intent.periodHint, 'интересно, что там за неделю');
});

test('P1-5: период из вопроса по теме уходит в контекст ответа', () => {
  const intent = route('сводка по золоту за неделю');
  assert.equal(intent.kind, 'ask');
  assert.equal(intent.periodHint, 'сводка по золоту за неделю');
  assert.equal(route('а что по золоту').periodHint, null, 'без периода окно по умолчанию');
});

test('P2: «отмени»/«отмена» текстом — отмена предложения интереса (U8)', () => {
  for (const text of ['отмени', 'Отмена', 'отменить']) {
    const intent = route(text);
    assert.equal(intent.kind, 'interests', text);
    assert.equal(intent.action, 'cancel', text);
  }
});

test('период из текста уходит в интент сводки, а не теряется', () => {
  const cases = ['сводка за неделю', 'какие новости за 3 дня', 'а что было вчера', 'новости с понедельника'];
  for (const text of cases) {
    const intent = route(text);
    assert.equal(intent.kind, 'digest', text);
    assert.ok(intent.periodHint, text);
    assert.ok(parsePeriod(intent.periodHint), `период разбирается: ${text} → ${intent.periodHint}`);
  }
});

test('период с датой: точки и дефисы не теряются при роутинге', () => {
  for (const text of ['сводка с 03.10', 'новости с 1 по 5 октября', 'ну как там с 16 октября']) {
    const intent = route(text);
    assert.equal(intent.kind, 'digest', text);
    assert.ok(parsePeriod(intent.periodHint), text);
  }
});

test('сводка без периода — periodHint пуст, окно неявное', () => {
  for (const text of ['сводка', 'дай сводку пожалуйста', 'ну как там']) {
    assert.equal(route(text).periodHint, null, text);
  }
});

test('добавление интереса: триггеры FR-5 и термин после них', () => {
  const cases = [
    ['добавь в интересы кобальт', 'кобальт'],
    ['мне интересно было бы углубиться в physical ai и робототехнику', 'physical ai и робототехнику'],
    ['хочу больше про ставку ФРС', 'ставку фрс'],
    ['следи за ценами на литий', 'ценами на литий'],
  ];
  for (const [text, target] of cases) {
    const intent = route(text);
    assert.equal(intent.kind, 'interests', text);
    assert.equal(intent.action, 'add', text);
    assert.equal(intent.target, target, text);
  }
});

test('удаление интереса: триггеры FR-6, «убери новости» не уходит в сводку', () => {
  const cases = [
    ['убери робототехнику', 'робототехнику'],
    ['удали из интересов физическое золото', 'физическое золото'],
    ['больше не интересно крипта', 'крипта'],
    ['убери новости', 'новости'],
  ];
  for (const [text, target] of cases) {
    const intent = route(text);
    assert.equal(intent.kind, 'interests', text);
    assert.equal(intent.action, 'remove', text);
    assert.equal(intent.target, target, text);
  }
});

test('просмотр интересов — без изменений БД и без LLM', () => {
  for (const text of ['покажи мои интересы', 'покажи интересы', 'что у меня в интересах', 'мои интересы']) {
    const intent = route(text);
    assert.equal(intent.kind, 'interests', text);
    assert.equal(intent.action, 'list', text);
  }
});

test('вопросы по темам и свободный текст уходят в диалог', () => {
  for (const text of ['а что с IPO?', 'почему упал доллар', 'подробнее про второй пункт', 'привет']) ask(text);
});

test('команды распознаются, мусор — нет', () => {
  assert.deepEqual(route('/digest').kind, 'command');
  assert.equal(route('/digest@examplebot').command, 'digest');
  assert.equal(route('/sources').command, 'sources');
  assert.equal(route('/interests').command, 'interests');
  assert.equal(route('/unknown').kind, 'ask');
});

test('интересы приоритетнее периода (решение владельца 2026-10-19)', () => {
  assert.equal(route('за неделю убери робототехнику').action, 'remove');
  assert.equal(route('покажи интересы за неделю').action, 'list');
  // «интересно, что…» — вопрос по теме, а не новый термин
  assert.equal(route('интересно, что по золоту').kind, 'ask');
  // период внутри фразы про интерес — всё равно сводка
  assert.equal(route('интересно, что там за неделю').kind, 'digest');
});
