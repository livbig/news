#!/usr/bin/env node
/**
 * Проверка восстановления: распаковать архив бэкапа во временный каталог, открыть базы,
 * посчитать строки, убедиться, что правила и сессии на месте. Запуск:
 *   node scripts/verify-restore.mjs /srv/dvoretsky/backups/<дата>/dvoretsky-<дата>.tar.gz
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const archive = process.argv[2];
if (!archive || !existsSync(archive)) {
	console.error('нужен путь к архиву бэкапа');
	process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'dv-restore-'));
const problems = [];
try {
	execFileSync('tar', ['-xzf', archive, '-C', dir]);
	const users = join(dir, 'users');
	const zones = existsSync(users) ? readdirSync(users) : [];
	if (!zones.length) problems.push('в архиве нет каталога users');
	const result = {};
	for (const slug of zones) {
		const dbPath = join(users, slug, `memory-${slug}.db`);
		if (!existsSync(dbPath)) {
			// Память могла ещё не создаваться: это не потеря, а пустая зона.
			result[slug] = { facts: 0, changes: 0, note: 'памяти ещё не было' };
			continue;
		}
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const facts = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'").get().n;
			const changes = db.prepare('SELECT COUNT(*) AS n FROM changes').get().n;
			result[slug] = { facts, changes };
		} catch (error) {
			problems.push(`${slug}: база не читается (${error.message})`);
		} finally {
			db.close();
		}
		if (!existsSync(join(users, slug, `AGENTS-${slug}.md`))) problems.push(`${slug}: нет копии правил`);
		if (!existsSync(join(users, slug, `sessions-${slug}`))) problems.push(`${slug}: нет копии сессий`);
	}
	console.log(JSON.stringify({ archive, zones: result, problems }, null, 2));
	process.exit(problems.length ? 1 : 0);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
