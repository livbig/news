// Отбор пунктов в промпт: читает БД платформы, отдаёт готовый вход + id для фиксации.
// Возвращает JSON-СТРОКУ: CLI печатает `< "..."`, воркер парсит один раз.
import { digestWindow, formatItemsInput, selectPending } from '../lib/digest.js';
import { loadConfig } from '../lib/config.js';
import { consumedKeys, getInterests, getLastSentAt, pendingRows, setJob } from '../lib/store.js';
import { isoFromMs, isoNow } from '../lib/text.js';

export default async function select(input = {}) {
  const chatId = Number(input.chatId);
  if (!chatId) throw new Error('select: нужен chatId');
  const config = await loadConfig();
  const lastSentAt = await getLastSentAt(chatId);
  const window = digestWindow({
    nowMs: Date.now(),
    lastSentAt,
    windowDays: config.digest.windowDays,
    firstWindowHours: config.digest.firstWindowHours,
  });
  const rows = await pendingRows(chatId, window.fromMs);
  const consumed = await consumedKeys(chatId);
  const { selected } = selectPending(rows, {
    perSource: config.digest.perSource,
    maxItems: config.digest.maxItems,
    maxChars: Math.min(config.digest.maxChars, 200000), // воркер передаёт вход строкой
    consumedUrls: consumed.urls,
    consumedTitles: consumed.titles,
  });
  if (input.jobId) await setJob(Number(input.jobId), { stage: 'selected', detail: `${selected.length} пунктов` });
  return JSON.stringify({
    count: selected.length,
    ids: selected.map((row) => row.id),
    itemsText: selected.length ? formatItemsInput(selected, config.digest.textCap) : '',
    interests: await getInterests(chatId),
    periodFrom: isoFromMs(window.fromMs),
    periodTo: isoNow(),
    capped: window.capped,
  });
}
