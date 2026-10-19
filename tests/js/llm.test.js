import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSseEvents, reduceSse, toMessages } from '../../tgcloud/lib/llm-core.js';

test('история из БД превращается в сообщения anthropic', () => {
  const messages = toMessages([{ role: 'user', text: 'привет' }, { role: 'assistant', text: 'ответ' }], 'а что по золоту?');
  assert.deepEqual(messages, [
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'ответ' },
    { role: 'user', content: 'а что по золоту?' },
  ]);
});

test('подряд идущие роли склеиваются, ведущий assistant отбрасывается', () => {
  const messages = toMessages([{ role: 'assistant', text: 'старое' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' }], 'вопрос');
  assert.deepEqual(messages, [{ role: 'user', content: 'a\nb' }, { role: 'user', content: 'вопрос' }]);
});

test('SSE разбирается, текст и stop_reason собираются', () => {
  const raw = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Привет"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n';
  const events = collectSseEvents(raw);
  assert.deepEqual(reduceSse(events), { text: 'Привет', stopReason: 'end_turn', usage: { output_tokens: 5 } });
});

test('битая строка SSE не роняет разбор', () => {
  assert.equal(reduceSse(collectSseEvents('data: {oops\n')).text, '');
});
