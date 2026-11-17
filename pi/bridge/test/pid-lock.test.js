import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { acquirePidLock, isProcessAlive, releasePidLock } from '../src/pid-lock.js';

async function lockFile() {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-pid-'));
	return { dir, file: join(dir, 'bridge.pid') };
}

test('pid-lock: первый захват пишет pid, второй живой pid — отказ', async () => {
	const { dir, file } = await lockFile();
	const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
	await once(child, 'spawn');
	try {
		await writeFile(file, `${child.pid}\n`, 'utf8');
		const result = acquirePidLock(file, process.pid);
		assert.equal(result.acquired, false);
		assert.equal(result.pid, child.pid);
		assert.equal((await readFile(file, 'utf8')).trim(), String(child.pid), 'чужой lock не перезаписан');
		assert.equal(isProcessAlive(child.pid), true);
	} finally {
		child.kill('SIGKILL');
		await once(child, 'exit');
		await rm(dir, { recursive: true, force: true });
	}
});

test('pid-lock: свой pid в файле — это запись обёртки-расширения, а не второй экземпляр', async () => {
	const { dir, file } = await lockFile();
	try {
		await writeFile(file, `${process.pid}\n`, 'utf8');
		assert.deepEqual(acquirePidLock(file, process.pid), { acquired: true, shared: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('pid-lock: устаревший pid заменяется, файл создаётся эксклюзивно', async () => {
	const { dir, file } = await lockFile();
	try {
		await writeFile(file, '999999999\n', 'utf8');
		assert.equal(isProcessAlive(999999999), false);
		const result = acquirePidLock(file, 424242);
		assert.equal(result.acquired, true);
		assert.equal(result.replaced, 999999999);
		assert.equal((await readFile(file, 'utf8')).trim(), '424242');

		await rm(file);
		assert.equal(acquirePidLock(file, 424242).acquired, true);
		assert.equal((await readFile(file, 'utf8')).trim(), '424242');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('pid-lock: main.js с живым pid выходит с понятным текстом и не поднимает бота', async () => {
	const { dir, file } = await lockFile();
	const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
	await once(child, 'spawn');
	try {
		await writeFile(file, `${child.pid}\n`, 'utf8');
		const main = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url))], {
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				PI_TG_BOT_TOKEN: '123456789:TESTTOKENFORUNITSONLY',
				PI_TG_STATE_FILE: join(dir, 'state.json'),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		main.stderr.on('data', (chunk) => (stderr += String(chunk)));
		const [code] = await once(main, 'exit');
		assert.equal(code, 3);
		assert.match(stderr, /Мост уже запущен/);
		assert.match(stderr, new RegExp(`pid ${child.pid}`));
	} finally {
		child.kill('SIGKILL');
		await once(child, 'exit');
		await rm(dir, { recursive: true, force: true });
	}
});

test('pid-lock: release удаляет только свой файл', async () => {
	const { dir, file } = await lockFile();
	try {
		await writeFile(file, '424242\n', 'utf8');
		releasePidLock(file, process.pid);
		assert.equal(existsSync(file), true, 'чужой pid не трогаем');
		releasePidLock(file, 424242);
		assert.equal(existsSync(file), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
