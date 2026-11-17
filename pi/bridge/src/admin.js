/**
 * Админ-доступ к чужой зоне (только владелец, только для отладки).
 *
 * Это не инструменты модели: команды выполняет мост под root, поэтому «попросить агента
 * посмотреть чужую историю» не работает ни промптом, ни инъекцией в документе. Каждый вызов
 * пишется в аудит — тихого доступа нет даже у администратора.
 *
 * Здесь только чтение: ничего не удаляет и не меняет.
 */

import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_LINES = 5000;

/** Последние сообщения из сессий зоны: новые файлы первыми, внутри файла — по порядку. */
export async function readHistory(sessionDir, limit = 20) {
	const files = await sessionFiles(sessionDir);
	const rows = [];
	for (const file of files) {
		if (rows.length >= limit) break;
		const text = await readFile(file.path, 'utf8').catch(() => '');
		const lines = text.split('\n').slice(-MAX_LINES);
		const parsed = [];
		for (const line of lines) {
			const entry = safeJson(line);
			if (entry?.type !== 'message') continue;
			const role = entry.message?.role;
			if (role !== 'user' && role !== 'assistant') continue;
			const body = textOf(entry.message?.content);
			if (!body) continue;
			parsed.push({ at: entry.timestamp, role, text: body });
		}
		rows.push(...parsed.reverse());
	}
	return rows.slice(0, limit).reverse();
}

async function sessionFiles(sessionDir) {
	let names;
	try {
		names = await readdir(sessionDir, { recursive: true });
	} catch {
		return [];
	}
	const files = [];
	for (const name of names) {
		if (!String(name).endsWith('.jsonl')) continue;
		const path = join(sessionDir, String(name));
		try {
			const info = await stat(path);
			if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs });
		} catch {
			// файл исчез между readdir и stat — пропускаем
		}
	}
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function safeJson(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function textOf(content) {
	if (typeof content === 'string') return content.trim();
	if (!Array.isArray(content)) return '';
	return content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text.trim())
		.filter(Boolean)
		.join('\n');
}

/** Строки памяти зоны; query — подстрока (LIKE), пусто — самые свежие. */
export async function readMemory(memoryDb, query = '', limit = 20) {
	let db;
	try {
		db = new DatabaseSync(memoryDb, { readOnly: true });
	} catch {
		return { error: 'база памяти ещё не создана' };
	}
	try {
		const needle = `%${String(query ?? '').trim().toLowerCase()}%`;
		const rows = db
			.prepare(
				`SELECT id, kind, text, updated FROM facts
				 WHERE status = 'active' AND (? = '%%' OR haystack LIKE ?)
				 ORDER BY updated DESC LIMIT ?`,
			)
			.all(needle, needle, limit);
		return { rows };
	} catch (error) {
		return { error: `не смог прочитать память: ${error.message}` };
	} finally {
		try {
			db.close();
		} catch {
			// уже закрыта
		}
	}
}

/** Что лежит в файлах зоны: только имена и размеры, без содержимого. */
export async function listZoneFiles(dataDir) {
	const out = {};
	for (const part of ['inbox', 'outbox']) {
		const dir = join(dataDir, part);
		let names = [];
		try {
			names = await readdir(dir);
		} catch {
			names = [];
		}
		const files = [];
		for (const name of names.slice(0, 50)) {
			try {
				const info = await stat(join(dir, name));
				if (info.isFile()) files.push({ name, size: info.size, at: info.mtimeMs });
			} catch {
				// исчез — не показываем
			}
		}
		out[part] = files.sort((a, b) => b.at - a.at);
	}
	return out;
}

/** Хвост лога за день: секреты в логи не попадают, но маску всё равно применяем в bridge. */
export async function readLogTail(logDir, date, limit = 80) {
	const file = join(logDir, `bridge-${date}.txt`);
	const text = await readFile(file, 'utf8').catch(() => '');
	if (!text) return { error: `лог за ${date} не найден` };
	return { lines: text.trimEnd().split('\n').slice(-limit) };
}

export async function appendAudit(file, { at = new Date().toISOString(), by, action, target, summary = '' }) {
	await mkdir(join(file, '..'), { recursive: true }).catch(() => {});
	await appendFile(file, `${JSON.stringify({ at, by, action, target, summary })}\n`, { mode: 0o600 });
}
