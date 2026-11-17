/**
 * Файлы вокруг агента: входящие из Telegram и исходящие по маркеру `[file:/путь]`.
 *
 * Границы доверия — здесь, а не в обработчике: путь наружу обязан лежать внутри
 * `/srv/assistant/data/{outbox,inbox}` (или PI_TG_DATA_DIR), а размеры — под лимитами Bot API.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { chownSync, existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';

export const MAX_OUTGOING_BYTES = 50 * 1024 * 1024;
export const MAX_INCOMING_BYTES = 20 * 1024 * 1024;
/** Сколько PDF живёт в outbox, если отправка не удалась: дальше его убирает уборка. */
export const PDF_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_API_ROOT = 'https://api.telegram.org';

export const ALLOWED_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.txt', '.csv', '.json', '.zip']);

const DOCUMENT_MIME_EXTENSIONS = new Map([
	['application/pdf', '.pdf'],
	['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
	['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
	['text/plain', '.txt'],
	['text/csv', '.csv'],
	['application/json', '.json'],
	['application/zip', '.zip'],
	['application/x-zip-compressed', '.zip'],
]);

export function dataRoots(dataDir) {
	const root = resolve(String(dataDir ?? '/srv/assistant/data'));
	return { outbox: join(root, 'outbox'), inbox: join(root, 'inbox') };
}

/** Строки `[file:/abs/path]` вынимаются из ответа; before — текст до первого маркера. */
export function splitFileMarkers(text) {
	const source = String(text ?? '');
	const matches = [...source.matchAll(/^[ \t]*\[file:([^\]\n]+)\][ \t]*$/gm)];
	if (!matches.length) return { text: source, files: [], before: '' };
	const files = matches.map((match) => match[1].trim()).filter(Boolean);
	const visible = source.replace(/^[ \t]*\[file:[^\]\n]+\][ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
	const before = source.slice(0, matches[0].index).trim();
	const last = matches.at(-1);
	const after = source.slice(last.index + last[0].length).trim();
	return { text: visible, files, before, after };
}

/** Путь наружу: только файл внутри outbox/inbox и не больше 50 МБ. */
export function checkOutgoingFile(path, { dataDir, stat = statSync, realpath = realpathSync } = {}) {
	const rawRoots = Object.values(dataRoots(dataDir));
	const roots = rawRoots.map((root) => {
		try {
			return realpath(root);
		} catch {
			return root;
		}
	});
	const allowedRoots = [...new Set([...rawRoots, ...roots])];
	const target = resolve(String(path ?? ''));
	if (!insideRoot(target, allowedRoots)) {
		return { error: 'путь вне разрешённых каталогов outbox/inbox' };
	}

	let real;
	try {
		real = realpath(target);
	} catch {
		return { error: 'файл не найден' };
	}
	if (!insideRoot(real, allowedRoots)) return { error: 'путь вне разрешённых каталогов outbox/inbox' };

	let info;
	try {
		info = stat(real);
	} catch {
		return { error: 'файл не найден' };
	}
	if (!info.isFile()) return { error: 'это не файл' };
	if (info.size > MAX_OUTGOING_BYTES) return { error: `файл больше ${formatMegabytes(MAX_OUTGOING_BYTES)}` };
	return { path: real, name: basename(real), size: info.size, mtimeMs: info.mtimeMs };
}

function insideRoot(path, roots) {
	return roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

/** Расширение документа: по имени файла, иначе по MIME. null — формат не принимаем. */
export function documentExtension(document) {
	const fromName = extname(String(document?.file_name ?? '')).toLowerCase();
	if (ALLOWED_DOCUMENT_EXTENSIONS.has(fromName)) return fromName;
	return DOCUMENT_MIME_EXTENSIONS.get(String(document?.mime_type ?? '').toLowerCase()) ?? null;
}

export function incomingDocumentProblem(document) {
	if (!document) return 'документ не пришёл';
	if ((document.file_size ?? 0) > MAX_INCOMING_BYTES) return `документ больше ${formatMegabytes(MAX_INCOMING_BYTES)}`;
	if (!documentExtension(document)) {
		return `принимаю документы: ${[...ALLOWED_DOCUMENT_EXTENSIONS].map((ext) => ext.slice(1)).join(', ')} (до ${formatMegabytes(MAX_INCOMING_BYTES)})`;
	}
	return null;
}

/** `<orig>-<ts>.<ext>`; имя чистим, чтобы оно не вылезло за пределы inbox. */
export function incomingDocumentName(document, now = Date.now()) {
	const extension = documentExtension(document) ?? '.bin';
	const original = String(document?.file_name ?? '');
	const stem = basename(original, extname(original))
		.replace(/[^\p{L}\p{N}._-]+/gu, '_')
		.replace(/^[._-]+|[._-]+$/g, '')
		.slice(0, 80);
	return `${stem || 'file'}-${now}${extension}`;
}

export function photoName(now = Date.now()) {
	return `photo-${now}.jpg`;
}

/** Скачивание файла Telegram в inbox. Возвращает байты: фото ещё пойдёт в pi как изображение. */
export async function downloadTelegramFile({
	ctx,
	fileId,
	token,
	fetchImpl = globalThis.fetch,
	apiRoot = DEFAULT_API_ROOT,
	dir,
	name,
	owner,
	chown = chownSync,
} = {}) {
	const file = fileId ? await ctx.api.getFile(fileId) : await ctx.getFile();
	if (!file?.file_path) throw new Error('Telegram не отдал путь к файлу');
	const response = await fetchImpl(`${String(apiRoot).replace(/\/+$/, '')}/file/bot${token}/${file.file_path}`, {
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) throw new Error(`Telegram не отдал файл (${response.status})`);
	const data = Buffer.from(await response.arrayBuffer());
	await mkdir(dir, { recursive: true });
	const path = join(dir, name);
	await writeFile(path, data);
	// Мост работает от root: без chown файл в inbox принадлежал бы root, и агент не смог бы его убрать.
	if (owner?.uid) {
		try {
			chown(path, owner.uid, owner.gid ?? owner.uid);
		} catch {
			// без root (разработка) или чужой uid — файл остаётся как есть, дальше решают права зоны
		}
	}
	return { path, size: data.length, data };
}

/**
 * Уборка одноразовых PDF. Документ живёт в outbox только до отправки в чат — после успешной
 * отправки мост удаляет файл сам; это страховка для тех, что не ушли (сбой отправки, рестарт).
 * Удаляются `*.pdf` старше срока и опустевшие каталоги версий; лёгкое (`smeta.csv`,
 * `estimate.json`) и сам outbox не трогаются.
 */
export function pruneOutboxPdfs({ dataDir, olderThanMs = PDF_TTL_MS, now = Date.now() } = {}) {
	const root = dataRoots(dataDir).outbox;
	if (!existsSync(root)) return { removed: 0, bytes: 0, dirs: 0 };
	const cutoff = now - olderThanMs;
	const dirs = [];
	let removed = 0;
	let bytes = 0;
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				dirs.push(path);
				walk(path);
				continue;
			}
			if (!entry.name.toLowerCase().endsWith('.pdf')) continue;
			const info = statSync(path);
			if (info.mtimeMs > cutoff) continue;
			rmSync(path, { force: true });
			removed += 1;
			bytes += info.size;
		}
	};
	walk(root);
	// Вложенные первыми: после удаления файлов каталог версии может стать пустым.
	let emptiedDirs = 0;
	for (const dir of dirs.sort((left, right) => right.length - left.length)) {
		if (readdirSync(dir).length) continue;
		rmSync(dir, { recursive: true, force: true });
		emptiedDirs += 1;
	}
	return { removed, bytes, dirs: emptiedDirs };
}

/**
 * Удалить одноразовый PDF, только если его не перезаписали, пока шла отправка: два прогона по одной
 * версии сметы дают новый файл с тем же именем, и удалять его вместе со старым нельзя.
 * Возвращает true, если файл удалён.
 */
export function removeSentPdf(path, sentMtimeMs, { stat = statSync, remove = rmSync } = {}) {
	if (sentMtimeMs === undefined) return false;
	let info;
	try {
		info = stat(path);
	} catch {
		return false; // файла уже нет — удалять нечего
	}
	if (info.mtimeMs !== sentMtimeMs) return false;
	remove(path, { force: true });
	return true;
}

/** Раз в час: уборка не должна ждать ночного upkeep ассистента и не держит процесс. */
export function startOutboxSweep({ dataDir, log, intervalMs = PDF_TTL_MS, olderThanMs = PDF_TTL_MS } = {}) {
	const run = () => {
		try {
			const result = pruneOutboxPdfs({ dataDir, olderThanMs });
			if (result.removed || result.dirs) {
				log?.info(
					`уборка outbox: PDF удалено ${result.removed} (${Math.round(result.bytes / 1024)} КБ), пустых каталогов ${result.dirs}`,
				);
			}
			return result;
		} catch (error) {
			log?.warn(`уборка outbox: ${error?.message ?? error}`);
			return null;
		}
	};
	run();
	const timer = setInterval(run, intervalMs);
	timer.unref?.();
	return { run, stop: () => clearInterval(timer) };
}

function formatMegabytes(bytes) {
	return `${Math.round(bytes / (1024 * 1024))} МБ`;
}
