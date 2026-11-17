import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadTelegramFile } from '../src/files.js';
import { test } from 'node:test';

import {
	MAX_OUTGOING_BYTES,
	PDF_TTL_MS,
	checkOutgoingFile,
	incomingDocumentName,
	incomingDocumentProblem,
	photoName,
	pruneOutboxPdfs,
	removeSentPdf,
	splitFileMarkers,
} from '../src/files.js';

async function dataDir() {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-files-unit-'));
	const data = join(dir, 'data');
	await mkdir(join(data, 'outbox'), { recursive: true });
	await mkdir(join(data, 'inbox'), { recursive: true });
	return data;
}

test('маркер [file:…] вынимается из ответа, остальной текст остаётся', () => {
	const parsed = splitFileMarkers('Готово, смета:\n[file:/srv/assistant/data/outbox/smeta.pdf]\nпроверьте');
	assert.deepEqual(parsed.files, ['/srv/assistant/data/outbox/smeta.pdf']);
	assert.equal(parsed.before, 'Готово, смета:');
	assert.equal(parsed.after, 'проверьте');
	assert.equal(parsed.text, 'Готово, смета:\n\nпроверьте');
	assert.deepEqual(splitFileMarkers('без маркера'), { text: 'без маркера', files: [], before: '' });
});

test('наружу можно отправить только файл из outbox/inbox', async () => {
	const data = await dataDir();
	const inside = join(data, 'outbox', 'report.pdf');
	await writeFile(inside, 'pdf');
	const checked = checkOutgoingFile(inside, { dataDir: data });
	assert.equal(checked.error, undefined);
	assert.ok(checked.path.endsWith('report.pdf'));

	const outside = join(data, '..', 'secret.txt');
	await writeFile(outside, 'secret');
	assert.match(checkOutgoingFile(outside, { dataDir: data }).error, /вне разрешённых/);
	assert.match(checkOutgoingFile('/etc/passwd', { dataDir: data }).error, /вне разрешённых/);
	assert.match(checkOutgoingFile(join(data, 'outbox', 'нет.pdf'), { dataDir: data }).error, /не найден/);
});

test('симлинк из inbox наружу не обходит границу', async () => {
	const data = await dataDir();
	const outside = join(data, '..', 'outside.txt');
	await writeFile(outside, 'secret');
	const link = join(data, 'inbox', 'link.pdf');
	await symlink(outside, link);
	assert.match(checkOutgoingFile(link, { dataDir: data }).error, /вне разрешённых/);
});

test('слишком большой файл не отправляется', async () => {
	const data = await dataDir();
	const inside = join(data, 'outbox', 'big.pdf');
	await writeFile(inside, 'x');
	const checked = checkOutgoingFile(inside, {
		dataDir: data,
		stat: () => ({ isFile: () => true, size: MAX_OUTGOING_BYTES + 1 }),
	});
	assert.match(checked.error, /больше 50 МБ/);
});

test('документы: pdf/docx/xlsx/txt/csv/json/zip, лимит 20 МБ', () => {
	for (const extension of ['pdf', 'docx', 'xlsx', 'txt', 'csv', 'json', 'zip']) {
		assert.equal(incomingDocumentProblem({ file_name: `file.${extension}`, file_size: 10 }), null, extension);
	}
	assert.equal(incomingDocumentProblem({ file_name: 'scan.PDF', file_size: 10 }), null, 'регистр расширения не важен');
	assert.match(incomingDocumentProblem({ file_name: 'photo.png', file_size: 10 }), /принимаю документы/, 'PNG не принимаем');
	assert.match(incomingDocumentProblem({ file_name: 'virus.exe', file_size: 10 }), /принимаю документы/);
	assert.match(incomingDocumentProblem({ file_name: 'big.pdf', file_size: 20 * 1024 * 1024 + 1 }), /больше 20 МБ/);
});

test('имя входящего файла безопасно: без пути наружу и с меткой времени', () => {
	assert.match(photoName(1000), /^photo-1000\.jpg$/);
	assert.equal(incomingDocumentName({ file_name: 'смета.pdf' }, 1000), 'смета-1000.pdf');
	assert.equal(incomingDocumentName({ file_name: '../../etc/passwd.txt' }, 1000), 'passwd-1000.txt');
	assert.equal(incomingDocumentName({ file_name: '', mime_type: 'application/pdf' }, 1000), 'file-1000.pdf');
});

