#!/usr/bin/env node
// Генерит tgcloud/lib/secrets.js из .env: у платформы нет process.env, единственный
// способ положить ключ — файл в деплое. Файл в git не попадает (.gitignore).
// Секреты не печатаются: только имена и признак «задан».

import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const outPath = join(root, 'tgcloud/lib/secrets.js');

function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    // инлайн-комментарий срезаем (iter-21: load_env в Python это делает так же)
    const value = line.slice(eq + 1).replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    env[key] = value;
  }
  return env;
}

const env = parseEnv(await readFile(envPath, 'utf8').catch(() => ''));
const secrets = {
  allowedChatId: Number(env.TELEGRAM_CHAT_ID) || null,
  llmApiKey: env.LLM_API_KEY ?? '',
  llmBaseUrl: env.LLM_BASE_URL ?? '',
  llmModel: env.LLM_MODEL ?? '',
};

const body = `// СГЕНЕРИРОВАНО scripts/build-config.mjs из .env — в git не попадает, править руками нельзя.
export const SECRETS = ${JSON.stringify(secrets, null, 2)};
`;
await writeFile(outPath, body, 'utf8');
await chmod(outPath, 0o600);

const state = Object.entries(secrets).map(([key, value]) => `${key}=${value ? 'задан' : 'ПУСТО'}`).join(' ');
console.log(`tgcloud/lib/secrets.js: ${state}`);
if (!secrets.llmApiKey) console.warn('LLM_API_KEY пуст: сводка уйдёт в mock-режим');
if (!secrets.allowedChatId) console.warn('TELEGRAM_CHAT_ID пуст: гейт закроет бота для всех (fail-closed)');
