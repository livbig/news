// Прямой Bot API: платформа проксирует его своим (мёртвым после ревока) токеном,
// поэтому ответы бота идут напрямую с токеном из secrets.js. Это же снимает
// зависимость от перепривязки приложения в BotFather.

import { fetch } from 'sdk';
import { loadConfig } from './config.js';

export async function botApi(method, body = {}) {
  const config = await loadConfig();
  if (!config.botToken) throw new Error('BOT_TOKEN не задан: node scripts/build-config.mjs из .env');
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(`telegram ${method}: ${data.error_code ?? response.status} ${data.description ?? ''}`.trim());
  return data.result;
}
