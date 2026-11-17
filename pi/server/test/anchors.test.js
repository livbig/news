// Ссылки перед отправкой: только href, без него — разворачиваем. Иначе Telegram рвёт кусок.

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { repairAnchors } = await import('../src/text.js');

test('repairAnchors: кривой атрибут выбрасывается, href остаётся', () => {
  assert.equal(repairAnchors('<a href="https://a.b" target=x>метка</a>'), '<a href="https://a.b">метка</a>');
  assert.equal(repairAnchors('<a href=https://a.b>метка</a>'), '<a href="https://a.b">метка</a>');
  assert.equal(repairAnchors("<a href='https://a.b' rel>метка</a>"), '<a href="https://a.b">метка</a>');
});

test('repairAnchors: ссылка без href разворачивается в текст', () => {
  assert.equal(repairAnchors('<a name="x">метка</a>'), 'метка');
  assert.equal(repairAnchors('<a href="">метка</a>'), 'метка');
});

test('repairAnchors: висячий тег без пары срезается, текст цел', () => {
  assert.equal(repairAnchors('до <a href="https://a.b"> после'), 'до  после');
});

test('repairAnchors: несколько ссылок и обычные теги не страдают', () => {
  const html = '<b>Заголовок</b>\n<a href="https://a.b/1">🥇</a> текст <a href="https://a.b/2" data-x>два</a> <i>курсив</i>';
  const out = repairAnchors(html);
  assert.match(out, /<a href="https:\/\/a\.b\/1">🥇<\/a>/);
  assert.match(out, /<a href="https:\/\/a\.b\/2">два<\/a>/);
  assert.match(out, /<b>Заголовок<\/b>/);
  assert.match(out, /<i>курсив<\/i>/);
});
