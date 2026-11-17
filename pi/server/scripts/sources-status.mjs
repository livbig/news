// Здоровье источников через API (база принадлежит службе, прямой доступ не нужен).
// Запуск: node scripts/sources-status.mjs [--errors]
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const base = `http://127.0.0.1:${config.apiPort}`;
const response = await fetch(`${base}/api/sources`, {
  headers: { authorization: `Bearer ${config.apiToken}` },
  signal: AbortSignal.timeout(15_000),
});
const data = await response.json();
const errorsOnly = process.argv.includes('--errors');
const rows = errorsOnly ? data.sources.filter((row) => row.status === 'error') : data.sources;
for (const row of rows) {
  const status = row.status === 'error' ? `ОШИБКА ${row.statusMsg ?? ''}` : 'ок';
  console.log(`${String(row.id).padStart(3)} ${row.kind.padEnd(6)} ${row.enabled ? 'вкл' : 'выкл'} ${row.total}/${row.fresh} ${status.slice(0, 60).padEnd(60)} ${row.title}`);
}
console.log(`\nвсего ${data.sources.length}, ошибок ${data.sources.filter((row) => row.status === 'error').length}, выключено ${data.sources.filter((row) => !row.enabled).length}`);
