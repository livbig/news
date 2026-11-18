// Сбор новостей (замена bot/collect.py): rss/atom, t.me/s, twitter-мост (это тоже RSS).
// Сбор идёт по запросу пользователя — cron у платформы нет (R2).
// Изоляция отказов (NFR-02): сбой источника не валит остальные.

import { getText, sleep } from './http.js';
import { parseFeed, looksLikeFeed } from './rss.js';
import { parseChannelPage } from './tgparse.js';
import { parseHtmlList } from './html.js';
import { loadConfig } from './config.js';
import { insertItem, setSourceStatus } from './store.js';

/**
 * @param {{id:number, kind:string, url:string}[]} sources
 * @returns {Promise<{added:number, errors:{url:string,error:string}[], partial:{url:string,reason:string}[]}>}
 */
export async function collectAll(sources, { deadlineMs = 0, retries = null } = {}) {
  const deadline = deadlineMs ? Date.now() + deadlineMs : 0;
  const config = await loadConfig();
  if (retries) config.collect = { ...config.collect, retries };
  const errors = [];
  const partial = [];
  let added = 0;
  // Каналы — первыми и строго последовательно (как bot/collect.py): параллельные
  // запросы к t.me/зеркалу ловят 429 и валят все каналы разом.
  const channels = sources.filter((row) => row.kind === 'tgweb');
  const feeds = sources.filter((row) => row.kind !== 'tgweb');

  // Сначала быстрые фиды (успевают всегда), потом каналы с остатком бюджета:
  // если канал не влез по времени, новости из фидов всё равно в сводке.
  await runPool(feeds, Math.max(1, Math.min(config.collect.workers, feeds.length || 1)));
  await runPool(channels, 1);

  async function runPool(list, workers) {
    const queue = [...list];
    await Promise.all(
      Array.from({ length: Math.max(1, workers) }, async () => {
      for (;;) {
        const source = queue.shift();
        if (!source) return;
        if (deadline && Date.now() > deadline) {
          partial.push({ url: source.url, reason: 'нехватка времени' });
          continue;
        }
        try {
          const result = await collectOne(source, config);
          added += result.added;
          if (result.partial) partial.push({ url: source.url, reason: result.partial });
          if (result.added > 0 || source.status !== 'ok') await setSourceStatus(source.id, 'ok', `ok: +${result.added}`);
        } catch (error) {
          const code = error?.code ?? 'ERROR';
          const message = `${code} ${String(error?.message ?? error).slice(0, 160)}`;
          errors.push({ url: source.url, error: message });
          await setSourceStatus(source.id, 'error', `[${code}] ${String(error?.message ?? error).slice(0, 160)}`).catch(() => {});
          console.warn(`FAIL ${source.url} [${code}]`);
        }
      }
      }),
    );
  }
  return { added, errors, partial };
}

async function collectOne(source, config) {
  if (source.kind === 'tgweb') return collectChannel(source, config);
  if (source.kind === 'rss' || source.kind === 'twitter') return collectFeed(source, config);
  if (source.kind === 'html') return collectHtmlList(source, config);
  return { added: 0 };
}

/** Страница-список без фида: пункты разбирает html.js (≤40 на источник), дедуп — в insertItem. */
async function collectHtmlList(source, config) {
  const page = await getText(source.url, { retries: config.collect.retries });
  // CPU-бюджет вызова ~3 с: страницы в 1.4 МБ (Yahoo) съедают его разбором.
  // Разбираем первые 800 КБ — списки новостей всегда в начале документа.
  const html = page.length > 800000 ? page.slice(0, 800000) : page;
  const entries = parseHtmlList(html, { baseUrl: source.url });
  // Пустой список — это сбой разбора, а не «новостей нет»: иначе источник молча пропадает.
  if (!entries.length) throw Object.assign(new Error('на странице не найдено ссылок-заголовков'), { code: 'PARSE' });
  let added = 0;
  for (const entry of entries) {
    if (await insertItem(source.id, entry)) added += 1;
  }
  return { added };
}

async function collectFeed(source, config) {
  const body = await getText(source.url, { retries: config.collect.retries });
  if (!looksLikeFeed(body)) throw Object.assign(new Error('не похоже на RSS/Atom'), { code: 'PARSE' });
  const entries = parseFeed(body);
  let added = 0;
  for (const entry of entries) {
    if (await insertItem(source.id, entry)) added += 1;
  }
  return { added };
}

/** Зеркало публичных каналов в RSS: t.me недоступен с площадок датацентров
 * (замер 2026-10-19: на платформе 4/4 канала NETWORK, локально — ок). */
const TG_MIRROR = 'https://tg.i-c-a.su/rss/';

async function collectChannelViaMirror(source, config) {
  const channel = String(source.url).replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').replace(/^s\//, '').replace(/\/.*$/, '');
  const body = await getText(`${TG_MIRROR}${channel}`, { retries: 1 });
  if (!looksLikeFeed(body)) throw Object.assign(new Error('зеркало отдало не RSS'), { code: 'PARSE' });
  let added = 0;
  for (const entry of parseFeed(body)) {
    if (await insertItem(source.id, entry)) added += 1;
  }
  return { added, partial: 'канал собран через RSS-зеркало (t.me недоступен с платформы)' };
}

async function collectChannel(source, config) {
  try {
    return await collectChannelDirect(source, config);
  } catch (error) {
    console.warn(`t.me недоступен (${error?.code ?? error?.name}), пробую зеркало: ${source.url}`);
    return collectChannelViaMirror(source, config);
  }
}

async function collectChannelDirect(source, config) {
  const channel = String(source.url).replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').replace(/^s\//, '').replace(/\/.*$/, '');
  let before = null;
  let added = 0;
  let pages = 0;
  let oldestSeen = null;
  const seenIds = new Set();
  while (pages < config.collect.maxPagesPerChannel) {
    const url = before ? `https://t.me/s/${channel}?before=${before}` : `https://t.me/s/${channel}`;
    const html = await getText(url, { retries: config.collect.retries });
    const page = parseChannelPage(html, channel);
    if (!page.items.length) break;
    pages += 1;
    let freshOnPage = 0;
    for (const item of page.items) {
      if (seenIds.has(item.postId)) continue;
      seenIds.add(item.postId);
      if (await insertItem(source.id, item)) {
        added += 1;
        freshOnPage += 1;
      }
    }
    oldestSeen = page.minId;
    // Дошли до уже собранного поста — глубже не листаем (как last_post_id в Python-версии).
    if (freshOnPage === 0) break;
    if (page.minId == null) break;
    before = page.minId;
    await sleep(config.collect.pauseMs);
  }
  const partial = pages >= config.collect.maxPagesPerChannel
    ? `история дальше ${config.collect.maxPagesPerChannel} страниц не запрашивается (самый старый пост ${oldestSeen ?? '?'})`
    : null;
  return { added, partial };
}
