/**
 * Память одного человека: своя SQLite в его зоне, никаких общих таблиц.
 *
 * Поиск — по `haystack` через LIKE, без FTS5: в сборке node:sqlite расширений нет, а кириллицу
 * `lower()` в SQLite не знает (тот же приём, что в Ассистенте). Дубликат не плодит строку:
 * уникальный ключ (kind, norm), повтор обновляет запись.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openMemory(path) {
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec('PRAGMA busy_timeout = 5000');
	try {
		db.exec('PRAGMA journal_mode = WAL');
	} catch {
		// WAL — оптимизация, не условие работы
	}
	db.exec(SCHEMA);
	return db;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL CHECK (kind IN ('fact','preference','rule','plan','contact','note')),
  text     TEXT NOT NULL,
  norm     TEXT NOT NULL,
  haystack TEXT NOT NULL,
  tags     TEXT NOT NULL DEFAULT '',
  source   TEXT NOT NULL DEFAULT 'user',
  status   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  created  TEXT NOT NULL,
  updated  TEXT NOT NULL,
  UNIQUE (kind, norm)
);
CREATE INDEX IF NOT EXISTS facts_status ON facts (status, updated);
CREATE TABLE IF NOT EXISTS changes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  by      TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT ''
);
`;

export const KINDS = ['fact', 'preference', 'rule', 'plan', 'contact', 'note'];

/** Нормализация для ключа и поиска: регистр, лишние пробелы, пунктуация по краям. */
export function normalizeText(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/[«»"'`]/g, '')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.,;:!?—–-]+|[\s.,;:!?—–-]+$/g, '')
		.trim();
}

export function tokensOf(query) {
	return normalizeText(query)
		.split(/[^a-zа-яё0-9]+/i)
		.filter((word) => word.length >= 2);
}

/**
 * Записать факт. Повтор (тот же kind и тот же нормализованный текст) обновляет строку и
 * возвращает `updated: true`; дублей в базе не бывает.
 */
export function remember(db, { kind = 'fact', text, tags = '', source = 'user', by = 'agent', at = new Date().toISOString() }) {
	const body = String(text ?? '').trim();
	if (!body) throw new Error('пустой текст — запоминать нечего');
	if (!KINDS.includes(kind)) throw new Error(`неизвестный вид записи: ${kind}`);
	const norm = normalizeText(body);
	if (!norm) throw new Error('после нормализации не осталось текста');
	const haystack = `${norm} ${normalizeText(tags)}`.trim();

	const existing = db.prepare('SELECT id, text, status FROM facts WHERE kind = ? AND norm = ?').get(kind, norm);
	const now = at;
	if (existing) {
		db.prepare("UPDATE facts SET text = ?, haystack = ?, tags = ?, source = ?, status = 'active', updated = ? WHERE id = ?").run(
			body,
			haystack,
			String(tags),
			String(source),
			now,
			existing.id,
		);
		logChange(db, { at: now, by, action: 'remember', target: `facts#${existing.id}`, summary: 'обновление' });
		return { id: existing.id, text: body, kind, updated: true };
	}
	const result = db
		.prepare('INSERT INTO facts (kind, text, norm, haystack, tags, source, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.run(kind, body, norm, haystack, String(tags), String(source), now, now);
	const id = Number(result.lastInsertRowid);
	logChange(db, { at: now, by, action: 'remember', target: `facts#${id}`, summary: kind });
	return { id, text: body, kind, updated: false };
}

/** Поиск: пустой запрос — свежее сверху; иначе все слова должны найтись в `haystack`. */
export function recall(db, query = '', limit = 10) {
	const words = tokensOf(query);
	const capped = Math.min(Math.max(Number(limit) || 10, 1), 50);
	if (!words.length) {
		return db
			.prepare("SELECT id, kind, text, tags, updated FROM facts WHERE status = 'active' ORDER BY updated DESC LIMIT ?")
			.all(capped);
	}
	const conditions = words.map(() => 'haystack LIKE ?').join(' AND ');
	return db
		.prepare(`SELECT id, kind, text, tags, updated FROM facts WHERE status = 'active' AND ${conditions} ORDER BY updated DESC LIMIT ?`)
		.all(...words.map((word) => `%${word}%`), capped);
}

/** Мягкое удаление: строка остаётся в базе как след, но в дайджест и поиск не попадает. */
export function forget(db, id, { by = 'agent', at = new Date().toISOString() } = {}) {
	const row = db.prepare("SELECT id, text, kind FROM facts WHERE id = ? AND status = 'active'").get(Number(id));
	if (!row) return { found: false };
	db.prepare("UPDATE facts SET status = 'deleted', updated = ? WHERE id = ?").run(at, row.id);
	logChange(db, { at, by, action: 'forget', target: `facts#${row.id}`, summary: row.kind });
	return { found: true, id: row.id, text: row.text };
}

export function listFacts(db, { kind, limit = 20 } = {}) {
	const capped = Math.min(Math.max(Number(limit) || 20, 1), 100);
	if (kind) {
		return db
			.prepare("SELECT id, kind, text, tags, updated FROM facts WHERE status = 'active' AND kind = ? ORDER BY updated DESC LIMIT ?")
			.all(kind, capped);
	}
	return db.prepare("SELECT id, kind, text, tags, updated FROM facts WHERE status = 'active' ORDER BY updated DESC LIMIT ?").all(capped);
}

export function logChange(db, { at, by, action, target, summary = '' }) {
	db.prepare('INSERT INTO changes (at, by, action, target, summary) VALUES (?, ?, ?, ?, ?)').run(at, by, action, target, String(summary));
}

/**
 * Дайджест для системного промпта: правила и предпочтения всегда, факты — только свежие.
 * Ограничен по длине: контекст дорогой, а память — не свалка.
 */
export function buildDigest(db, { maxChars = 900 } = {}) {
	const rules = db
		.prepare("SELECT id, kind, text FROM facts WHERE status = 'active' AND kind IN ('rule','preference') ORDER BY updated DESC LIMIT 12")
		.all();
	const facts = db
		.prepare("SELECT id, kind, text FROM facts WHERE status = 'active' AND kind IN ('fact','plan','contact') ORDER BY updated DESC LIMIT 8")
		.all();
	if (!rules.length && !facts.length) return '';
	const lines = [];
	if (rules.length) {
		lines.push('Правила и предпочтения:');
		for (const row of rules) lines.push(`- #${row.id} [${row.kind}] ${row.text}`);
	}
	if (facts.length) {
		lines.push('Что помню:');
		for (const row of facts) lines.push(`- #${row.id} ${row.text}`);
	}
	let body = lines.join('\n');
	if (body.length > maxChars) body = `${body.slice(0, maxChars - 1)}…`;
	return body;
}

export const DIGEST_START = '<!-- начало памяти (машинный блок) -->';
export const DIGEST_END = '<!-- конец памяти -->';

/** Дописать дайджест в системный промпт: свой блок не дублируется. */
export function appendDigest(systemPrompt, digest) {
	const text = String(systemPrompt ?? '');
	if (!digest) return text;
	if (text.includes(DIGEST_START)) return text;
	return `${text.trimEnd()}\n\n${DIGEST_START}\n${digest}\n${DIGEST_END}\n`;
}
