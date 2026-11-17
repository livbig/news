import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, loadConfig, parseSessionDirs } from '../src/config.js';
import { maskSecret, redactSecrets } from '../src/mask.js';

const TOKEN = '123456789:TESTTOKENFORUNITSONLY';

test('без токена — понятная ошибка', () => {
	assert.throws(() => loadConfig({}), (error) => error instanceof ConfigError && error.message.includes('.env'));
});

test('мусор вместо токена: ошибка, но не сам токен', () => {
	try {
		loadConfig({ PI_TG_BOT_TOKEN: 'not-a-token-at-all-1234567890' });
		assert.fail('должно было упасть');
	} catch (error) {
		assert.ok(error instanceof ConfigError);
		assert.ok(!error.message.includes('not-a-token-at-all-1234567890'));
	}
});

test('значения по умолчанию', () => {
	const config = loadConfig({ PI_TG_BOT_TOKEN: TOKEN });
	assert.equal(config.botToken, TOKEN);
	assert.equal(config.draftEnabled, true);
	assert.equal(config.timeoutMs, 15 * 60_000);
	assert.equal(config.allowedUserId, undefined);
	assert.deepEqual(config.piArgs, []);
	assert.equal(config.idleMs, 30 * 60_000);
	assert.equal(config.maxIdleSessions, 3);
	assert.equal(config.maxProcesses, 4);
	assert.equal(config.turnMaxMs, 20 * 60_000);
	assert.equal(config.turnMaxCostUsd, 2, 'потолок одного прогона — $2 по умолчанию');
	assert.equal(config.requireMention, true);
	assert.equal(config.sttApiKey, undefined);
	assert.equal(config.sttModel, 'openai/whisper-large-v3');
	assert.equal(config.sttBaseUrl, 'https://openrouter.ai/api/v1');
	assert.equal(config.sttLanguage, 'ru');
	assert.equal(config.cliPath, undefined);
	assert.ok(config.stateFile.endsWith('state.json'));
});

test('PI_TG_DRAFT=off и PI_TG_PI_ARGS', () => {
	const config = loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_DRAFT: 'off', PI_TG_PI_ARGS: '--approve --no-mcp' });
	assert.equal(config.draftEnabled, false);
	assert.deepEqual(config.piArgs, ['--approve', '--no-mcp']);
});

test('битые значения env отклоняются явно', () => {
	assert.throws(() => loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_DRAFT: 'может быть' }), ConfigError);
	assert.throws(() => loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_TIMEOUT_MS: 'abc' }), ConfigError);
	assert.throws(() => loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_LOG: 'trace' }), ConfigError);
	assert.throws(() => loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_MAX_PROCESSES: '0' }), ConfigError);
	assert.throws(() => loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_REQUIRE_MENTION: 'может быть' }), ConfigError);
	assert.throws(() => loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_TURN_MAX_COST_USD: 'дорого' }), ConfigError);
	assert.throws(() => loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_TURN_MAX_COST_USD: '0' }), ConfigError);
});

test('потолок процессов, watchdog, группы и STT читаются из env', () => {
	const config = loadConfig({
		PI_TG_BOT_TOKEN: TOKEN,
		PI_TG_MAX_PROCESSES: '3',
		PI_TG_TURN_MAX_MS: '60000',
		PI_TG_TURN_MAX_COST_USD: '0.0001',
		PI_TG_REQUIRE_MENTION: 'false',
		OPENROUTER_API_KEY: ' test-key ',
		STT_MODEL: 'openai/whisper-1',
		STT_BASE_URL: 'https://example.test/api/',
		STT_LANGUAGE: 'en',
		MINIAPP_API_URL: ' http://assistant.test:9090/ ',
		MINIAPP_SERVICE_TOKEN: ' service-token ',
	});
	assert.equal(config.maxProcesses, 3);
	assert.equal(config.turnMaxMs, 60_000);
	assert.equal(config.turnMaxCostUsd, 0.0001, 'порог можно занизить для проверки');
	assert.equal(config.requireMention, false);
	assert.equal(config.sttApiKey, 'test-key');
	assert.equal(config.sttModel, 'openai/whisper-1');
	assert.equal(config.sttBaseUrl, 'https://example.test/api');
	assert.equal(config.sttLanguage, 'en');
});

test('маскирование и вычистка токена из строк', () => {
	const masked = maskSecret(TOKEN);
	assert.ok(!masked.includes(TOKEN));
	assert.ok(masked.startsWith('1234'));
	const text = redactSecrets(`Telegram API bot${TOKEN}/getMe failed`);
	assert.ok(!text.includes(TOKEN));
	assert.ok(text.includes('1234'));
	assert.equal(maskSecret(''), '<пусто>');
});

test('каталог файлов ассистента: /srv/assistant/data по умолчанию, PI_TG_DATA_DIR переопределяет', () => {
	assert.equal(loadConfig({ PI_TG_BOT_TOKEN: TOKEN }).dataDir, '/srv/assistant/data');
	assert.equal(loadConfig({ PI_TG_BOT_TOKEN: TOKEN, PI_TG_DATA_DIR: '/tmp/assistant' }).dataDir, '/tmp/assistant');
});

test('PI_TG_SESSION_DIRS: личные каталоги сессий и явный отказ на мусор', () => {
	assert.deepEqual(parseSessionDirs(''), {});
	assert.deepEqual(parseSessionDirs('603522950:/srv/a/livbig,710223847:/srv/a/partner'), {
		603522950: '/srv/a/livbig',
		710223847: '/srv/a/partner',
	});
	assert.throws(() => parseSessionDirs('нет-id:/srv/a'), /нужен telegram id/);
	assert.throws(() => parseSessionDirs('42:relative/path'), /абсолютным/);
	assert.throws(() => parseSessionDirs('42:/srv/a,42:/srv/b'), /дважды/);
});
