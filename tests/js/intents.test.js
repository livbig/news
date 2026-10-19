import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../../tgcloud/lib/intents.js';

const digest = (text) => assert.equal(route(text).kind, 'digest', text);
const ask = (text) => assert.equal(route(text).kind, 'ask', text);

test('сводку просят любыми словами', () => {
  for (const text of ['сводка', 'Сводку!', 'ну как там', 'что нового', 'дайджест', 'дай новости', 'как дела', 'новости', 'что слышно', 'дай сводку пожалуйста', 'сводка сейчас']) digest(text);
});

test('уточнение темы после слова «сводка» — это вопрос, а не сводка', () => {
  for (const text of ['сводка по золоту', 'сводка про IPO', 'новости о ставке ФРС']) ask(text);
});

test('окно в сообщении не ломает сводку', () => {
  const result = route('сводка за неделю');
  assert.equal(result.kind, 'digest');
  assert.equal(result.windowHint, 'за неделю');
});

test('вопросы по темам и свободный текст уходят в диалог', () => {
  for (const text of ['а что с IPO?', 'почему упал доллар', 'подробнее про второй пункт', 'привет']) ask(text);
});

test('команды распознаются, мусор — нет', () => {
  assert.deepEqual(route('/digest').kind, 'command');
  assert.equal(route('/digest@examplebot').command, 'digest');
  assert.equal(route('/sources').command, 'sources');
  assert.equal(route('/unknown').kind, 'ask');
});
