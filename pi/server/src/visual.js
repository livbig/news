// Визуал к факту дня: схему из текста рисуем в PNG и отправляем картинкой.
// Рисует python3 + Pillow (на Pi стоят) — так визуал есть у каждого дня без внешних картинок.

import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';

const SCRIPT = new URL('../scripts/render_scheme.py', import.meta.url).pathname;

/** Вытащить схему из готового текста факта: первая <pre>-блок → строки. */
export function extractScheme(body) {
  const match = /<pre>([\s\S]*?)<\/pre>/i.exec(String(body ?? ''));
  if (!match) return [];
  const lines = String(match[1])
    .replace(/<[^>]*>/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .slice(0, 6);
  // Пустая схема — та же, что её отсутствие: картинку не рисуем.
  return lines.some((line) => line.trim()) ? lines : [];
}

/** PNG-карточка со схемой. Возвращает Buffer или null, если рендер недоступен. */
export function renderSchemePng({ title, subtitle = '', lines }) {
  if (!lines?.length) return null;
  const payload = JSON.stringify({ title, subtitle, lines });
  const result = spawnSync('python3', [SCRIPT], { input: payload, maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
  if (result.error || result.status !== 0 || !result.stdout?.length) return null;
  return Buffer.from(result.stdout);
}

/** Отправка картинки в чат: sendPhoto через multipart (botApi JSON картинку не умеет). */
export async function sendPhotoBuffer(chatId, buffer, caption = '') {
  const config = loadConfig();
  if (!config.botToken) throw new Error('NEWS_BOT_TOKEN не задан');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', String(caption).slice(0, 900));
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'scheme.png');
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendPhoto`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(`telegram sendPhoto: ${data.error_code ?? response.status} ${data.description ?? ''}`.trim());
  return data.result?.message_id ?? true;
}
