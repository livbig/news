#!/usr/bin/env node
// Проверка привязки без печати секретов: токен бота (Bot API) + CLI-токен (платформа).
// Запуск: node scripts/verify-link.mjs
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mask = (value) => (value ? `${value.slice(0, Math.min(value.length, 6))}…${value.slice(-2)} (${value.length})` : '—');

async function read(path) {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

const botToken = await read(join(root, '.secrets/bot-token.txt'));
const patch = (line) => console.log(line);

patch('== токен бота (.secrets/bot-token.txt) ==');
if (!botToken || botToken.startsWith('ВСТАВЬТЕ')) {
  patch('  ✗ не задан — BotFather → бот → API Token (Revoke, чтобы получить новый)');
} else {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await response.json();
    patch(data.ok
      ? `  ✓ живой: @${data.result.username} (id ${data.result.id}), токен ${mask(botToken)}`
      : `  ✗ Bot API отверг: ${data.error_code} ${data.description}`);
    if (data.ok) {
      // Кто сейчас владеет вебхуком: платформа ставит его сама, ручная правка ломает приём апдейтов.
      const info = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`).then((r) => r.json());
      patch(`  вебхук: ${info.result?.url || '(не установлен)'}${info.result?.last_error_message ? ` — последняя ошибка: ${info.result.last_error_message}` : ''}`);
    }
  } catch (error) {
    patch(`  ? Bot API недоступен с этой машины (${error.message}) — нужен VPN; проверю с Pi/платформы`);
  }
}

patch('== привязка проекта (.tgcloud/credentials) ==');
const credPath = join(root, '.tgcloud/credentials');
if (!existsSync(credPath)) {
  patch('  ✗ файла нет');
} else {
  const parsed = JSON.parse(await read(credPath));
  const token = parsed?.token ?? '';
  const ok = /^app\d+:[A-Za-z0-9_-]+$/.test(token);
  patch(`  ${ok ? '✓' : '✗'} формат ${ok ? 'верный' : 'неверный (нужно app<id>:<secret>)'}, токен ${mask(token)}`);
  const appId = token.split(':')[0];
  const call = (path) => fetch(`https://cloud.telegram.org/${appId}/manage${path}`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const state = await call('/get');
    patch(state.ok ? '  ✓ платформа приняла CLI-токен' : `  ✗ платформа ответила ${state.status}`);
    // /webhook ходит в Bot API токеном бота: именно здесь видно, живой ли он на стороне платформы.
    const webhook = await call('/webhook');
    const body = await webhook.json().catch(() => ({}));
    patch(body.ok
      ? `  ✓ вебхук платформы: ${body.result?.url || '(нет)'}`
      : `  ✗ платформа не может достучаться до Bot API: ${body.error_type ?? body.description ?? webhook.status} — токен бота на её стороне мёртв`);
  } catch (error) {
    patch(`  ? платформа недоступна (${error.message})`);
  }
}
