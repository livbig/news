#!/usr/bin/env node
// Локальный предпросмотр сводки без Telegram и платформенной БД.
// Берёт реальные заголовки из news.db (архив Python-контура), прогоняет новый
// отбор и веер, пишет текст в digests/preview-*.txt. Секреты не печатает.
//
//   node scripts/preview-digest.mjs            # веер, 100 пунктов
//   node scripts/preview-digest.mjs --single   # один вызов на 8000 токенов
//   node scripts/preview-digest.mjs --limit 60 # меньше пунктов

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeWith } from '../_archive/tgcloud-2026-11-16/tgcloud/lib/llm-core.js';
import { summarizeDigest } from '../_archive/tgcloud-2026-11-16/tgcloud/lib/digest-run.js';
import { SETTINGS } from '../_archive/tgcloud-2026-11-16/tgcloud/lib/settings.js';
import { chunkMessage, isoFromMs, isoNow } from '../_archive/tgcloud-2026-11-16/tgcloud/lib/text.js';
import { composeDigest, periodHeader, rowsInRecent, selectPending } from '../_archive/tgcloud-2026-11-16/tgcloud/lib/digest.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
  const text = line.trim();
  if (!text || text.startsWith('#')) continue;
  const eq = text.indexOf('=');
  if (eq < 0) continue;
  env[text.slice(0, eq).trim()] = text.slice(eq + 1).replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}
const config = {
  llm: {
    apiKey: env.LLM_API_KEY,
    baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com/anthropic',
    model: env.LLM_MODEL || 'deepseek-flash',
    thinking: { type: 'enabled' },
    effort: 'low',
    attempts: 1,
    retryPauseMs: 0,
  },
  digest: SETTINGS.digest,
};
if (!config.llm.apiKey) throw new Error('LLM_API_KEY пуст: заполни .env');

const toIso = (value) => {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? isoFromMs(ms) : null;
};

const limit = Number(value('--limit', 120));
const long = flag('--long');
const filler = long ? ' Участники рынка обсуждают доходности, валюты и потоки капитала; аналитики приводят оценки, сценарии и ближайшие триггеры.'.repeat(5) : '';
const raw = execFileSync('sqlite3', ['-json', join(root, 'news.db'), `select id, title, url, category, source, published, fetched_at from articles order by id desc limit ${limit};`], { encoding: 'utf8' });
const sourceIds = new Map();
const rows = JSON.parse(raw || '[]').map((record) => {
  if (!sourceIds.has(record.source)) sourceIds.set(record.source, sourceIds.size + 1);
  return {
    id: Number(record.id),
    sourceId: sourceIds.get(record.source),
    title: record.title,
    url: record.url,
    gist: `Категория: ${record.category}; источник: ${record.source}.${filler}`,
    published: toIso(record.published) ?? toIso(record.fetched_at) ?? isoNow(),
    fetchedAt: toIso(record.fetched_at) ?? isoNow(),
  };
});

// В архиве нет «сегодня»: окно ставим вокруг самой свежей записи, иначе 24 часа
// от реального now дадут пустой срез.
const now = Math.max(...rows.map((row) => Date.parse(row.fetchedAt))) + 60_000;
const fresh = rowsInRecent(rows, now - 24 * 60 * 60 * 1000);
const { selected, chars } = selectPending(fresh, {
  perSource: 8,
  maxItems: Number(value('--items', 100)),
  maxChars: 120000,
});
if (!selected.length) throw new Error('в news.db нет свежих пунктов для предпросмотра');

const single = flag('--single');
const budget = { ...SETTINGS.inline, fanout: { ...SETTINGS.inline.fanout, enabled: SETTINGS.inline.fanout.enabled && !single } };
const calls = [];
const started = Date.now();
const summarize = async (itemsText, interests, progress, options) => {
  const t0 = Date.now();
  const kind = itemsText.includes('Ниже весь поток') ? 'editor' : itemsText.includes('Напиши ТОЛЬКО разделы') ? 'part' : 'single';
  try {
    const text = await summarizeWith({ http: fetch, config, itemsText, interests, ...options });
    calls.push({ kind, ms: Date.now() - t0, chars: text.length });
    return text;
  } catch (error) {
    calls.push({ kind, ms: Date.now() - t0, chars: String(error?.partial ?? '').length, error: String(error?.message ?? error).slice(0, 120) });
    throw error;
  }
};
const generated = await summarizeDigest({
  selected,
  interestsText: 'Глубоко: драгметаллы, валюты, рынок США, AI, IPO. Кратко: макро, геополитика, крипта.',
  config,
  budget,
  caps: { maxTokens: budget.maxTokens },
  left: () => 27000,
  summarize,
});
const text = composeDigest({
  header: periodHeader(isoFromMs(now - 24 * 60 * 60 * 1000), isoFromMs(now), 180),
  summary: generated.note ? `${generated.text}\n\n${generated.note}` : generated.text,
  capText: 'показаны новости за последние сутки — более старое не берётся',
});
const chunks = chunkMessage(text, 4000);
const forbidden = text.match(/<(?!\/?(?:a|b|i)\b)[^>]+>/gi) ?? [];
mkdirSync(join(root, 'digests'), { recursive: true });
const outPath = join(root, 'digests', `preview-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
writeFileSync(outPath, `${text}\n`, 'utf8');

console.log(JSON.stringify({
  mode: single ? 'single' : 'fanout',
  freshRows: fresh.length,
  selected: selected.length,
  used: generated.items.length,
  inputChars: chars,
  calls,
  totalMs: Date.now() - started,
  outputChars: text.length,
  chunks: chunks.length,
  chunkSizes: chunks.map((chunk) => chunk.length),
  forbiddenTags: forbidden.slice(0, 5),
  file: outPath,
}, null, 2));
console.log('\n--- первые 1200 символов ---\n');
console.log(text.slice(0, 1200));
