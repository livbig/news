/**
 * Живой тест моста в реальном чате: локальный прокси к api.telegram.org, который подменяет
 * только getUpdates. Всё остальное (sendMessage, editMessageText) уходит в настоящий Telegram.
 *
 * Зачем: Telegram не даёт ботам слать сообщения от имени человека, поэтому «сообщение владельца»
 * подкладывается синтетическим апдейтом, а всё после него — настоящее.
 */

import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const UPSTREAM = 'https://api.telegram.org';
const UPDATES_FILE = process.argv[2] ?? '/tmp/live-test/updates.json';
const LOG_FILE = process.argv[3] ?? '/tmp/live-test/calls.log';
const PORT = Number(process.argv[4] ?? 8899);

let served = 0;

function log(line) {
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    /* лог не критичен */
  }
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const match = new RegExp('^/bot([^/]+)/([A-Za-z]+)$').exec(new URL(req.url, 'http://x').pathname);
  if (!match) {
    res.writeHead(404).end('no');
    return;
  }
  const [, token, method] = match;

  if (method === 'getUpdates') {
    let queue = [];
    try {
      queue = JSON.parse(readFileSync(UPDATES_FILE, 'utf8'));
    } catch {
      queue = [];
    }
    const batch = queue.slice(served);
    served += batch.length;
    log(`getUpdates → отдано ${batch.length}`);
    if (!batch.length) await new Promise((resolve) => setTimeout(resolve, 500));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: batch.map((update, index) => ({ update_id: 900_000 + served - batch.length + index, ...update })) }));
    return;
  }

  const upstream = await fetch(`${UPSTREAM}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body.length ? body : undefined,
  });
  const payload = await upstream.text();
  try {
    const parsed = JSON.parse(payload);
    const id = parsed?.result?.message_id;
    const text = (() => {
      try {
        return JSON.parse(body.toString('utf8')).text ?? '';
      } catch {
        return '';
      }
    })();
    log(`${method} → ${id ?? '—'} ${String(text).slice(0, 40).replace(/\n/g, ' ')}`);
  } catch {
    /* ответ не JSON — просто проксируем */
  }
  res.writeHead(upstream.status, { 'content-type': 'application/json' });
  res.end(payload);
});

server.listen(PORT, '127.0.0.1', () => console.log(`proxy: ${PORT}`));
