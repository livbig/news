// Тексты ответов бота (HTML). Держим отдельно от логики: их правят чаще, чем код.

import { escapeHtml, plural } from './text.js';

export function helpText(maxSources = 100) {
  return [
    '❓ <b>Как пользоваться</b>',
    '',
    '• «сводка», «ну как там», «что нового» — соберу новости с прошлой сводки (не больше 7 дней).',
    '• «а что по золоту», «подробнее про второй пункт» — отвечу по накопленной ленте со ссылками.',
    '• /digest — то же, что «сводка». /sources — источники, /stats — статистика.',
    '',
    `Источников можно держать до ${maxSources}. Расписания нет: сводка приходит по твоему запросу.`,
  ].join('\n');
}

export function settingsText() {
  return [
    '⚙️ <b>Настройки</b>',
    '',
    'Расписания нет — сводка приходит по текстовому запросу («сводка»).',
    'Окно: с прошлой сводки до сейчас, максимум 7 дней.',
    'Источник и его включение — /sources.',
  ].join('\n');
}

export function sourcesText(list) {
  if (!list.length) return '📡 Источников пока нет. Напиши «сводка» — сначала нужно добавить источники.';
  const ok = list.filter((row) => row.status === 'ok').length;
  const lines = [`📡 <b>Источники</b> (${list.length}, активных ${ok})`, ''];
  for (const row of list.slice(0, 60)) {
    const flag = Number(row.enabled) === 1 ? (row.status === 'error' ? '⚠️' : '•') : '⏸';
    const kind = row.kind === 'tgweb' ? '@' : '';
    lines.push(`${flag} ${kind}${escapeHtml(row.title || row.url)}${row.statusMsg && row.status === 'error' ? ` — ${escapeHtml(row.statusMsg).slice(0, 80)}` : ''}`);
  }
  if (list.length > 60) lines.push(`… и ещё ${list.length - 60}`);
  return lines.join('\n');
}

export function statsText(data) {
  return [
    '📊 <b>Статистика</b>',
    '',
    `Источников: ${data.sources} (с ошибками: ${data.errors})`,
    `Новостей в базе: ${data.items}, за сутки: ${data.fresh}`,
    `Сводок выдано: ${data.digests}`,
  ].join('\n');
}

export function digestCountText(n) {
  return `Собрал ${plural(n, 'пункт', 'пункта', 'пунктов')}.`;
}
