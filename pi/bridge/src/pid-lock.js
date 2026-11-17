/**
 * pid-lock демона: второй экземпляр на том же токене получает 409 и теряет сообщения.
 * Файл тот же, что пишет обёртка-расширение (`bridge.pid` рядом с state.json).
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM — процесс есть, но чужой; ESRCH — процесса нет.
		return error?.code === 'EPERM';
	}
}

function readPid(file) {
	try {
		const pid = Number(readFileSync(file, 'utf8').trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Захватывает файл. Существующий pid нашего же процесса — не ошибка: обёртка-расширение
 * успевает записать pid ребёнка раньше, чем ребёнок дойдёт до этой проверки.
 */
export function acquirePidLock(file, pid = process.pid) {
	mkdirSync(dirname(file), { recursive: true });
	try {
		const fd = openSync(file, 'wx');
		try {
			writeSync(fd, `${pid}\n`);
		} finally {
			closeSync(fd);
		}
		return { acquired: true };
	} catch (error) {
		if (error?.code !== 'EEXIST') throw error;
		const existing = readPid(file);
		if (existing === pid) return { acquired: true, shared: true };
		if (isProcessAlive(existing)) return { acquired: false, pid: existing };
		writeFileSync(file, `${pid}\n`, 'utf8');
		return { acquired: true, replaced: existing };
	}
}

/** Удаляет файл, только если в нём наш pid: чужой lock не трогаем. */
export function releasePidLock(file, pid = process.pid) {
	if (readPid(file) === pid) rmSync(file, { force: true });
}
