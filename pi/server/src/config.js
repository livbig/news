// Конфигурация службы на Pi: окружение (systemd EnvironmentFile) + настройки по умолчанию.
// Токен и ключи не печатаются и не пишутся в git: они живут в /etc/news/news.env (600).

import { SETTINGS } from './settings.js';

const int = (raw, fallback) => {
  const text = String(raw ?? '').trim();
  if (!text) return fallback; // пустая переменная — это «не задано», а не ноль
  const value = Number(text);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
};

let cached = null;

/** LLM_THINKING: либо слово (enabled/disabled/adaptive), либо JSON-объект целиком. */
function parseThinking(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return { type: text };
}

export function loadConfig(env = process.env) {
  if (cached && env === process.env) return cached;

  const sendTimes = String(env.NEWS_DIGEST_TIMES ?? '09:00,21:00')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d{1,2}:\d{2}$/.test(part))
    .map((part) => part.padStart(5, '0'));

  const factTimes = String(env.NEWS_FACT_TIMES ?? '12:00')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d{1,2}:\d{2}$/.test(part))
    .map((part) => part.padStart(5, '0'));

  const config = {
    botToken: String(env.NEWS_BOT_TOKEN ?? env.TELEGRAM_TOKEN ?? '').trim(),
    allowedChatId: Number(env.NEWS_CHAT_ID ?? env.TELEGRAM_CHAT_ID ?? 0) || null,
    dbPath: env.NEWS_DB?.trim() || '/srv/news/data/news.db',
    apiPort: int(env.NEWS_API_PORT, 8097),
    apiHost: env.NEWS_API_HOST?.trim() || '127.0.0.1',
    apiToken: String(env.NEWS_API_TOKEN ?? '').trim(),
    llm: {
      ...SETTINGS.llm,
      apiKey: String(env.LLM_API_KEY ?? '').trim(),
      baseUrl: env.LLM_BASE_URL?.trim() || SETTINGS.llm.baseUrl,
      model: env.LLM_MODEL?.trim() || SETTINGS.llm.model,
      effort: env.LLM_EFFORT?.trim() || SETTINGS.llm.effort,
      maxTokens: int(env.LLM_MAX_TOKENS, SETTINGS.llm.maxTokens),
      thinking: parseThinking(env.LLM_THINKING) ?? SETTINGS.llm.thinking,
    },
    digest: SETTINGS.digest,
    collect: SETTINGS.collect,
    retention: SETTINGS.retention,
    sources: SETTINGS.sources,
    tz: { offsetMin: int(env.NEWS_TZ_OFFSET_MIN ?? env.TZ_OFFSET_MIN, SETTINGS.tz.offsetMin) },
    inline: SETTINGS.inline,
    service: {
      ...SETTINGS.service,
      collectIntervalMin: int(env.NEWS_COLLECT_INTERVAL_MIN, SETTINGS.service.collectIntervalMin),
      analyzeBatch: int(env.NEWS_ANALYZE_BATCH, SETTINGS.service.analyzeBatch),
      analyzeEveryMin: int(env.NEWS_ANALYZE_EVERY_MIN, SETTINGS.service.analyzeEveryMin),
      maxPagesPerChannel: int(env.NEWS_MAX_PAGES_PER_CHANNEL, SETTINGS.service.maxPagesPerChannel),
    },
    sendTimes: sendTimes.length ? sendTimes : ['09:00', '21:00'],
    // Метка самоперезапуска: touch файла → служба выходит, systemd поднимает её с новым кодом.
    restartStamp: env.NEWS_RESTART_STAMP?.trim() || 'restart.request',
    // Ежедневный «факт дня» про роботов и Physical AI: своё время, отдельно от сводок.
    factTimes: factTimes.length ? factTimes : ['12:00'],
    factEnabled: String(env.NEWS_FACT_ENABLED ?? '1') !== '0',
    // Опоздавший факт не отправляем: после окна он превращается в «сообщение не в срок».
    factCatchUpMin: int(env.NEWS_FACT_CATCHUP_MIN, 15),
    logLevel: env.NEWS_LOG?.trim() || 'info',
  };
  // Сбор идёт фоном, платформенного дедлайна нет: страницы каналов читаем полностью.
  config.collect = { ...config.collect, maxPagesPerChannel: config.service.maxPagesPerChannel };
  if (env === process.env) cached = config;
  return config;
}

/** Гейт единственного читателя: нет chat_id — закрыто для всех (fail-closed). */
export function gate(chatId, env = process.env) {
  const config = loadConfig(env);
  return Boolean(config.allowedChatId) && Number(chatId) === config.allowedChatId;
}

export function resetConfigCache() {
  cached = null;
}
