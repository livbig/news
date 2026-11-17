// Стартовый набор источников: без дублей, с валидными типами, посев идемпотентен.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'news-pack-'));
process.env.NEWS_CHAT_ID = '5';
process.env.NEWS_DB = join(dir, 'news.db');

const { DEFAULT_PACK, INTEREST_TERMS, seedSources } = await import('../src/sources-pack.js');
const { getInterests, listSources, openStore, storeHandle } = await import('../src/store.js');
const { parseInterests } = await import('../src/interests.js');

openStore(process.env.NEWS_DB);
after(() => {
  try {
    storeHandle().close();
  } catch {
    /* уже закрыта */
  }
  rmSync(dir, { recursive: true, force: true });
});

test('набор: уникальные пары тип+адрес и допустимые типы', () => {
  const seen = new Set();
  for (const source of DEFAULT_PACK) {
    assert.ok(['rss', 'tgweb', 'html'].includes(source.kind), `тип ${source.kind}`);
    assert.match(source.url, /^(https?:\/\/|@)/, `адрес ${source.url}`);
    assert.ok(source.title?.trim(), 'у источника есть название');
    const key = `${source.kind}:${source.url}`;
    assert.equal(seen.has(key), false, `дубль ${key}`);
    seen.add(key);
  }
});

test('термины интересов: непустые и без повторов', () => {
  assert.ok(INTEREST_TERMS.length >= 8);
  const seen = new Set();
  for (const term of INTEREST_TERMS) {
    assert.ok(term.trim().length > 2);
    assert.equal(seen.has(term.toLowerCase()), false, `дубль ${term}`);
    seen.add(term.toLowerCase());
  }
});

test('посев: источники, профиль интересов и Google News по темам', async () => {
  const first = await seedSources(5, { log: () => {} });
  assert.ok(first.created >= DEFAULT_PACK.length, `создано ${first.created}`);
  assert.equal(first.interests, true);
  const rows = listSources(5);
  assert.ok(rows.some((row) => row.origin === 'pack'));
  assert.ok(rows.some((row) => row.origin === 'interest' && /news\.google\.com/.test(row.url)));
  const terms = parseInterests(await getInterests(5));
  assert.ok(terms.length >= 5);
});

test('легаси-профиль переписывается в DEFAULT_INTERESTS, свои правки не трогаются', async () => {
  const { DEFAULT_INTERESTS, LEGACY_PROFILES } = await import('../src/prompts.js');
  const { setInterests } = await import('../src/store.js');
  await setInterests(5, LEGACY_PROFILES[0]);
  await seedSources(5, { log: () => {} });
  assert.equal(await getInterests(5), DEFAULT_INTERESTS);
  await setInterests(5, LEGACY_PROFILES[1]);
  await seedSources(5, { log: () => {} });
  assert.equal(await getInterests(5), DEFAULT_INTERESTS, 'вторая прошлая версия тоже переписывается');
  await setInterests(5, 'золото, роботы');
  await seedSources(5, { log: () => {} });
  assert.equal(await getInterests(5), 'золото, роботы');
});

test('повторный посев ничего не дублирует', async () => {
  const before = listSources(5).length;
  const second = await seedSources(5, { log: () => {} });
  assert.equal(second.created, 0);
  assert.equal(second.interests, false);
  assert.equal(listSources(5).length, before);
});
