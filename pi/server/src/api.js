// HTTP-интерфейс службы: фронтенд и инструменты pi-агента ходят сюда.
// Один писатель в базу (сама служба) — поэтому сеть и база не расходятся.
// Доступ: токен в заголовке Authorization: Bearer или в ?token= (браузер).

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { loadConfig } from './config.js';
import { analyzePending } from './analyze.js';
import { buildDigest, collectNow, runDigest } from './digest-service.js';
import { nextSlot } from './scheduler.js';
import {
  addInterestSources,
  addSource,
  analyzeStats,
  deleteSource,
  getDigest,
  getInterests,
  getState,
  listDigests,
  listSources,
  removeInterest,
  searchItems,
  setInterests,
  setSourceEnabled,
  sourceCounts,
  stats,
} from './store.js';
import { addInterestTerms, parseInterests } from './interests.js';
import { isoNow } from './text.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function kindForUrl(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return null;
  if (url.startsWith('@') || /^https?:\/\/t\.me\//i.test(url)) return 'tgweb';
  if (/\.(rss|xml|atom)(\?.*)?$/i.test(url) || /\/(rss|feed)(\/|\?|$)/i.test(url)) return 'rss';
  // hnrss.org отдаёт ленту по адресу /newest?q=… — суффикса .rss в URL нет.
  if (/^https?:\/\/hnrss\.org\//i.test(url)) return 'rss';
  // hnrss.org отдаёт ленту по адресу /newest?q=… — суффикса .rss в URL нет.
  if (/^https?:\/\/hnrss\.org\//i.test(url)) return 'rss';
  return 'html';
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** Токен — только в заголовке и сравнение по времени.
 *  В query он попадал в историю браузера, Referer и журналы прокси; фронтенд шлёт заголовок. */
function authorized(req, token) {
  if (!token) return true; // без токена служба слушает только 127.0.0.1 — режим разработки
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req, limitBytes = 200_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('слишком большое тело запроса'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('тело запроса — не JSON'), { status: 400 });
  }
}

export function createApi({ chatId, log = console.log, port = null, host = null, token = null }) {
  const config = loadConfig();
  const listenPort = port ?? config.apiPort;
  const listenHost = host ?? config.apiHost;
  const apiToken = token ?? config.apiToken;
  const webRoot = join(import.meta.dirname, 'web');
  // Без токена — только loopback (как в режиме разработки). На 0.0.0.0 без токена не выходим:
  // потерянная строка NEWS_API_TOKEN иначе открывает сводки и траты LLM всей локальной сети.
  if (!apiToken && listenHost !== '127.0.0.1' && listenHost !== 'localhost') {
    throw new Error(`NEWS_API_TOKEN не задан, а служба слушает ${listenHost} — отказ (fail-closed)`);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${listenPort}`);
    try {
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), at: isoNow() });

      // Статика фронтенда — без токена (в ней нет данных), всё под /api/ — по токену.
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const clean = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
        const file = clean === '/' ? 'index.html' : clean.replace(/^\//, '');
        const path = join(webRoot, file);
        if (!path.startsWith(webRoot)) return json(res, 403, { error: 'нет' });
        try {
          const data = await readFile(path);
          res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
          return res.end(data);
        } catch {
          return json(res, 404, { error: 'нет файла' });
        }
      }

      if (!authorized(req, apiToken)) return json(res, 401, { error: 'нужен токен' });

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const tz = config.tz.offsetMin;
        const now = Date.now();
        return json(res, 200, {
          chatId,
          sendTimes: config.sendTimes,
          model: config.llm.model,
          nextSlot: nextSlot({ nowMs: now, times: config.sendTimes, tzOffsetMin: tz }),
          lastCollectAt: getState('last_collect_at'),
          lastAnalyzeAt: getState('last_analyze_at'),
          lastDigestAt: getState('last_digest_at'),
          tzOffsetMin: tz,
          collectIntervalMin: config.service.collectIntervalMin,
          analysis: analyzeStats(),
          stats: await stats(chatId),
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/digests') {
        const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20);
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return json(res, 200, { digests: listDigests(chatId, limit, offset) });
      }

      const digestMatch = url.pathname.match(/^\/api\/digests\/(\d+)$/);
      if (req.method === 'GET' && digestMatch) {
        const row = getDigest(chatId, Number(digestMatch[1]));
        return row ? json(res, 200, { digest: row }) : json(res, 404, { error: 'сводки нет' });
      }

      if (req.method === 'GET' && url.pathname === '/api/sources') {
        return json(res, 200, { sources: sourceCounts(chatId, Date.now() - 7 * DAY_MS) });
      }

      if (req.method === 'POST' && url.pathname === '/api/sources') {
        const body = await readJson(req);
        const kind = body.kind || kindForUrl(body.url);
        if (!body.url || !kind) return json(res, 400, { error: 'нужен url' });
        const title = String(body.title ?? '').trim() || String(body.url).trim();
        const topics = Array.isArray(body.topics) ? body.topics : [];
        const result = await addSource(chatId, { kind, url: String(body.url).trim(), title, topics, origin: 'manual' });
        log(`источник добавлен: ${kind} ${body.url}${result.created ? '' : ' (уже был)'}`);
        return json(res, 200, { ...result, kind });
      }

      const sourceMatch = url.pathname.match(/^\/api\/sources\/(\d+)$/);
      if (sourceMatch && (req.method === 'POST' || req.method === 'DELETE')) {
        const id = Number(sourceMatch[1]);
        if (req.method === 'DELETE') {
          const removed = await deleteSource(id, chatId);
          return removed ? json(res, 200, { removed: true, id }) : json(res, 404, { error: 'нет такого источника' });
        }
        const body = await readJson(req);
        await setSourceEnabled(id, chatId, Boolean(body.enabled));
        return json(res, 200, { id, enabled: Boolean(body.enabled) });
      }

      if (req.method === 'GET' && url.pathname === '/api/interests') {
        const text = (await getInterests(chatId)) ?? '';
        return json(res, 200, { text, terms: parseInterests(text), sources: listSources(chatId).filter((row) => row.origin === 'interest').length });
      }

      if (req.method === 'POST' && url.pathname === '/api/interests') {
        const body = await readJson(req);
        const action = String(body.action ?? 'add');
        const terms = Array.isArray(body.terms) ? body.terms.map((term) => String(term).trim()).filter(Boolean) : [];
        if (action === 'remove') {
          const removed = [];
          for (const term of terms) {
            const result = await removeInterest(chatId, term, false);
            if (result) removed.push(result.term);
          }
          return json(res, 200, { removed, text: (await getInterests(chatId)) ?? '' });
        }
        const current = (await getInterests(chatId)) ?? '';
        const merged = addInterestTerms(current, terms);
        const next = typeof merged === 'string' ? merged : merged.text;
        const saved = await setInterests(chatId, next);
        const created = await addInterestSources(chatId, terms);
        return json(res, 200, saved ? { text: next, created: created.created, existing: created.existing } : { error: 'профиль переполнен (4000 символов)' });
      }

      if (req.method === 'GET' && url.pathname === '/api/stats') {
        return json(res, 200, { stats: await stats(chatId), analysis: analyzeStats(), sources: sourceCounts(chatId, Date.now() - DAY_MS) });
      }

      if (req.method === 'GET' && url.pathname === '/api/search') {
        const query = String(url.searchParams.get('q') ?? '').trim();
        return json(res, 200, { query, results: query ? searchItems(chatId, query, Number(url.searchParams.get('limit')) || 20) : [] });
      }

      if (req.method === 'POST' && url.pathname === '/api/collect') {
        const result = await collectNow({ chatId, log });
        const analysis = await analyzePending({ batch: config.service.analyzeBatch, minAgeMs: 0, log });
        return json(res, 200, { ...result, analysis });
      }

      if (req.method === 'POST' && url.pathname === '/api/digest') {
        const body = await readJson(req);
        const period = body.period ? String(body.period) : null;
        const send = body.send !== false;
        if (!send) {
          const digest = await buildDigest({ chatId, period, profile: body.profile === 'scheduled' ? 'scheduled' : 'manual', collectFirst: Boolean(body.collect), log });
          return json(res, 200, { text: digest.text, items: digest.items?.length ?? 0, chars: digest.chars ?? 0 });
        }
        const result = await runDigest({ chatId, period, collectFirst: Boolean(body.collect), send: true, kind: 'manual', log });
        return json(res, 200, { digestId: result.digestId ?? null, items: result.digest?.items?.length ?? 0, chars: result.digest?.text?.length ?? 0, empty: Boolean(result.empty) });
      }

      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        const body = await readJson(req);
        const result = await analyzePending({ batch: Number(body.batch) || config.service.analyzeBatch, minAgeMs: 0, log });
        return json(res, 200, result);
      }

      return json(res, 404, { error: 'нет метода' });
    } catch (error) {
      const status = Number(error?.status) || 500;
      log(`api: ${req.method} ${url.pathname} → ${error?.stack ?? error}`);
      return json(res, status, { error: String(error?.message ?? error) });
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(listenPort, listenHost, () => {
          log(`API и фронтенд: http://${listenHost}:${server.address().port}/`);
          resolve();
        });
      }),
    address: () => server.address(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}


