/**
 * Сквозной путь Дворецкого: апдейт Telegram → мост → настоящий pi в зоне профиля → ответ в чат.
 *
 * Подменены только внешние сервисы (Bot API и модель/STT), оба — HTTP на 127.0.0.1.
 * Здесь проверяется главное отличие от Ассистента: два человека — две зоны, чужие и группы молчат.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { TRANSCRIPT, startFakeModel } from './fake-model.js';
import { startFakeTelegram } from './fake-telegram.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = '123456789:E2E-helper-token-not-a-real-one';
const LIVBIG = { id: 1001, is_bot: false, first_name: 'Владелец' };
const ALINA = { id: 2002, is_bot: false, first_name: 'Алина' };
const STRANGER = { id: 3003, is_bot: false, first_name: 'Посторонний' };

let model;
let telegram;
let root;
let bridge;
const log = [];
let messageId = 700;

const textOf = (call) => String(call.caption ?? call.text ?? '');
const answered = (chatId, pattern) => (call) =>
	call.chatId === Number(chatId) && (call.kind === 'message' || call.kind === 'edit') && pattern.test(textOf(call));

function update({ chat, from, text }) {
	messageId += 1;
	return { message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat, from, text } };
}

/** Зона профиля: рабочая папка с правилами, каталог агента на фейковую модель, папка сессий. */
function makeZone(slug, modelBaseUrl) {
	const home = join(root, 'users', slug);
	for (const dir of [join(home, 'work', 'files', 'inbox'), join(home, 'work', 'files', 'outbox'), join(home, 'pi', 'sessions')]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(home, 'work', 'AGENTS.md'), `# AGENTS.md — зона ${slug}\n\nТы Дворецкий, зона ${slug}.`, 'utf8');
	writeFileSync(
		join(home, 'pi', 'models.json'),
		JSON.stringify({
			providers: {
				e2e: {
					baseUrl: modelBaseUrl,
					api: 'openai-completions',
					apiKey: 'e2e-key',
					models: [
						{
							id: 'e2e-model',
							name: 'E2E Model',
							input: ['text'],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 32_000,
							maxOutputTokens: 1024,
							reasoning: false,
						},
					],
				},
			},
		}),
		'utf8',
	);
	writeFileSync(
		join(home, 'pi', 'settings.json'),
		JSON.stringify({
			defaultModel: 'e2e/e2e-model',
			packages: [join(REPO, '..', 'app')],
		}),
		'utf8',
	);
	return home;
}

