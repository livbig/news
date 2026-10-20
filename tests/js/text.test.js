import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chunkMessage, escapeHtml, normalizeLlmText, normalizeTitle, urlHash } from '../../tgcloud/lib/text.js';

test('escapeHtml закрывает только & < >', () => {
  assert.equal(escapeHtml('a & b <c> "d"'), 'a &amp; b &lt;c&gt; "d"');
});

test('normalizeLlmText убирает <br> и буллеты', () => {
  assert.equal(normalizeLlmText('• один<br>два'), 'один\nдва');
});

test('normalizeTitle не зависит от регистра и пунктуации', () => {
  // ё не схлопывается в е — как в Python-версии (_TITLE_NORM): иначе «растёт» и «растет» станут одним ключом
  assert.equal(normalizeTitle('Золото — РАСТЁТ, 3%!'), 'золото растёт 3');
  assert.notEqual(normalizeTitle('растёт'), normalizeTitle('растет'));
});

test('urlHash совпадает с формулой Python-версии', async () => {
  const expected = createHash('sha256').update('https://ex.com/a|золото растёт').digest('hex');
  assert.equal(await urlHash('https://ex.com/a?utm=1', 'Золото  растёт'), await urlHash('https://ex.com/a', 'золото растёт'));
  assert.equal(await urlHash('https://ex.com/a', 'Золото растёт'), expected);
});

test('chunkMessage не превышает лимит и всё сохраняет', () => {
  const text = Array.from({ length: 60 }, (_, i) => `Пункт ${i}: ${'слово '.repeat(30)}`).join('\n\n');
  const chunks = chunkMessage(text, 1000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 1000, `кусок ${chunk.length}`);
  assert.equal(chunks.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

test('chunkMessage не рвёт тег и entity', () => {
  const text = `${'a'.repeat(900)}<a href="https://example.com/x">эмодзи</a>${'&amp;'.repeat(50)}`;
  for (const chunk of chunkMessage(text, 1000)) {
    assert.equal((chunk.match(/</g) ?? []).length, (chunk.match(/>/g) ?? []).length, `сломан тег: ${chunk.slice(-40)}`);
    assert.ok(!/&\w*$/.test(chunk), 'оборванная entity');
  }
});
