// Управление источниками из бота: список с кнопками, разбор ответа пользователя.
// Чистые функции (без sdk) — покрыты тестами.

import { escapeHtml, plural } from './text.js';
import { channelFromInput } from './tgparse.js';

/** Определить тип источника по тому, что прислал пользователь. */
export function detectSource(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { kind: null, url: '', reason: 'пусто' };

  // Голое слово — НЕ канал: «gold» не должен становиться источником-каналом.
  const looksChannel = raw.startsWith('@') || /^https?:\/\/(t\.me|telegram\.me)\//i.test(raw);
  const channel = looksChannel ? channelFromInput(raw) : null;
  if (channel && !/^https?:\/\//i.test(raw)) return { kind: 'tgweb', url: channel };

  if (/^https?:\/\//i.test(raw) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(raw)) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (/(\.rss|\.xml|\/feed\/?$|\/rss\/?$|feeds?\.|atom)/i.test(url)) return { kind: 'rss', url };
    if (/^https?:\/\/t\.me\/(s\/)?[a-z0-9_]+/i.test(url)) return { kind: 'tgweb', url: channel ?? url };
    return { kind: 'html', url };
  }
  return { kind: null, url: '', reason: 'не похоже на ссылку или @канал' };
}

const KIND_LABEL = { rss: 'RSS', tgweb: '@канал', twitter: 'X-мост', html: 'сайт', reddit: 'reddit' };

/** Список источников: текст + inline-клавиатура (по одной строке на источник). */
export function sourcesView(list, { perPage = 8 } = {}) {
  const active = list.filter((row) => Number(row.enabled) === 1);
  if (!list.length) {
    return {
      text: '📡 Источников пока нет. Нажми «Добавить» и пришли ссылку на RSS, сайт или @канал.',
      keyboard: [[{ text: '➕ Добавить', callback_data: 'src:add' }]],
    };
  }
  const lines = [`📡 <b>Источники</b>: ${plural(list.length, 'источник', 'источника', 'источников')}, активных ${active.length}`, ''];
  const keyboard = [];
  for (const row of list.slice(0, perPage)) {
    const on = Number(row.enabled) === 1;
    const mark = on ? (row.status === 'error' ? '⚠️' : '✅') : '⏸';
    const title = escapeHtml((row.title || row.url).slice(0, 60));
    const buttonTitle = String(row.title || row.url).slice(0, 22); // клавиатура HTML не парсит
    lines.push(`${mark} ${title} <i>${escapeHtml(KIND_LABEL[row.kind] ?? row.kind)}</i>${on && row.status === 'error' ? ` — ${escapeHtml(String(row.statusMsg ?? '').slice(0, 60))}` : ''}`);
    keyboard.push([
      { text: `${on ? '⏸' : '▶️'} ${buttonTitle}`, callback_data: `src:toggle:${row.id}` },
      { text: '🗑', callback_data: `src:del:${row.id}` },
    ]);
  }
  if (list.length > perPage) lines.push(`… и ещё ${list.length - perPage}`);
  keyboard.push([{ text: '➕ Добавить', callback_data: 'src:add' }]);
  return { text: lines.join('\n'), keyboard };
}

/** Разбор callback_data вида `src:toggle:12`. */
export function parseSourceCallback(data) {
  const match = String(data ?? '').match(/^src:(add|toggle|del)(?::(\d+))?$/);
  if (!match) return null;
  return { action: match[1], id: match[2] ? Number(match[2]) : null };
}
