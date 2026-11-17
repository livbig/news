/**
 * Текстовый лог рядом с данными (`/srv/assistant/data/logs/bridge-YYYY-MM-DD.txt`) — дополнение к journald:
 * journald ротирует и страхует systemd, но не даёт «прочитать день файлом». Файл на сутки,
 * старше `keepDays` удаляются. Секреты и ПДн маскируются, длинные тексты обрезаются до 120 символов:
 * телефон и почта клиента в лог не попадают (требование владельца 29.10.2026).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { redactPii, redactSecrets } from './mask.js';

export const TEXT_LIMIT = 120;
export const KEEP_DAYS = 14;

/** Одна строка, без переносов, не длиннее лимита. */
export function clip(value, limit = TEXT_LIMIT) {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

/** Удалить файлы этого лога старше keepDays суток (по дате в имени). */
export function pruneLogs(dir, name, { now = new Date(), keepDays = KEEP_DAYS } = {}) {
	const limit = new Date(now).getTime() - keepDays * 86_400_000;
	let names = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const removed = [];
	for (const file of names) {
		const match = file.match(new RegExp(`^${name}-(\\d{4}-\\d{2}-\\d{2})\\.txt$`));
		if (!match) continue;
		if (Date.parse(`${match[1]}T00:00:00Z`) < limit) {
			rmSync(join(dir, file), { force: true });
			removed.push(file);
		}
	}
	return removed;
}

/**
 * Лог моста: `textLog.info('вход: …')`. Пишем только на диск — journald уже получает тот же поток
 * через консоль, дублировать туда не нужно.
 */
export function createTextLog({ dir, name = 'bridge', keepDays = KEEP_DAYS, now = () => new Date(), log } = {}) {
	const append = (level, message) => {
		if (!dir) return undefined;
		const at = now();
		const file = join(dir, `${name}-${dayOf(at)}.txt`);
		try {
			mkdirSync(dir, { recursive: true });
			// Первая запись суток — повод убрать просроченное: чаще незачем, файлов немного.
			if (!existsSync(file)) pruneLogs(dir, name, { now: at, keepDays });
			const line = `${at.toISOString()} [${level}] ${clip(redactPii(redactSecrets(message)))}\n`;
			appendFileSync(file, line);
			return line;
		} catch (error) {
			// Лог не должен ронять мост: сбой записи виден в journald.
			log?.warn(`txt-лог ${file}: ${error.message}`);
			return undefined;
		}
	};
	return {
		dir,
		append,
		info: (message) => append('info', message),
		warn: (message) => append('warn', message),
		error: (message) => append('error', message),
	};
}
