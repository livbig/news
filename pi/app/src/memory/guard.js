/**
 * Граница зоны для инструментов агента.
 *
 * Честно: настоящая граница — права ОС (uid на человека, каталоги 700). Этот модуль нужен,
 * чтобы модель получала понятный отказ, а не EACCES, и чтобы случайная правка не ушла в чужой
 * каталог. `bash` этим не закрывается — там работает только ОС.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Корни, которые инструментам разрешены: только своя зона. Общий /tmp не даём:
 * он один на всех, и «временный» файл не должен становиться чужим.
 */
export function allowedRoots(env = process.env) {
	const roots = [
		env.PI_HELPER_WORK_DIR,
		env.PI_HELPER_HOME,
		env.PI_CODING_AGENT_DIR,
		env.PI_HELPER_MEMORY_DB,
		env.PI_HELPER_TMP,
	]
		.filter(Boolean)
		.map((path) => resolve(String(path)));
	return [...new Set(roots)];
}

/** Путь вне своей зоны — отказ с причиной, а не «тихо не туда». */
export function checkPath(path, roots) {
	const target = resolve(String(path ?? ''));
	if (!target) return null;
	const inside = roots.some((root) => target === root || target.startsWith(`${root}/`));
	return inside ? null : 'это чужая зона: здесь можно работать только со своими файлами';
}

/** Аргументы инструментов, где лежат пути: read/write/edit/ls/grep/find и их варианты. */
const PATH_KEYS = ['path', 'file', 'filePath', 'file_path', 'dir', 'directory', 'cwd', 'paths', 'files'];

export function pathsIn(input) {
	const out = [];
	const walk = (value, depth = 0) => {
		if (depth > 3 || value === null || value === undefined) return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, depth + 1);
			return;
		}
		if (typeof value === 'object') {
			for (const [key, item] of Object.entries(value)) {
				if (PATH_KEYS.includes(key)) walk(item, depth + 1);
			}
			return;
		}
		// Путь может быть относительным (`../../aliiinam/x`): resolve() считает его от cwd зоны,
		// а проверка та же. Раньше такие строки просто не попадали в проверку.
		if (typeof value === 'string' && value.trim()) out.push(value);
	};
	walk(input);
	return out;
}

/**
 * Хук tool_call: возвращает причину блокировки или null.
 * Для bash/непонятных инструментов не гадаем — их граница в правах ОС.
 */
export function blockedReason(toolName, input, env = process.env) {
	if (toolName === 'bash') return null;
	if (!/^(read|write|edit|ls|list|grep|find|glob)$/i.test(String(toolName))) return null;
	const roots = allowedRoots(env);
	for (const path of pathsIn(input)) {
		const reason = checkPath(path, roots);
		if (reason) return reason;
	}
	return null;
}

/** Перед правкой AGENTS.md — копия в `.history/`, чтобы откат был возможен без git. */
export function backupRules(path, at = new Date()) {
	const target = resolve(String(path ?? ''));
	if (!/AGENTS\.md$/i.test(target) || !existsSync(target)) return null;
	const dir = join(dirname(target), '.history');
	mkdirSync(dir, { recursive: true });
	const stamp = at.toISOString().replace(/[:.]/g, '-');
	const copy = join(dir, `AGENTS-${stamp}.md`);
	copyFileSync(target, copy);
	return copy;
}
