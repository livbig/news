import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSource, parseSourceCallback, sourcesView } from '../../tgcloud/lib/sources-ui.js';

test('тип источника определяется по ссылке', () => {
  assert.deepEqual(detectSource('https://ex.com/feed.xml'), { kind: 'rss', url: 'https://ex.com/feed.xml' });
  assert.deepEqual(detectSource('ex.com/rss'), { kind: 'rss', url: 'https://ex.com/rss' });
  assert.equal(detectSource('https://t.me/durov').kind, 'tgweb');
  assert.equal(detectSource('@BFMnews').kind, 'tgweb');
  assert.equal(detectSource('https://news.ycombinator.com').kind, 'html');
  assert.equal(detectSource('привет').kind, null);
  assert.equal(detectSource('').kind, null);
});

test('callback_data разбирается строго', () => {
  assert.deepEqual(parseSourceCallback('src:toggle:12'), { action: 'toggle', id: 12 });
  assert.deepEqual(parseSourceCallback('src:add'), { action: 'add', id: null });
  assert.equal(parseSourceCallback('src:hack:1; DROP'), null);
  assert.equal(parseSourceCallback('other'), null);
});

test('список источников: отметки состояния и кнопки', () => {
  const view = sourcesView([
    { id: 1, kind: 'rss', title: 'FXStreet', enabled: 1, status: 'ok' },
    { id: 2, kind: 'tgweb', title: 'BFM', enabled: 0, status: 'ok' },
    { id: 3, kind: 'html', title: 'HN', enabled: 1, status: 'error', statusMsg: '[HTTP_403] 403' },
  ]);
  assert.match(view.text, /3 источника/);
  assert.match(view.text, /✅ FXStreet/);
  assert.match(view.text, /⏸ BFM/);
  assert.match(view.text, /⚠️ HN.*HTTP_403/);
  assert.deepEqual(view.keyboard.at(-1), [{ text: '➕ Добавить', callback_data: 'src:add' }]);
});

test('пустой список предлагает добавить', () => {
  const view = sourcesView([]);
  assert.match(view.text, /Источников пока нет/);
  assert.deepEqual(view.keyboard, [[{ text: '➕ Добавить', callback_data: 'src:add' }]]);
});
