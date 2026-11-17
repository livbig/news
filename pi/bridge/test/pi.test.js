import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHILD_ENV_MASK, botTokenKeys, buildChildEnv, childEnvMask, resolveCliPath } from '../src/pi.js';

test('CLI pi находится в установленном пакете (иначе RpcClient спавнит несуществующий путь)', () => {
	const cliPath = resolveCliPath();
	assert.ok(cliPath.endsWith('cli.js'), `неожиданный путь: ${cliPath}`);
	assert.ok(existsSync(cliPath), `файла нет: ${cliPath}`);
});

test('явный путь имеет приоритет', async () => {
	const explicit = join(tmpdir(), `pi-cli-${Date.now()}.js`);
	await writeFile(explicit, '// заглушка\n', 'utf8');
	assert.equal(resolveCliPath(explicit), explicit);
});

test('несуществующий явный путь не мешает автопоиску, а полный мусор — ошибка', () => {
	process.env.PI_PACKAGE_DIR = '/nope/nope';
	try {
		assert.ok(resolveCliPath('/nope/cli.js').endsWith('cli.js'));
	} finally {
		delete process.env.PI_PACKAGE_DIR;
	}
});

test('секреты фронтенда не уезжают в дочерний pi', () => {
	for (const key of ['TELEGRAM_BOT_TOKEN', 'PI_TG_BOT_TOKEN', 'OPENROUTER_API_KEY']) {
		assert.ok(key in CHILD_ENV_MASK, `${key} должен маскироваться`);
		assert.equal(CHILD_ENV_MASK[key], undefined, `${key} не должен иметь значения`);
	}
});

test('токен бота не уезжает под чужим именем (HELPER_BOT_TOKEN, NEWS_BOT_TOKEN)', () => {
	// Живые env-файлы юнитов: one и тот же токен живёт под тремя именами.
	const env = {
		HELPER_BOT_TOKEN: '8766943850:AA-test',
		NEWS_BOT_TOKEN: '8766943850:AA-test',
		PI_TG_BOT_TOKEN: '8766943850:AA-test',
		TELEGRAM_BOT_TOKEN: '8766943850:AA-test',
		NEWS_API_TOKEN: 'api-token',
		DEEPSEEK_API_KEY: 'sk-test',
	};
	assert.deepEqual(botTokenKeys(env).sort(), [
		'HELPER_BOT_TOKEN',
		'NEWS_BOT_TOKEN',
		'PI_TG_BOT_TOKEN',
		'TELEGRAM_BOT_TOKEN',
	]);
	const mask = childEnvMask(env);
	for (const key of botTokenKeys(env)) assert.equal(mask[key], undefined, `${key} должен быть замаскирован`);
	// Не токен бота — не маскируем: агенту нужен доступ к API службы и своя модель.
	assert.equal(mask.NEWS_API_TOKEN, undefined);
	assert.equal(mask.DEEPSEEK_API_KEY, undefined);
});

test('spawn собирает окружение ребёнка только через маску (зона + контекст чата)', () => {
	// То, что реально видит дочерний pi: маска сильнее контекста зоны.
	const source = { HELPER_BOT_TOKEN: '8766943850:AA-test', NEWS_API_TOKEN: 'api-token', PATH: '/usr/bin' };
	const childEnv = buildChildEnv({ PI_HELPER_HOME: '/srv/news/users/livbig', PI_CHAT_ID: '55' }, source);
	assert.equal(childEnv.PI_HELPER_HOME, '/srv/news/users/livbig', 'контекст зоны должен доехать');
	assert.equal(childEnv.PI_CHAT_ID, '55');
	assert.equal(childEnv.HELPER_BOT_TOKEN, undefined, 'токен не должен доехать ни под каким именем');
	// Поле с undefined spawn не передаёт — process.env ребёнка остаётся без токена.
	assert.ok(!Object.entries(childEnv).some(([key, value]) => /BOT_TOKEN$/.test(key) && value !== undefined));
	// Тот же ключ, подсунутый в контекст зоны, тоже гасится.
	assert.equal(buildChildEnv({ HELPER_BOT_TOKEN: 'x' }, source).HELPER_BOT_TOKEN, undefined);
});
