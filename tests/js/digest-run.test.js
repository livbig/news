import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmTruncatedError } from '../../_archive/tgcloud-2026-11-16/tgcloud/lib/llm-core.js';
import { summarizeDigest, summarizeFanout, summarizeSingle } from '../../_archive/tgcloud-2026-11-16/tgcloud/lib/digest-run.js';

const config = { digest: { textCap: 1200 } };
const budget = { thinking: false, fanout: { enabled: true, parts: 2, minItems: 6, maxTokensPerPart: 1000, maxTokensEditor: 500 } };
const caps = { maxTokens: 8000 };
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, sourceId: 1, title: `T${i}`, url: `https://e/${i}`, gist: 'g' }));
const left = () => 20000;
const truncated = (partial) => {
  const error = new LlmTruncatedError('обрезано');
  error.partial = partial;
  return error;
};

test('один вызов: успех возвращает все пункты', async () => {
  const result = await summarizeSingle({ selected: rows(6), interestsText: '', config, budget, caps, left, summarize: async () => 'OK' });
  assert.equal(result.text, 'OK');
  assert.equal(result.items.length, 6);
  assert.equal(result.note, undefined);
});

test('один вызов: длинный partial уходит как сокращённая сводка', async () => {
  const result = await summarizeSingle({
    selected: rows(6), interestsText: '', config, budget, caps, left,
    summarize: async () => { throw truncated('П'.repeat(500)); },
  });
  assert.equal(result.text.length, 500);
  assert.match(result.note, /сокращена/);
});

test('один вызов: короткий partial повторяется с половиной пунктов', async () => {
  let calls = 0;
  const result = await summarizeSingle({
    selected: rows(6), interestsText: '', config, budget, caps, left,
    summarize: async () => {
      calls += 1;
      if (calls === 1) throw truncated('short');
      return 'HALF';
    },
  });
  assert.equal(result.text, 'HALF');
  assert.equal(result.items.length, 5);
  assert.equal(calls, 2);
  assert.match(result.note, /повтор/);
});

test('один вызов: при нехватке времени короткий partial не повторяется', async () => {
  await assert.rejects(
    () => summarizeSingle({
      selected: rows(6), interestsText: '', config, budget, caps, left: () => 1000,
      summarize: async () => { throw truncated('short'); },
    }),
    (error) => error.name === 'LlmTruncatedError',
  );
});

test('веер: две части и общий редактор идут тремя вызовами', async () => {
  const calls = [];
  const result = await summarizeDigest({
    selected: rows(10), interestsText: '', config, budget, caps, left,
    summarize: async (itemsText) => {
      calls.push(itemsText);
      return itemsText.includes('Ниже весь поток') ? 'EDITOR' : 'MAP';
    },
  });
  assert.equal(calls.length, 3);
  assert.ok(result.text.startsWith('EDITOR'));
  assert.equal((result.text.match(/MAP/g) ?? []).length, 2);
  assert.doesNotMatch(result.text, /ЧАСТЬ/);
  assert.equal(result.items.length, 10);
});

test('веер: синтез редактора остаётся после разделов', async () => {
  const result = await summarizeFanout({
    selected: rows(10), interestsText: '', config, budget,
    summarize: async (itemsText) => (itemsText.includes('Ниже весь поток')
      ? 'LEAD\n\n<b>🧠 СИНТЕЗ</b>\nSYNTHESIS'
      : 'MAP'),
  });
  assert.ok(result.text.startsWith('LEAD'));
  assert.ok(result.text.endsWith('SYNTHESIS'));
  assert.equal((result.text.match(/MAP/g) ?? []).length, 2);
});

test('веер: упавшая часть не отменяет сводку и не помечается прочитанной', async () => {
  let maps = 0;
  const result = await summarizeFanout({
    selected: rows(10), interestsText: '', config, budget,
    summarize: async (itemsText) => {
      if (itemsText.includes('Ниже весь поток')) return 'EDITOR';
      maps += 1;
      if (maps === 1) throw new Error('map fail');
      return 'MAP';
    },
  });
  assert.match(result.text, /EDITOR/);
  assert.equal((result.text.match(/MAP/g) ?? []).length, 1);
  assert.match(result.note, /часть 1 не собралась/);
  // Пункты упавшей части не помечаются прочитанными: они вернутся в следующую сводку.
  assert.equal(result.items.length, 5);
});

test('веер: без редактора части всё равно доставляются', async () => {
  const result = await summarizeFanout({
    selected: rows(10), interestsText: '', config, budget,
    summarize: async (itemsText) => {
      if (itemsText.includes('Ниже весь поток')) throw new Error('editor fail');
      return 'MAP';
    },
  });
  assert.equal((result.text.match(/MAP/g) ?? []).length, 2);
  assert.match(result.note, /общий лид\/синтез не собрался/);
  assert.equal(result.items.length, 10);
});

test('веер: обрезка части помечается, но текст остаётся', async () => {
  const result = await summarizeFanout({
    selected: rows(10), interestsText: '', config, budget,
    summarize: async (itemsText) => {
      if (itemsText.includes('Ниже весь поток')) return 'EDITOR';
      throw truncated('П'.repeat(500));
    },
  });
  assert.match(result.note, /часть сводки сокращена/);
  assert.equal(result.items.length, 10);
});

test('веер: если обе части упали, сводки нет', async () => {
  await assert.rejects(
    () => summarizeFanout({
      selected: rows(10), interestsText: '', config, budget,
      summarize: async (itemsText) => {
        if (itemsText.includes('Ниже весь поток')) return 'EDITOR';
        throw new Error('map fail');
      },
    }),
    /map fail/,
  );
});
