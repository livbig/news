// HTTP-интерфейс службы: фронтенд и агент ходят сюда. Проверяем доступ, CRUD источников,
// интересы, поиск и раздачу статики. Сеть наружу не нужна — только локальный порт.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'news-api-'));
process.env.NEWS_DB = join(dir, 'news.db');
process.env.NEWS_CHAT_ID = '77';
process.env.NEWS_API_TOKEN = 'secret-test';
process.env.LLM_API_KEY = 'test-key';

const { createApi, kindForUrl } = await import('../src/api.js');
const { ensureUser, insertItem, listSources, openStore, storeHandle } = await import('../src/store.js');
const { isoNow } = await import('../src/text.js');

openStore(process.env.NEWS_DB);
let base = '';
let api = null;

before(async () => {
  await ensureUser(77);
  api = createApi({ chatId: 77, port: 0, host: '127.0.0.1', token: 'secret-test', log: () => {} });
  await api.listen();
  base = `http://127.0.0.1:${api.address().port}`;
});

after(async () => {
  await api?.close();
  try {
    storeHandle().close();
  } catch {
    /* уже закрыта */
  }
  rmSync(dir, { recursive: true, force: true });
});

const call = (path, options = {}, token = 'secret-test') =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) },
  });

test('kindForUrl: канал, rss, html', () => {
  assert.equal(kindForUrl('@ai_newz'), 'tgweb');
  assert.equal(kindForUrl('https://t.me/ai_newz'), 'tgweb');
  assert.equal(kindForUrl('https://ex.com/feed.xml'), 'rss');
  assert.equal(kindForUrl('https://ex.com/rss/news'), 'rss');
  assert.equal(kindForUrl('https://ex.com/news'), 'html');
  assert.equal(kindForUrl('https://hnrss.org/newest?q=robotics&points=40'), 'rss');
  assert.equal(kindForUrl('https://hnrss.org/newest?q=robotics&points=40'), 'rss');
  assert.equal(kindForUrl(''), null);
});

test('health открыт, остальное — только с токеном', async () => {
  const health = await call('/api/health', {}, null);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const denied = await call('/api/state', {}, null);
  assert.equal(denied.status, 401);
  // Токен в query больше не принимается: он утекал в историю браузера, Referer и журналы прокси.
  const byQuery = await fetch(`${base}/api/state?token=secret-test`);
  assert.equal(byQuery.status, 401);
});

test('состояние: слоты, модель, метки', async () => {
  const data = await (await call('/api/state')).json();
  assert.equal(data.chatId, 77);
  assert.equal(data.model, 'deepseek-flash');
  assert.deepEqual(data.sendTimes, ['09:00', '21:00']);
  assert.ok(data.nextSlot?.ms > Date.now());
  assert.equal(typeof data.stats.sources, 'number');
});

test('источники: добавление, список, выключение, удаление', async () => {
  const created = await call('/api/sources', { method: 'POST', body: JSON.stringify({ url: 'https://ex.com/api.xml' }) });
  assert.equal(created.status, 200);
  const payload = await created.json();
  assert.equal(payload.created, true);
  assert.equal(payload.kind, 'rss');

  const list = await (await call('/api/sources')).json();
  const source = list.sources.find((row) => row.url === 'https://ex.com/api.xml');
  assert.ok(source);

  const disabled = await call(`/api/sources/${source.id}`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal((await disabled.json()).enabled, false);
  assert.equal(listSources(77).find((row) => row.id === source.id).enabled, 0);

  const removed = await call(`/api/sources/${source.id}`, { method: 'DELETE' });
  assert.equal((await removed.json()).removed, true);
  const after = await (await call('/api/sources')).json();
  assert.equal(after.sources.some((row) => row.id === source.id), false);
});

test('интересы: добавление создаёт Google News, удаление чистит профиль', async () => {
  const added = await (await call('/api/interests', { method: 'POST', body: JSON.stringify({ terms: ['золото'] }) })).json();
  assert.match(added.text, /золото/);
  const list = await (await call('/api/interests')).json();
  assert.ok(list.terms.includes('золото'));
  assert.ok(list.sources >= 1);
  const removed = await (await call('/api/interests', { method: 'POST', body: JSON.stringify({ action: 'remove', terms: ['золото'] }) })).json();
  assert.deepEqual(removed.removed, ['золото']);
  const list2 = await (await call('/api/interests')).json();
  assert.equal(list2.terms.includes('золото'), false);
});

test('поиск по ленте через API', async () => {
  const { addSource } = await import('../src/store.js');
  const { id } = await addSource(77, { kind: 'rss', url: 'https://ex.com/s.xml', title: 'S' });
  await insertItem(id, { url: 'https://ex.com/s/1', title: 'Платина дорожает', text: 'металлы', published: isoNow() });
  const found = await (await call('/api/search?q=платина')).json();
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].url, 'https://ex.com/s/1');
});

test('фронтенд раздаётся и содержит вкладки', async () => {
  const html = await call('/');
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, /Сводки/);
  assert.match(body, /Источники/);
  const css = await call('/style.css');
  assert.equal(css.status, 200);
});

test('путь наружу веб-корня закрыт', async () => {
  const response = await call('/../package.json');
  assert.equal(response.status, 404);
});

test('без токена служба не выходит на 0.0.0.0 (fail-closed)', () => {
  assert.throws(() => createApi({ chatId: 77, port: 0, host: '0.0.0.0', token: '', log: () => {} }), /fail-closed/);
  // loopback без токена — это режим разработки, он разрешён
  const local = createApi({ chatId: 77, port: 0, host: '127.0.0.1', token: '', log: () => {} });
  assert.ok(local);
});

test('битое тело — 400, слишком большое — 413', async () => {
  const broken = await call('/api/sources', { method: 'POST', body: '{"url": ' });
  assert.equal(broken.status, 400);
  const big = await call('/api/sources', { method: 'POST', body: JSON.stringify({ url: 'https://ex.com/f.xml', junk: 'x'.repeat(300_000) }) });
  assert.equal(big.status, 413);
});