test('одноразовые PDF: старые удаляются, свежие и лёгкое (csv/json) остаются', async () => {
	const data = await dataDir();
	const version = join(data, 'outbox', '51');
	await mkdir(version, { recursive: true });
	const now = Date.now();
	const old = new Date(now - PDF_TTL_MS - 60_000);
	await writeFile(join(version, 'Смета — ПЕРИМЕТР..pdf'), Buffer.alloc(2048));
	await writeFile(join(version, 'smeta.csv'), 'Итого;1');
	await writeFile(join(version, 'estimate.json'), '{}');
	await writeFile(join(data, 'outbox', 'smeta-13.pdf'), Buffer.alloc(1024));
	// Старый PDF в общем каталоге outbox и старый CSV: срок истекает только у PDF.
	await utimes(join(version, 'Смета — ПЕРИМЕТР..pdf'), old, old);
	await utimes(join(data, 'outbox', 'smeta-13.pdf'), old, old);
	await utimes(join(version, 'smeta.csv'), old, old);

	const result = pruneOutboxPdfs({ dataDir: data, now });

	assert.deepEqual(result, { removed: 2, bytes: 3072, dirs: 0 });
	assert.equal(existsSync(join(version, 'Смета — ПЕРИМЕТР..pdf')), false, 'старый PDF удалён');
	assert.equal(existsSync(join(data, 'outbox', 'smeta-13.pdf')), false);
	assert.equal(readFileSync(join(version, 'smeta.csv'), 'utf8'), 'Итого;1', 'лёгкое не тронуто');
	assert.equal(existsSync(join(version, 'estimate.json')), true);

	// Свежий PDF (сборка только что, отправка ещё не прошла) остаётся.
	await writeFile(join(version, 'Смета — ПЕРИМЕТР..pdf'), Buffer.alloc(10));
	assert.equal(pruneOutboxPdfs({ dataDir: data, now }).removed, 0);

	// Опустевший каталог версии убирается, сам outbox — нет.
	await writeFile(join(version, 'estimate.json'), '{}');
	await rm(join(version, 'Смета — ПЕРИМЕТР..pdf'));
	await rm(join(version, 'smeta.csv'));
	const empty = join(data, 'outbox', '99');
	await mkdir(empty, { recursive: true });
	assert.deepEqual(pruneOutboxPdfs({ dataDir: data, now }).dirs, 1);
	assert.equal(existsSync(join(data, 'outbox')), true, 'outbox на месте');
});

test('удаление отправленного PDF: пересобранный файл не трогаем', async () => {
	const data = await dataDir();
	const path = join(data, 'outbox', 'смета.pdf');
	await writeFile(path, 'pdf');
	const sent = checkOutgoingFile(path, { dataDir: data });
	assert.equal(typeof sent.mtimeMs, 'number', 'время файла запоминается до отправки');

	// Пока документ летел в Telegram, соседний прогон пересобрал смету — файл с тем же именем новее.
	await utimes(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
	assert.equal(removeSentPdf(path, sent.mtimeMs), false, 'изменившийся файл оставляем');
	assert.equal(existsSync(path), true);

	const fresh = checkOutgoingFile(path, { dataDir: data });
	assert.equal(removeSentPdf(path, fresh.mtimeMs), true, 'нетронутый файл удаляется');
	assert.equal(existsSync(path), false);
	assert.equal(removeSentPdf(path, fresh.mtimeMs), false, 'повторное удаление — не ошибка');
});

test('скачанный файл получает владельца зоны (chown), иначе root-файл не убрать агенту', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dv-files-'));
	const calls = [];
	const ctx = {
		api: { getFile: async () => ({ file_path: 'voice/x.ogg' }) },
	};
	const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('data').buffer });
	const saved = await downloadTelegramFile({
		ctx,
		fileId: 'f1',
		token: 'x',
		fetchImpl,
		dir,
		name: 'x.ogg',
		owner: { uid: 1001, gid: 1002 },
		chown: (path, uid, gid) => calls.push([path, uid, gid]),
	});
	assert.equal(saved.size, 4);
	assert.deepEqual(calls, [[join(dir, 'x.ogg'), 1001, 1002]]);
});
