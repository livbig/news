// Вебхук бота: показать состояние или снять (переход на long polling моста).
// Запуск: node scripts/webhook.mjs status|delete
import { loadConfig } from '../src/config.js';
import { deleteWebhook, getMe, getWebhookInfo } from '../src/telegram.js';

const mode = process.argv[2] ?? 'status';
const config = loadConfig();
if (!config.botToken) {
  console.error('NEWS_BOT_TOKEN не задан');
  process.exit(1);
}
const me = await getMe(config.botToken);
console.log(`бот: @${me.username} (${me.id})`);
if (mode === 'delete') {
  await deleteWebhook(config.botToken);
  console.log('вебхук снят — апдейты забирает мост (long polling)');
}
const info = await getWebhookInfo(config.botToken);
console.log(
  JSON.stringify(
    {
      url: info.url || '(нет)',
      pending: info.pending_update_count,
      last_error: info.last_error_message ?? null,
      last_error_date: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
    },
    null,
    2,
  ),
);