before(async () => {
	model = await startFakeModel();
	telegram = await startFakeTelegram({ token: TOKEN });
	root = mkdtempSync(join(tmpdir(), 'dv-e2e-'));
	makeZone('livbig', model.baseUrl);
	makeZone('aliiinam', model.baseUrl);

	const env = {
		...process.env,
		HELPER_ROOT: root,
		HELPER_PROFILES: 'livbig:1001:admin,aliiinam:2002',
		PI_TG_BOT_TOKEN: TOKEN,
		PI_TG_API_ROOT: telegram.apiRoot,
		PI_TG_LOG_DIR: join(root, 'logs'),
		PI_TG_STATE_FILE: join(root, 'state.json'),
		PI_TG_RICH: 'off',
		PI_TG_DRAFT: 'off',
		PI_TG_LOG: 'info',
		PI_TG_CLI_PATH: join(REPO, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
		OPENROUTER_API_KEY: 'e2e-stt-key',
		STT_BASE_URL: `http://127.0.0.1:${model.port}/stt`,
		STT_MODEL: 'openai/whisper-large-v3',
		PI_OFFLINE: '1',
		PI_SKIP_VERSION_CHECK: '1',
		PI_TELEMETRY: '0',
	};
	bridge = spawn(process.execPath, ['src/main.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
	bridge.stdout.on('data', (chunk) => log.push(chunk.toString()));
	bridge.stderr.on('data', (chunk) => log.push(chunk.toString()));
	bridge.on('exit', (code, signal) => log.push(`\n[мост завершился: ${code}/${signal}]\n`));

	await telegram.waitFor((call) => call.method === 'getMe' && call.kind === 'api', { timeoutMs: 30_000, label: 'getMe' });
	await telegram.waitFor((call) => call.method === 'getUpdates', { timeoutMs: 30_000, label: 'опрос Telegram' });
	if (bridge.exitCode !== null) throw new Error(`мост упал на старте (${bridge.exitCode}):\n${log.join('')}`);
});

after(async () => {
	if (bridge?.exitCode === null) {
		bridge.kill('SIGTERM');
		await new Promise((done) => {
			const timer = setTimeout(() => {
				bridge.kill('SIGKILL');
				done();
			}, 10_000);
			bridge.on('exit', () => {
				clearTimeout(timer);
				done();
			});
		});
	}
	await telegram?.close();
	await model?.close();
	if (root) rmSync(root, { recursive: true, force: true });
	// E2E_LOG=1 — хвост журнала моста: без него причина «ничего не пришло» не видна.
	if (process.env.E2E_LOG === '1') console.error(`\n--- журнал моста ---\n${log.join('').split('\n').slice(-60).join('\n')}`);
});

test('(а) каждый человек работает в своей зоне: свои сессии, свой ответ', async () => {
	telegram.push(update({ chat: { id: LIVBIG.id, type: 'private' }, from: LIVBIG, text: 'привет, это владелец' }));
	await telegram.waitFor(answered(LIVBIG.id, /Слышал: привет, это владелец/), { label: 'ответ владельцу' });

	telegram.push(update({ chat: { id: ALINA.id, type: 'private' }, from: ALINA, text: 'привет, это Алина' }));
	await telegram.waitFor(answered(ALINA.id, /Слышал: привет, это Алина/), { label: 'ответ Алине' });

	const files = (slug) => {
		const dir = join(root, 'users', slug, 'pi', 'sessions');
		return readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('.jsonl'));
	};
	assert.equal(files('livbig').length, 1, 'у владельца ровно одна сессия');
	assert.equal(files('aliiinam').length, 1, 'у Алины ровно одна сессия');
});

test('(б) постороннему — молчание, без единого сообщения', async () => {
	const before = telegram.calls.filter((call) => call.kind !== 'api').length;
	telegram.push(update({ chat: { id: STRANGER.id, type: 'private' }, from: STRANGER, text: 'я тоже хочу' }));
	await new Promise((resolve) => setTimeout(resolve, 2500));
	const after = telegram.calls.filter((call) => call.kind !== 'api').length;
	assert.equal(after, before, 'посторонний не получил ни одного сообщения');
	assert.equal(model.requests.length, 2, 'и модель для него не звали');
});

test('(в) группа игнорируется: сессия не создаётся, ответа нет', async () => {
	const group = { id: -100500, type: 'supergroup', title: 'Семья' };
	const before = telegram.calls.filter((call) => call.kind !== 'api').length;
	telegram.push(update({ chat: group, from: LIVBIG, text: 'привет из группы' }));
	await new Promise((resolve) => setTimeout(resolve, 2000));
	assert.equal(telegram.calls.filter((call) => call.kind !== 'api').length, before, 'в группу ничего не ушло');
	assert.equal(existsSync(join(root, 'users', 'livbig', 'pi', 'sessions')), true);
});

test('(г) файл из ответа уходит документом, если он в своём outbox', async () => {
	const outbox = join(root, 'users', 'livbig', 'work', 'files', 'outbox');
	writeFileSync(join(outbox, 'заметка.txt'), 'привет', 'utf8');
	telegram.push(
		update({
			chat: { id: LIVBIG.id, type: 'private' },
			from: LIVBIG,
			text: `отправь файл [file:${join(outbox, 'заметка.txt')}]`,
		}),
	);
	const document = await telegram.waitFor((call) => call.kind === 'document' && call.chatId === LIVBIG.id, {
		timeoutMs: 60_000,
		label: 'документ в приватный чат',
	});
	assert.equal(document.fileName, 'заметка.txt');
});

test('(д) память: «запомни» пишет в свою базу, второй человек её не видит', async () => {
	telegram.push(
		update({ chat: { id: LIVBIG.id, type: 'private' }, from: LIVBIG, text: 'запомни: люблю чай с молоком' }),
	);
	await telegram.waitFor(answered(LIVBIG.id, /Запомнил/), { timeoutMs: 60_000, label: 'подтверждение записи' });

	const db = new DatabaseSync(join(root, 'users', 'livbig', 'memory.db'), { readOnly: true });
	const rows = db.prepare('SELECT kind, text FROM facts').all();
	db.close();
	assert.equal(rows.length, 1, 'одна запись в своей базе');
	assert.match(rows[0].text, /чай с молоком/);
	const other = new DatabaseSync(join(root, 'users', 'aliiinam', 'memory.db'), { readOnly: true });
	assert.equal(other.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 0, 'в чужой базе пусто');
	other.close();

	telegram.push(
		update({ chat: { id: LIVBIG.id, type: 'private' }, from: LIVBIG, text: 'что помнишь?' }),
	);
	await telegram.waitFor(answered(LIVBIG.id, /чай с молоком/), { timeoutMs: 60_000, label: 'recall нашёл запись' });
});

test('(е) у второго человека своя память: чужие факты не всплывают', async () => {
	telegram.push(
		update({ chat: { id: ALINA.id, type: 'private' }, from: ALINA, text: 'запомни: аллергия на пыль' }),
	);
	await telegram.waitFor(answered(ALINA.id, /Запомнил/), { timeoutMs: 60_000, label: 'запись Алины' });
	telegram.push(update({ chat: { id: ALINA.id, type: 'private' }, from: ALINA, text: 'что помнишь?' }));
	const answer = await telegram.waitFor(answered(ALINA.id, /Помню/), { timeoutMs: 60_000, label: 'recall Алины' });
	assert.match(textOf(answer), /аллергия на пыль/);
	assert.doesNotMatch(textOf(answer), /чай с молоком/, 'чужой факт не попал в её память');
});

test('(ж) самоулучшение: агент правит свои AGENTS.md, копия — в .history', async () => {
	const rules = join(root, 'users', 'livbig', 'work', 'AGENTS.md');
	telegram.push(
		update({
			chat: { id: LIVBIG.id, type: 'private' },
			from: LIVBIG,
			text: `добавь правило [path:${rules}]`,
		}),
	);
	await telegram.waitFor(answered(LIVBIG.id, /Правило: .*(wrote|записан)/i), { timeoutMs: 60_000, label: 'правка правил' });
	const history = readdirSync(join(root, 'users', 'livbig', 'work', '.history'));
	assert.equal(history.length, 1, 'старая версия сохранена');
	assert.match(readFileSyncFile(rules), /проверка самоулучшения/);
});

test('(з) чужую зону правка не трогает: guard отвечает отказом', async () => {
	const foreign = join(root, 'users', 'aliiinam', 'work', 'AGENTS.md');
	const before = readFileSyncFile(foreign);
	telegram.push(
		update({ chat: { id: LIVBIG.id, type: 'private' }, from: LIVBIG, text: `добавь правило [path:${foreign}]` }),
	);
	await telegram.waitFor(answered(LIVBIG.id, /чужая зона/), { timeoutMs: 60_000, label: 'отказ guard' });
	assert.equal(readFileSyncFile(foreign), before, 'файл чужой зоны не изменён');
});

function readFileSyncFile(path) {
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

test('(и) админ-доступ: владелец смотрит историю Алины, Алина — получает отказ', async () => {
	telegram.push(update({ chat: { id: LIVBIG.id, type: 'private' }, from: LIVBIG, text: '/admin history aliiinam 5' }));
	const history = await telegram.waitFor(answered(LIVBIG.id, /История aliiinam/), {
		timeoutMs: 60_000,
		label: 'история чужой зоны для владельца',
	});
	assert.match(textOf(history), /аллергия на пыль|запомни/i, 'в истории видны сообщения Алины');

	telegram.push(update({ chat: { id: ALINA.id, type: 'private' }, from: ALINA, text: '/admin history livbig' }));
	await telegram.waitFor(answered(ALINA.id, /Недоступно/), { timeoutMs: 30_000, label: 'отказ Алине' });

	const audit = readFileSync(join(root, 'logs', 'admin-audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
	assert.equal(audit.length, 1, 'каждый админ-просмотр — строка аудита');
	assert.equal(audit[0].by, 'livbig');
	assert.equal(audit[0].target, 'aliiinam');
});

test('(к) голосовое: расшифровка доходит до модели, ответ — в чат', async () => {
	messageId += 1;
	telegram.push({
		message: {
			message_id: messageId,
			date: Math.floor(Date.now() / 1000),
			chat: { id: LIVBIG.id, type: 'private' },
			from: LIVBIG,
			voice: { file_id: 'voice-1', file_unique_id: 'v1', duration: 4, file_size: 2048, mime_type: 'audio/ogg' },
		},
	});
	await telegram.waitFor(answered(LIVBIG.id, new RegExp(`Слышал: .*${TRANSCRIPT}`)), {
		timeoutMs: 60_000,
		label: 'ответ на голосовое',
	});
	assert.ok(model.sttRequests.length > 0, 'фейковый STT вызван');
});
