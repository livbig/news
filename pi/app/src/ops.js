/**
 * Эксплуатация: снимок баз, архив, уборка, проверка живости. Без фреймворков и зависимостей.
 *
 * Всё лежит внутри HELPER_ROOT, поэтому права делаются один раз на каталог, а не на каждый файл.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function root() {
	return process.env.HELPER_ROOT?.trim() || '/srv/dvoretsky';
}

export function zones(base = root()) {
	const dir = join(base, 'users');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => !name.startsWith('.'))
		.map((slug) => {
			const home = join(dir, slug);
			return {
				slug,
				home,
				memory: join(home, 'memory.db'),
				rules: join(home, 'work', 'AGENTS.md'),
				sessions: join(home, 'pi', 'sessions'),
				data: join(home, 'work', 'files'),
			};
		})
		.filter((zone) => existsSync(zone.home));
}

/** Согласованный снимок SQLite: обычный cp ловит середину записи WAL. */
export function snapshotDb(source, target) {
	if (!existsSync(source)) return false;
	mkdirSync(join(target, '..'), { recursive: true });
	rmSync(target, { force: true });
	const db = new DatabaseSync(source, { readOnly: true });
	try {
		db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
	} finally {
		db.close();
	}
	return true;
}

export function sha256(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function sizeOf(path) {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function pruneOlder(dir, days, { keepExtensions } = {}) {
	if (!existsSync(dir)) return 0;
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	let removed = 0;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		let info;
		try {
			info = statSync(path);
		} catch {
			continue;
		}
		if (!info.isFile()) continue;
		if (keepExtensions && !keepExtensions.some((ext) => name.endsWith(ext))) continue;
		if (info.mtimeMs < cutoff) {
			rmSync(path, { force: true });
			removed += 1;
		}
	}
	return removed;
}

/** Файлы старше срока, но не моложе суток: свежую сессию не трогаем никогда. */
export function pruneSessions(dir, ttlDays) {
	if (!existsSync(dir)) return 0;
	const olderThan = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
	const newestAllowed = Date.now() - 24 * 60 * 60 * 1000;
	let removed = 0;
	for (const name of readdirSync(dir, { recursive: true })) {
		if (!String(name).endsWith('.jsonl')) continue;
		const path = join(dir, String(name));
		try {
			const info = statSync(path);
			if (info.mtimeMs < olderThan && info.mtimeMs < newestAllowed) {
				rmSync(path, { force: true });
				removed += 1;
			}
		} catch {
			// файл исчез — не наша забота
		}
	}
	return removed;
}

/** Архив каталога системным tar: на Pi он есть, своей реализации tar не тащим. */
export function tarGz(sourceDir, targetFile) {
	execFileSync('tar', ['-czf', targetFile, '-C', sourceDir, '.'], { stdio: 'ignore' });
	return targetFile;
}

export function copyZone(zone, target) {
	mkdirSync(target, { recursive: true });
	const files = [];
	if (snapshotDb(zone.memory, join(target, `memory-${zone.slug}.db`))) files.push(`memory-${zone.slug}.db`);
	if (existsSync(zone.rules)) {
		cpSync(zone.rules, join(target, `AGENTS-${zone.slug}.md`));
		files.push(`AGENTS-${zone.slug}.md`);
	}
	if (existsSync(zone.sessions)) {
		cpSync(zone.sessions, join(target, `sessions-${zone.slug}`), { recursive: true });
		files.push(`sessions-${zone.slug}/`);
	}
	// История правок правил: без неё откат «как было» невозможен.
	const history = join(zone.home, 'work', '.history');
	if (existsSync(history)) {
		cpSync(history, join(target, `history-${zone.slug}`), { recursive: true });
		files.push(`history-${zone.slug}/`);
	}
	return files;
}

/** Отправка архива владельцу: необязательная, без токена просто пропускается. */
export async function sendDocumentToOwner(file, caption) {
	const token = process.env.HELPER_BOT_TOKEN?.trim();
	const chatId = process.env.HELPER_ADMIN_USER_ID?.trim();
	if (!token || !chatId) return { skipped: true };
	const form = new FormData();
	form.set('chat_id', chatId);
	form.set('caption', caption);
	form.set('document', new Blob([readFileSync(file)]), file.split('/').pop());
	const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
	const body = await response.json().catch(() => null);
	return { sent: Boolean(body?.ok), status: response.status };
}
