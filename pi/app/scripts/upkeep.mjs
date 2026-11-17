// Уборка: старые сессии pi, ротация логов, мусор в outbox старше недели.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/srv/news';
const TTL_SESSIONS_DAYS = 10;
const TTL_OUTBOX_DAYS = 7;

function sweep(dir, ttlDays, { filesOnly = false } = {}) {
  let removed = 0;
  let bytes = 0;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed, bytes };
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (filesOnly && stat.isDirectory()) continue;
    const ageDays = (Date.now() - stat.mtimeMs) / 86_400_000;
    if (ageDays < ttlDays) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      removed += 1;
      bytes += stat.size ?? 0;
    } catch {
      /* занято — в следующий раз */
    }
  }
  return { removed, bytes };
}

const sessions = sweep(join(ROOT, 'users/livbig/pi/sessions'), TTL_SESSIONS_DAYS);
const logs = sweep(join(ROOT, 'logs'), 30, { filesOnly: true });
const outbox = sweep(join(ROOT, 'users/livbig/work/files/outbox'), TTL_OUTBOX_DAYS, { filesOnly: true });

console.log(`уборка: сессий ${sessions.removed} (${Math.round(sessions.bytes / 1024)} КБ), логов ${logs.removed}, outbox ${outbox.removed}`);
