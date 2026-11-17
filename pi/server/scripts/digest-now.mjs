// Разовая сводка: --period "за 3 дня" | --no-send | --collect
// Запуск: node scripts/digest-now.mjs [--no-send] [--period "вчера"] [--collect]

import { loadConfig } from '../src/config.js';
import { buildDigest, runDigest } from '../src/digest-service.js';
import { ensureUser, openStore, recordDigest } from '../src/store.js';
import { isoFromMs, isoNow } from '../src/text.js';

const args = process.argv.slice(2);
const periodIndex = args.indexOf('--period');
const period = periodIndex >= 0 ? args[periodIndex + 1] ?? null : null;
const send = !args.includes('--no-send');
const collectFirst = args.includes('--collect');

const config = loadConfig();
if (!config.allowedChatId) {
  console.error('NEWS_CHAT_ID не задан');
  process.exit(1);
}
openStore(config.dbPath);
await ensureUser(config.allowedChatId);

if (!send) {
  const digest = await buildDigest({ chatId: config.allowedChatId, period, collectFirst });
  console.log(digest.text);
  console.log(`\n— пунктов: ${digest.itemCount ?? digest.items?.length ?? 0}, символов: ${digest.text.length}`);
} else {
  const result = await runDigest({ chatId: config.allowedChatId, period, collectFirst, send: true, kind: 'manual' });
  if (result.empty) {
    await recordDigest(config.allowedChatId, {
      periodFrom: isoFromMs(Date.now() - 24 * 60 * 60 * 1000),
      periodTo: isoNow(),
      text: result.digest.text,
      itemIds: [],
      kind: 'manual',
    });
    console.log('пусто: отправлена честная строка, сводки нет');
  } else {
    console.log(JSON.stringify({ digestId: result.digestId, chunks: result.chunks, items: result.digest.itemCount, chars: result.digest.text.length }));
  }
}
