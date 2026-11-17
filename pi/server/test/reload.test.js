// Метка самоперезапуска: стартовая метка молчит, касание — один перезапуск, удаление — тоже.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { watchRestartTrigger } = await import('../src/reload.js');

const dir = mkdtempSync(join(tmpdir(), 'news-reload-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ждём срабатывания не дольше ms: опрос идёт каждые 10 мс. */
async function until(trigger, ms = 500) {
  const started = Date.now();
  while (trigger.count === 0 && Date.now() - started < ms) await sleep(10);
  return trigger.count;
}

function makeTrigger(file) {
  const trigger = { count: 0 };
  trigger.watcher = watchRestartTrigger(file, { onTrigger: () => (trigger.count += 1), intervalMs: 10, log: () => {} });
  return trigger;
}

test('стартовая метка не перезапускает, касание — перезапускает один раз', async () => {
  const file = join(dir, 'start.request');
  writeFileSync(file, 'boot');
  const trigger = makeTrigger(file);
  await sleep(60);
  assert.equal(trigger.count, 0, 'существующая метка при старте молчит');
  // mtime двигаем руками: на быстрой записи mtimeMs может совпасть.
  const now = new Date(Date.now() + 2000);
  utimesSync(file, now, now);
  assert.equal(await until(trigger), 1);
  await sleep(60);
  assert.equal(trigger.count, 1, 'одно касание — один перезапуск');
  trigger.watcher.stop();
});

test('создание и удаление метки тоже перезапускают', async () => {
  const file = join(dir, 'late.request');
  const trigger = makeTrigger(file);
  await sleep(40);
  assert.equal(trigger.count, 0, 'нет файла — нет перезапуска');
  writeFileSync(file, 'go');
  assert.equal(await until(trigger), 1);
  trigger.watcher.stop();

  const second = makeTrigger(file);
  await sleep(40);
  rmSync(file);
  assert.equal(await until(second), 1);
  second.watcher.stop();
});
