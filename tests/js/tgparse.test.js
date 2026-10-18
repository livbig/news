import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelFromInput, parseChannelPage } from '../../tgcloud/lib/tgparse.js';

const HTML = `<div class="tgme_widget_message_wrap" data-post="metals/101">
  <div class="tgme_widget_message_text js-message_text" dir="auto">Золото <b>пробило</b> 4000<br>Подробности позже</div>
  <time datetime="2026-10-19T06:00:00+00:00"></time></div>
<div class="tgme_widget_message_wrap" data-post="metals/100">
  <div class="tgme_widget_message_text js-message_text" dir="auto">Платина дешевеет</div>
  <time datetime="2026-10-18T18:00:00+00:00"></time></div>`;

test('пост канала: id, ссылка, дата, текст', () => {
  const page = parseChannelPage(HTML, 'metals');
  assert.equal(page.items.length, 2);
  assert.equal(page.maxId, 101);
  assert.equal(page.minId, 100);
  assert.equal(page.items[0].url, 'https://t.me/metals/101');
  assert.equal(page.items[0].published, '2026-10-19T06:00:00Z');
  assert.match(page.items[0].text, /пробило 4000/);
});

test('разбор и вставки в ссылки каналов', () => {
  assert.equal(channelFromInput('@metals'), 'metals');
  assert.equal(channelFromInput('t.me/s/metals'), 'metals');
  assert.equal(channelFromInput('https://t.me/metals/101'), 'metals');
  assert.equal(channelFromInput('не канал'), null);
});
