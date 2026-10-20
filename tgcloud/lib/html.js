// Замена bs4 для страниц-списков новостей (kind='html'): чистый модуль без DOM
// и сети — только регулярные выражения и строковые операции (гоняется в node --test).
// Разметка читается эвристикой: сначала ссылки-заголовки в типичных списках
// (article, h1..h3, классы title|headline|story), если таких нет — самые длинные
// по тексту ссылки страницы (навигация и служебные ссылки короткие).
// ponytail: дерево не строим, потолок — нестандартная вёрстка без article/заголовков;
// тогда нужен настоящий HTML-парсер.

import { decodeEntities, isoFromMs, isoNow, stripTags } from './text.js';

const MAX_ITEMS = 20; // пунктов со страницы: сводке больше не нужно
const MAX_ANCHORS = 5000; // страницы бывают 1–5 МБ: дальше по ссылкам не идём
const CONTEXT = 800; // окно перед ссылкой — в каком блоке она лежит
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const SKIP_HREF = /^(?:#|javascript:|mailto:|tel:|data:)/i;
const NAV_TITLES = /^(?:more|home|sign in|log in|login|sign up|register|subscribe|newsletter|about|contact|privacy|cookies?|terms|search|menu|share|comments?|read more|see all|all news|next|previous|prev|back|top|help|faq|rss|advertise|careers?|jobs|follow us|twitter|facebook|linkedin|instagram|youtube|войти|подписаться|ещё|все новости)$/i;

/**
 * @param {string} html ответ страницы-списка новостей
 * @param {{baseUrl:string}} options baseUrl — адрес источника (для относительных ссылок)
 * @returns {{title:string, url:string, published:string, text:string}[]} не больше 40 пунктов
 */
export function parseHtmlList(html, { baseUrl } = {}) {
  const source = String(html ?? '');
  const now = isoNow();
  const seen = new Set();
  const found = [];
  let structuredCount = 0;
  let anchors = 0;
  for (const match of source.matchAll(ANCHOR)) {
    anchors += 1;
    if (anchors > MAX_ANCHORS) break;
    // &amp; в href — обычное дело; без декодирования ссылка ведёт на «amp;t=…»
    const url = absoluteUrl(decodeEntities(hrefOf(match[1])), baseUrl);
    if (!url || seen.has(url)) continue;
    // Заголовок — текст ссылки; 25 символов отсекают «More», «Markets», «Войти».
    // Сначала снимаем теги, потом режем: обрезка HTML посередине оставляет куски разметки.
    const title = stripTags(match[2]);
    if (title.length < 25 || NAV_TITLES.test(title)) continue;
    seen.add(url);
    const structured = inListBlock(source, match.index);
    found.push({
      url,
      title: title.slice(0, 200),
      published: publishedNearby(source, match.index, match.index + match[0].length, now),
      structured,
    });
    if (structured && ++structuredCount >= MAX_ITEMS) break; // порядок на странице = свежесть
  }
  const structured = found.filter((entry) => entry.structured);
  const chosen = structured.length ? structured : [...found].sort((a, b) => b.title.length - a.title.length);
  return chosen.slice(0, MAX_ITEMS).map(({ title, url, published }) => ({ title, url, published, text: '' }));
}

/** Ссылка внутри article/h1..h3 или блока с классом title|headline|story — это заголовок. */
function inListBlock(source, index) {
  const prefix = source.slice(Math.max(0, index - CONTEXT), index).toLowerCase();
  if (prefix.lastIndexOf('<article') > prefix.lastIndexOf('</article')) return true;
  for (const tag of ['h1', 'h2', 'h3']) {
    if (prefix.lastIndexOf(`<${tag}`) > prefix.lastIndexOf(`</${tag}>`)) return true;
  }
  // Класс ближайшего открывающего тега; хвост ограничен, чтобы не читать текст абзаца.
  return /class\s*=\s*["'][^"']*(?:title|headline|story)[^"']*["'][^>]*>/.test(prefix.slice(-400));
}

/** Дата: <time datetime="..."> в том же блоке — сначала после ссылки, потом до неё.
 * Границы блока (</article>, </li>, </tr>) не переходим: иначе прилетит дата соседней карточки. */
const BLOCK_END = /<\/(?:article|li|tr)>/i;

function publishedNearby(source, start, end, fallback) {
  const after = source.slice(end, end + 400);
  const stop = after.search(BLOCK_END);
  const fromAfter = timeValue(stop >= 0 ? after.slice(0, stop) : after);
  if (fromAfter) return fromAfter;
  const before = source.slice(Math.max(0, start - 400), start);
  return timeValue(before.split(BLOCK_END).at(-1) ?? '') ?? fallback;
}

function timeValue(chunk) {
  const ms = Date.parse(chunk.match(/<time[^>]*datetime\s*=\s*["']([^"']+)["']/i)?.[1] ?? '');
  return Number.isFinite(ms) ? isoFromMs(ms) : null;
}

function hrefOf(attrs) {
  const match = String(attrs).match(HREF);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/**
 * Абсолютный URL без конструктора `URL`: в изоляте платформы его НЕТ
 * (замер 2026-10-19: `typeof URL === 'undefined'` — парсер молча отбрасывал все
 * ссылки, и html-источники падали с PARSE при живых 200 и верном HTML).
 */
export function absoluteUrl(href, baseUrl) {
  const raw = String(href ?? '').trim();
  if (!raw || SKIP_HREF.test(raw)) return null;
  const base = parseOrigin(baseUrl);
  if (!base) return null;

  let url;
  if (/^https?:\/\//i.test(raw)) url = raw;
  else if (raw.startsWith('//')) url = `${base.protocol}//${raw.slice(2)}`;
  else if (raw.startsWith('/')) url = `${base.origin}${raw}`;
  else url = `${base.origin}${base.path.replace(/[^/]*$/, '')}${raw}`;

  // Фрагмент отбрасываем, query — СОХРАНЯЕМ: у HN все ссылки вида item?id=…,
  // без query они схлопнулись бы в один адрес и дедуп выбросил бы новости.
  const clean = url.replace(/#.*$/, '');
  const match = clean.match(/^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!match) return null;
  const protocol = `${match[1].toLowerCase()}:`;
  const host = match[2];
  const stack = [];
  for (const segment of (match[3] || '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return `${protocol}//${host}${stack.length ? `/${stack.join('/')}` : '/'}${match[4] ?? ''}`;
}

/** protocol/origin/path из базового адреса — без URL. */
function parseOrigin(baseUrl) {
  const match = String(baseUrl ?? '').match(/^(https?):\/\/([^/?#]+)([^?#]*)/i);
  if (!match) return null;
  const protocol = `${match[1].toLowerCase()}:`;
  return { protocol, origin: `${protocol}//${match[2]}`, path: match[3] || '/' };
}
