// Самоперезапуск без root: мост держит агента в NoNewPrivileges, поэтому sudo/systemctl
// изнутри недоступны. Вместо этого служба следит за меткой-файлом (по умолчанию
// restart.request в рабочем каталоге) и сама выходит, а systemd поднимает её обратно
// (Restart=always, RestartSec=5). Правка кода применяется так: `touch restart.request`.
// Права ядра не расширяются: файл лежит в каталоге службы, а не в /etc.

import { statSync } from 'node:fs';

/** Слепок метки: mtime+размер. Отсутствие файла и его удаление — тоже изменение. */
function stampOf(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

/**
 * Опрос метки (fs.watch на Pi-Ext4 ловит не все правки, а опрос дешёвый — файл один).
 * Стартовое состояние запоминается: уже существующая метка перезапуска не вызывает.
 * @returns {{stop:()=>void}} остановка опроса
 */
export function watchRestartTrigger(file, { onTrigger, intervalMs = 3000, log = () => {} } = {}) {
  let stamp = stampOf(file);
  const timer = setInterval(() => {
    const next = stampOf(file);
    if (next === stamp) return;
    stamp = next;
    // Файл удалили или пересоздали пустым — это всё равно просьба о перезапуске.
    log(`метка перезапуска изменилась (${file}) — выхожу, systemd поднимет службу`);
    onTrigger();
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
