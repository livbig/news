import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeFeed, parseFeed } from '../../tgcloud/lib/rss.js';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title><![CDATA[Золото выросло]]></title><link>https://ex.com/a?utm=1</link>
<pubDate>Mon, 19 Oct 2026 09:00:00 +0000</pubDate>
<description><![CDATA[<p>Цена <b>выросла</b> на 2%</p>]]></description></item>
<item><title>Без даты</title><link>https://ex.com/b</link></item>
<item><title>Без ссылки</title></item>
</channel></rss>`;

test('RSS: заголовок, ссылка, дата, текст', () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Золото выросло');
  assert.equal(items[0].url, 'https://ex.com/a?utm=1');
  assert.equal(items[0].published, '2026-10-19T09:00:00Z');
  assert.match(items[0].text, /выросла на 2%/);
  assert.ok(items[1].published, 'битая дата — не повод терять новость');
});

test('Atom: link href и published', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<title>ФРС снизила ставку</title><link rel="alternate" href="https://ex.com/fed"/>
<updated>2026-10-18T12:30:00Z</updated><content type="html">Текст новости</content></entry></feed>`;
  const [item] = parseFeed(atom);
  assert.equal(item.url, 'https://ex.com/fed');
  assert.equal(item.published, '2026-10-18T12:30:00Z');
  assert.equal(item.text, 'Текст новости');
});

test('HTML-страница ошибки не считается фидом', () => {
  assert.equal(looksLikeFeed('<html><body>403</body></html>'), false);
  assert.equal(looksLikeFeed(RSS), true);
});
