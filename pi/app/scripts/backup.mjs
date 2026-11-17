// Ночной бэкап: база новостей (sqlite backup API), правила зоны, настройки pi.
// Хранит 14 дней; манифест с размерами — чтобы «бэкап есть» проверялось, а не предполагалось.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = '/srv/news';
const KEEP_DAYS = 14;
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const dir = join(ROOT, 'backups', stamp);
mkdirSync(dir, { recursive: true, mode: 0o700 });

const dbPath = join(ROOT, 'data', 'news.db');
if (existsSync(dbPath)) {
  const source = new DatabaseSync(dbPath);
  source.exec(`VACUUM INTO '${join(dir, 'news.db')}'`);
  source.close();
}

for (const relative of [['users/livbig/work/AGENTS.md', 'zone-AGENTS.md'], ['users/livbig/pi/settings.json', 'zone-pi-settings.json']]) {
  const from = join(ROOT, relative[0]);
  if (existsSync(from)) cpSync(from, join(dir, relative[1]));
}

// Память и история чата агента: в них опыт зоны («не присылай про крипту», разборы прошлых сводок),
// а в news.db их нет — без этих двух копий бэкап терял то, что дороже всего.
const zoneMemory = join(ROOT, 'users', 'livbig', 'memory.db');
if (existsSync(zoneMemory)) {
  const memory = new DatabaseSync(zoneMemory);
  memory.exec(`VACUUM INTO '${join(dir, 'zone-memory.db')}'`);
  memory.close();
}
const zoneSessions = join(ROOT, 'users', 'livbig', 'pi', 'sessions');
if (existsSync(zoneSessions)) cpSync(zoneSessions, join(dir, 'zone-sessions'), { recursive: true });

const manifest = readdirSync(dir).map((file) => ({ file, bytes: statSync(join(dir, file)).size }));
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ stamp, files: manifest }, null, 2));

// Уборка старых архивов.
const backups = join(ROOT, 'backups');
for (const name of readdirSync(backups)) {
  const full = join(backups, name);
  if (full === dir) continue;
  const ageDays = (Date.now() - statSync(full).mtimeMs) / 86_400_000;
  if (ageDays > KEEP_DAYS) rmSync(full, { recursive: true, force: true });
}

console.log(`бэкап ${stamp}: ${manifest.map((row) => `${row.file} ${row.bytes}`).join(', ')}`);
try {
  console.log(execFileSync('du', ['-sh', dir], { encoding: 'utf8' }).trim());
} catch {
  /* du не обязателен */
}
