// Замена feedparser (R5): RSS 2.0 и Atom без DOM, без зависимостей.
// Возвращает нормализованные пункты; битые даты — не повод терять новость.

import { decodeEntities, isoFromMs, isoNow, stripTags } from './text.js';

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function raw(section, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const match = section.match(re);
  return match ? match[1] : '';
}

function text(section, tag) {
  return stripTags(raw(section, tag).replace(CDATA, '$1'));
}

function atomLink(section) {
  const links = [...section.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick =
    links.find((attrs) => /rel\s*=\s*["']alternate["']/i.test(attrs)) ??
    links.find((attrs) => !/rel\s*=/i.test(attrs)) ??
    links[0] ??
    '';
  const href = pick.match(/href\s*=\s*["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]) : '';
}

function rssLink(section) {
  const inner = raw(section, 'link').replace(CDATA, '$1').trim();
  if (inner && !inner.includes('<')) return decodeEntities(inner);
  return atomLink(section);
}

function parseDate(section) {
  const candidates = ['pubDate', 'published', 'updated', 'dc:date', 'date'];
  for (const tag of candidates) {
    const value = text(section, tag);
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return isoFromMs(ms);
  }
  return null;
}

function bodyText(section) {
  for (const tag of ['content:encoded', 'content', 'description', 'summary']) {
    const value = text(section, tag);
    if (value && value.length > 0) return value;
  }
  return '';
}

/**
 * @param {string} xml сырой ответ фида
 * @returns {{title:string, url:string, published:string, text:string}[]}
 */
export function parseFeed(xml) {
  const source = String(xml ?? '');
  const blocks = [...source.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const now = isoNow();
  const out = [];
  for (const block of blocks) {
    const title = text(block, 'title');
    const url = rssLink(block);
    if (!title || !url) continue; // без ссылки пункт бесполезен: сводка всегда со ссылкой
    out.push({ title, url, published: parseDate(block) ?? now, text: bodyText(block).slice(0, 8000) });
  }
  return out;
}

/** Проверка, что ответ вообще похож на фид: HTML-страница ошибки не должна давать пустоту молча. */
export function looksLikeFeed(xml) {
  return /<(rss|feed|rdf:RDF)\b/i.test(String(xml ?? ''));
}
