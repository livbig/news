// Удалить последний отправленный факт дня: id сообщений служба пишет в состояние
// (fact_last_message_ids, fact_last_photo_id) — бот может удалять только свои сообщения
// и только по id, поэтому без этой записи удаление невозможно.
import { loadConfig } from '../src/config.js';
import { getState, openStore } from '../src/store.js';
import { deleteMessages } from '../src/telegram.js';

const config = loadConfig();
openStore(config.dbPath);
const ids = [];
const photo = Number(getState('fact_last_photo_id') ?? 0);
if (Number.isFinite(photo) && photo > 0) ids.push(photo);
try {
  for (const id of JSON.parse(getState('fact_last_message_ids') ?? '[]')) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
} catch {
  /* состояние битое — просто пропускаем */
}
if (!ids.length) {
  console.log('нечего удалять: id последнего факта в состоянии нет');
  process.exit(0);
}
await deleteMessages(config.allowedChatId, ids);
console.log(`удалено сообщений: ${ids.length} (${ids.join(', ')})`);
