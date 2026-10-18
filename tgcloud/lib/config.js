// Конфигурация рантайма: настройки (settings.js) + секреты (secrets.js, gitignored).
// У платформы нет process.env — единственный способ положить ключ — файл в деплое,
// поэтому секреты генерируются scripts/build-config.mjs и не попадают в git
// (рабочий паттерн perimetr/assistant, см. docs/tgcloud-migration.md §1).

import { SETTINGS } from './settings.js';

let cached = null;

/** Ленивая загрузка: модуль secrets.js может отсутствовать (тесты, dev) — тогда mock-режим. */
export async function loadConfig() {
  if (cached) return cached;
  let secret = {};
  try {
    // Относительный импорт с .js — обязательное правило платформы.
    secret = (await import('./secrets.js')).SECRETS ?? {};
  } catch {
    console.warn('secrets.js не найден: LLM и chat_id не настроены, сводка в mock-режиме (NFR-05)');
  }
  cached = {
    allowedChatId: Number(secret.allowedChatId) || null,
    llm: {
      ...SETTINGS.llm,
      apiKey: secret.llmApiKey ?? '',
      baseUrl: secret.llmBaseUrl ?? SETTINGS.llm.baseUrl,
      model: secret.llmModel ?? SETTINGS.llm.model,
    },
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
