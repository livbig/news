// Инструменты агента: реальный HTTP-стаб службы и фальшивый pi-реестр.
// Проверяем то, что видит модель: имена инструментов, форму ответа и честную ошибку,
// когда служба недоступна.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

let server;
let baseUrl;
const requests = [];

before(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/api/state') return send({ sendTimes: ['09:00', '21:00'], nextSlot: { ms: Date.now() + 3_600_000, time: '21:00' }, lastCollectAt: new Date().toISOString(), lastAnalyzeAt: new Date().toISOString(), lastDigestAt: null, stats: { sources: 56, items: 100, fresh: 40, digests: 2 }, analysis: { analyzed: 60, total: 100 }, model: 'deepseek-flash' });
    if (req.url === '/api/collect') return send({ sources: 56, added: 7, errors: [{ url: 'https://bad.example' }], analysis: { analyzed: 7 } });
    if (req.url === '/api/digest') return send({ digestId: 12, items: 80, chars: 17000 });
    if (req.url === '/api/sources') return send({ sources: [{ id: 1, title: 'Ведомости', kind: 'rss', enabled: 1, total: 10, fresh: 5, status: 'ok' }] });
    if (req.url.startsWith('/api/sources/')) return send({ id: 1, enabled: false });
    if (req.url === '/api/interests') return send({ text: 'золото', terms: ['золото'], sources: 1 });
    if (req.url.startsWith('/api/search')) return send({ query: 'золото', results: [{ id: 5, title: 'Золото', url: 'https://ex.com/g', gist: 'рост' }] });
    res.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

/** Минимальный реестр pi: копит инструменты и отдаёт их по имени. */
function fakePi() {
  const tools = new Map();
  return {
    tools,
    registerTool: (tool) => tools.set(tool.name, tool),
  };
}

async function loadExtension() {
  process.env.NEWS_API_URL = baseUrl;
  process.env.NEWS_API_TOKEN = 'test-token';
  const module = await import('../extensions/news.js?stub=' + Math.random());
  const pi = fakePi();
  module.default(pi);
  return pi;
}

const call = (pi, name, params = {}) => pi.tools.get(name).execute('id', params);

test('регистрирует 6 инструментов и ходит в службу с токеном', async () => {
  const pi = await loadExtension();
  assert.deepEqual([...pi.tools.keys()].sort(), ['news_collect', 'news_digest', 'news_interests', 'news_search', 'news_sources', 'news_status']);
  const result = await call(pi, 'news_status');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.источников, 56);
  assert.equal(payload.расписание.length, 2);
  const last = requests.at(-1);
  assert.equal(last.auth, 'Bearer test-token');
});

test('сводка по умолчанию отправляется, send=false — только текст', async () => {
  const pi = await loadExtension();
  const sent = JSON.parse((await call(pi, 'news_digest', { period: 'вчера' })).content[0].text);
  assert.equal(sent.отправлено, true);
  assert.equal(sent.сводка, 12);
  assert.ok(requests.some((row) => row.method === 'POST' && row.url === '/api/digest'));
});

test('источники: список, добавление, выключение', async () => {
  const pi = await loadExtension();
  const list = JSON.parse((await call(pi, 'news_sources', { action: 'list' })).content[0].text);
  assert.equal(list.всего, 1);
  const disabled = JSON.parse((await call(pi, 'news_sources', { action: 'disable', id: 1 })).content[0].text);
  assert.equal(disabled.enabled, false);
});

test('интересы и поиск отвечают данными службы', async () => {
  const pi = await loadExtension();
  const interests = JSON.parse((await call(pi, 'news_interests', { action: 'list' })).content[0].text);
  assert.deepEqual(interests.темы, ['золото']);
  const found = JSON.parse((await call(pi, 'news_search', { query: 'золото' })).content[0].text);
  assert.equal(found.найдено, 1);
});

test('служба недоступна: ошибка текстом, а не падение', async () => {
  process.env.NEWS_API_URL = 'http://127.0.0.1:1';
  process.env.NEWS_API_TOKEN = 'test-token';
  const module = await import('../extensions/news.js?down=' + Math.random());
  const pi = fakePi();
  module.default(pi);
  const result = await call(pi, 'news_status');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Ошибка/);
});
