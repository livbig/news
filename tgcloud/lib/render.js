// Тексты ответов бота (HTML). Держим отдельно от логики: их правят чаще, чем код.

import { escapeHtml, plural } from './text.js';

export function helpText(maxSources = 100) {
  return [
    '❓ <b>Как пользоваться</b>',
    '',
    '• «сводка», «ну как там», «что нового» — соберу новости с прошлой сводки (не больше 7 дней).',
    '• «сводка за 3 дня», «а что было вчера», «с 1 октября» — сводка за названный период (глубже 7 дней не беру).',
    '• «а что по золоту», «подробнее про второй пункт» — отвечу по накопленной ленте со ссылками.',
    '• «добавь в интересы «тема»», «покажи интересы», «убери «тема»» — профиль и источники по интересам.',
    '• /digest — то же, что «сводка». /sources — источники, /interests — интересы, /stats — статистика.',
    '',
    `Источников можно держать до ${maxSources}. Расписания нет: сводка приходит по твоему запросу.`,
  ].join('\n');
}

export function settingsText() {
  return [
    '⚙️ <b>Настройки</b>',
    '',
    'Расписания нет — сводка приходит по текстовому запросу («сводка»).',
    'Окно: с прошлой сводки до сейчас, максимум 7 дней. Период можно назвать словами: «за 3 дня», «а что было вчера».',
    'Сводка за названный период не сдвигает «с прошлой сводки».',
    'Источник и его включение — /sources. Интересы — /interests.',
  ].join('\n');
}

/** Список интересов (FR-7): термины, источники по ним, как править. */
export function interestsListText(rows) {
  if (!rows.length) {
    return [
      '🎯 <b>Интересы</b>',
      '',
      'Профиль не задан — в сводке используется дефолтный.',
      'Напиши «добавь в интересы «тема»» — заведу интерес и источник Google News по нему.',
    ].join('\n');
  }
  const lines = [`🎯 <b>Интересы</b>: ${rows.length}`, ''];
  rows.forEach((row, index) => {
    const mark = row.active ? '✅' : row.total ? '⏸' : '—';
    const sources = row.total ? `источников: ${row.total}` : 'источника нет';
    lines.push(`${index + 1}. ${escapeHtml(row.term)} ${mark} <i>${sources}</i>`);
  });
  lines.push('', 'Убрать — «убери «тема»». Добавить — «добавь в интересы «тема»».');
  return lines.join('\n');
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
