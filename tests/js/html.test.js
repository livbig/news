import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtmlList } from '../../tgcloud/lib/html.js';

// Фикстуры воспроизводят вёрстку реальных источников пользователя:
// HN (таблица ссылок) и карточки новостей Yahoo Finance.

const HN = `<html><body><center><table id="hnmain">
<tr><td><span class="pagetop"><a href="news">Hacker News</a></span></td></tr>
<tr class="athing" id="1"><td class="title"><span class="titleline"><a href="item?id=1">Fed signals slower rate cuts into 2027</a></span>
<span class="sitebit comhead"> (<a href="from?site=reuters.com"><span class="sitestr">reuters.com</span></a>)</span></td></tr>
<tr><td class="subtext"><span class="age"><a href="item?id=1">3 hours ago</a></span></td></tr>
<tr class="athing" id="2"><td class="title"><span class="titleline"><a href="https://example.com/ai-chips">Nvidia unveils next generation of AI accelerators</a></span></td></tr>
<tr><td><a href="//news.ycombinator.com/newest">New</a> | <a href="javascript:void(0)">hide</a></td></tr>
</table></center></body></html>`;

const CARDS = `<html><body><main>
<article class="story-card">
  <h2><a href="/markets/2026/10/gold-hits-record">Gold hits record high as the dollar weakens</a></h2>
  <time datetime="2026-10-19T09:30:00Z">19 октября</time>
</article>
<article class="story-card">
  <h2><a href="/markets/2026/10/oil-slips">Oil slips on demand worries in Asia</a></h2>
  <p><time datetime="2026-10-18T16:05:00Z"></time></p>
</article>
<article>
  <h3><a href="https://finance.yahoo.com/news/fed-minutes-123.html">Fed minutes show split on further tightening</a></h3>
</article>
</main></body></html>`;

// Навигация, промо, футер и дубль ссылки с другим текстом — на страницу должен
// попасть только осмысленный список новостей (пути относительные).
const JUNK = `<html><head><title>Markets</title></head><body>
<nav class="topnav">
  <a href="/">Home</a>
  <a href="/login">Sign in</a>
  <a href="/more">More</a>
  <a href="/markets">Markets</a>
  <a href="/rss">RSS</a>
</nav>
<div class="promo"><a href="javascript:void(0)" class="btn">Subscribe to our free daily newsletter</a></div>
<div class="footer"><a href="mailto:newsroom@example.com">Write to the newsroom about this story</a></div>
<footer>
  <a href="#top">Back to the top of this page</a>
  <a href="/privacy">Privacy policy</a>
</footer>
<div class="list">
  <div><a href="stocks/nvda">Nvidia shares jump after data-center demand surprise</a></div>
  <div><a href="/stocks/aapl">Apple delays its foldable phone to the second half of next year</a></div>
  <div><a href="stocks/nvda">Nvidia shares jump after data-center demand surprise — most read</a></div>
</div>
</body></html>`;

test('html: список HN — заголовки из titleline, относительные ссылки абсолютные', () => {
  const items = parseHtmlList(HN, { baseUrl: 'https://news.ycombinator.com/' });
  assert.equal(items.length, 2, 'навигация и дубль ссылки не проходят');
  assert.equal(items[0].title, 'Fed signals slower rate cuts into 2027');
  assert.equal(items[0].url, 'https://news.ycombinator.com/item?id=1');
  assert.equal(items[1].url, 'https://example.com/ai-chips', 'абсолютная ссылка не переписывается');
  assert.equal(items[0].text, '', 'полного текста у html-источника нет');
  assert.match(items[0].published, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'без <time> — текущее время');
});

test('html: карточки article/h2 — дата из ближайшего <time datetime>', () => {
  const items = parseHtmlList(CARDS, { baseUrl: 'https://finance.yahoo.com/markets/' });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.url), [
    'https://finance.yahoo.com/markets/2026/10/gold-hits-record',
    'https://finance.yahoo.com/markets/2026/10/oil-slips',
    'https://finance.yahoo.com/news/fed-minutes-123.html',
  ]);
  assert.equal(items[0].published, '2026-10-19T09:30:00Z');
  assert.equal(items[1].published, '2026-10-18T16:05:00Z', 'дата соседней карточки не перетекает');
  assert.match(items[2].published, /^\d{4}-\d\d-\d\dT/, 'без <time> — текущее время');
});

test('html: мусорная страница — только осмысленные ссылки, дубли по URL отброшены', () => {
  const items = parseHtmlList(JUNK, { baseUrl: 'https://finance.yahoo.com/markets/' });
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => item.url).sort(),
    ['https://finance.yahoo.com/markets/stocks/nvda', 'https://finance.yahoo.com/stocks/aapl'],
    'javascript:, mailto:, # и навигация отброшены: «/stocks/aapl» — от корня, «stocks/nvda» — от baseUrl',
  );
  assert.ok(!items.some((item) => /Home|Sign in|Privacy|newsletter|newsroom/.test(item.title)));
  assert.match(items[0].title, /^Apple/, 'без article/заголовков — первыми идут самые длинные ссылки');
});

test('html: страница без осмысленных ссылок даёт пустой список', () => {
  const navOnly = '<html><body><nav><a href="/">Home</a><a href="/more">More</a></nav></body></html>';
  assert.deepEqual(parseHtmlList(navOnly, { baseUrl: 'https://example.com/' }), []);
});

test('html: не больше 20 пунктов со страницы', () => {
  let page = '<html><body>';
  for (let i = 0; i < 60; i += 1) {
    page += `<article><h2><a href="/n/${i}">Новость номер ${i} про рынки и ставки</a></h2></article>`;
  }
  const items = parseHtmlList(`${page}</body></html>`, { baseUrl: 'https://example.com/' });
  assert.equal(items.length, 20);
  assert.equal(items[0].url, 'https://example.com/n/0', 'порядок на странице сохраняется');
});

test('absoluteUrl: query сохраняется, фрагмент срезается (без конструктора URL)', async () => {
  const { absoluteUrl } = await import('../../tgcloud/lib/html.js');
  assert.equal(absoluteUrl('https://e.com/a?x=1#f', 'https://b.com'), 'https://e.com/a?x=1');
  assert.equal(absoluteUrl('/item?id=1', 'https://news.ycombinator.com'), 'https://news.ycombinator.com/item?id=1');
  assert.equal(absoluteUrl('//cdn.com/a', 'https://b.com/x'), 'https://cdn.com/a');
  assert.equal(absoluteUrl('../up', 'https://b.com/x/y/z'), 'https://b.com/x/up');
  assert.equal(absoluteUrl('javascript:alert(1)', 'https://b.com'), null);
  assert.equal(absoluteUrl('', 'https://b.com'), null);
});
