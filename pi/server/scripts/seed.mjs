// Посев источников по интересам (идемпотентно). Запуск: node scripts/seed.mjs
import { loadConfig } from '../src/config.js';
import { seedSources } from '../src/sources-pack.js';
import { ensureUser, openStore } from '../src/store.js';

const config = loadConfig();
if (!config.allowedChatId) {
  console.error('NEWS_CHAT_ID не задан');
  process.exit(1);
}
openStore(config.dbPath);
await ensureUser(config.allowedChatId);
const result = await seedSources(config.allowedChatId);
console.log(JSON.stringify(result, null, 2));
