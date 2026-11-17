// Конфигурация рантайма: настройки (settings.js) + секреты (secrets.js, gitignored).
// У платформы нет process.env — единственный способ положить ключ — файл в деплое,
// поэтому секреты генерируются scripts/build-config.mjs и не попадают в git
// (рабочий паттерн perimetr/assistant, см. docs/tgcloud-migration.md §1).

import { SETTINGS } from './settings.js';
// СТАТИЧЕСКИЙ импорт: замер 2026-10-19 — в изоляте платформы `await import('./secrets.js')`
// не резолвится («secrets.js не найден» при задеплоенном файле), поэтому секреты
// подключаются только статически. secrets.js генерится `node scripts/build-config.mjs`
// из .env и в git не попадает (.gitignore).
import { SECRETS } from './secrets.js';

let cached = null;

export async function loadConfig() {
  if (cached) return cached;
  const secret = SECRETS ?? {};
  if (!secret.llmApiKey) console.warn('LLM_API_KEY пуст: сводка уйдёт в mock-режим (NFR-05)');
  cached = {
    botToken: secret.botToken ?? '',
    allowedChatId: Number(secret.allowedChatId) || null,
    llm: {
      ...SETTINGS.llm,
      apiKey: secret.llmApiKey ?? '',
      baseUrl: secret.llmBaseUrl ?? SETTINGS.llm.baseUrl,
      model: secret.llmModel ?? SETTINGS.llm.model,
    },
    inline: SETTINGS.inline,
    digest: SETTINGS.digest,
    collect: SETTINGS.collect,
    retention: SETTINGS.retention,
    sources: SETTINGS.sources,
    tz: SETTINGS.tz,
  };
  return cached;
}

/** Гейт единственного пользователя (D40/критерий 11). Нет chat_id в конфиге —
 * закрыто для всех и громкая ошибка: fail-closed (iter-21). */
export async function gate(chatId) {
  const config = await loadConfig();
  if (!config.allowedChatId) {
    console.error('BOT: TELEGRAM_CHAT_ID не задан — гейт закрыт, бот не отвечает никому');
    return false;
  }
  return Number(chatId) === config.allowedChatId;
}
