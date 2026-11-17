// Разовая команда: полный сбор + анализ накопленного. Служба при этом не нужна.
// Запуск: node scripts/collect-now.mjs  (env — как у службы, обычно /etc/news/news.env)

import { analyzePending } from '../src/analyze.js';
import { loadConfig } from '../src/config.js';
import { collectNow } from '../src/digest-service.js';
import { ensureUser, openStore } from '../src/store.js';

const config = loadConfig();
if (!config.allowedChatId) {
  console.error('NEWS_CHAT_ID не задан');
  process.exit(1);
}
openStore(config.dbPath);
await ensureUser(config.allowedChatId);

const collected = await collectNow({ chatId: config.allowedChatId });
let analysis = { analyzed: 0, failed: 0 };
for (let round = 0; round < 20; round += 1) {
  const step = await analyzePending({ batch: config.service.analyzeBatch, minAgeMs: 0 });
  analysis.analyzed += step.analyzed;
  analysis.failed += step.failed;
  if (!step.analyzed) break;
}

console.log(
  JSON.stringify(
    {
      sources: collected.sources,
      added: collected.added,
      errors: collected.errors.length,
      partial: collected.partial.length,
      analysis,
      tookSec: Math.round((collected.tookMs ?? 0) / 1000),
    },
    null,
    2,
  ),
);
