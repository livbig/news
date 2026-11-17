/**
 * End-to-end проверка моста без Telegram: настоящий grammY-бот с transformer вместо Bot API
 * (документированный способ тестирования grammY) + поддельные процессы pi.
 * Проверяются FR1–FR5 по наблюдаемым вызовам API, созданным процессам и состоянию на диске.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Bot } from 'grammy';

import { createBridge } from '../src/bridge.js';
import { createLogger } from '../src/log.js';
import { RICH_RETRY_MESSAGES } from '../src/rich.js';
import { createState } from '../src/state.js';

const BOT_INFO = {
	id: 1,
	is_bot: true,
	first_name: 'test',
	username: 'test_bot',
	can_join_groups: false,
	can_read_all_group_messages: false,
	supports_inline_queries: false,
};
const TOKEN = '123456789:TESTTOKENFORUNITSONLY';
const USER = 42;
const CHAT = 100;
const NOW = Date.now();

const SESSIONS = [
	{
		path: '/sessions/newest.jsonl',
		id: 'aaaa1111-0000-0000-0000-000000000001',
		cwd: '/Users/me/project-a',
		name: 'правки роутера',
		created: new Date(NOW - 3_600_000),
		modified: new Date(NOW - 60_000),
		messageCount: 12,
		firstMessage: 'поправь роутер',
	},
	{
		path: '/sessions/older.jsonl',
		id: 'bbbb2222-0000-0000-0000-000000000002',
		cwd: '/Users/me/project-b',
		name: undefined,
		created: new Date(NOW - 86_400_000),
		modified: new Date(NOW - 7_200_000),
		messageCount: 3,
		firstMessage: 'длинное первое сообщение для проверки обрезки в списке сессий',
	},
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Поддельный процесс pi: помнит опции запуска и отдаёт события своим подписчикам. */
function fakePi(options, index, { supportsImages = false } = {}) {
	const calls = [];
	const listeners = new Set();
	const boundPath = Array.isArray(options.args) && options.args[0] === '--session' ? options.args[1] : undefined;
	const session = {
		sessionFile: boundPath,
		sessionId: boundPath ? (boundPath.includes('newest') ? SESSIONS[0].id : SESSIONS[1].id) : `new-${index}`,
		sessionName: boundPath ? undefined : 'новая',
		messageCount: boundPath ? 12 : 0,
		pendingMessageCount: 0,
		thinkingLevel: 'medium',
		isStreaming: false,
		model: { provider: 'deepseek', id: 'deepseek-flash' },
	};
	return {
		options,
		calls,
		session,
		supportsImages,
		namesOf(method) {
			return calls.filter(([name]) => name === method);
		},
		/** Сессия «появилась на диске» после первого сообщения. */
		become(path) {
			session.sessionFile = path;
			session.sessionId = `became-${index}`;
		},
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
		async start() {
			calls.push(['start']);
		},
		async stop() {
			calls.push(['stop']);
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async getState() {
			calls.push(['getState']);
			return { ...session };
		},
		async getSessionStats() {
			calls.push(['getSessionStats']);
			return {
				totalMessages: 5,
				tokens: { input: 10_000, output: 2000, cacheRead: 500, cacheWrite: 100 },
				cost: 0.042,
				contextUsage: { tokens: 12_600, contextWindow: 200_000, percent: 6 },
			};
		},
		async getAvailableModels() {
			calls.push(['getAvailableModels']);
			return [
				{ provider: 'deepseek', id: 'deepseek-flash' },
				{ provider: 'deepseek', id: 'deepseek-pro' },
			];
		},
		async getCommands() {
			calls.push(['getCommands']);
			return [
				{ name: 'goal', description: 'Цели', source: 'extension' },
				{ name: 'skill:ponytail', description: 'Ленивый режим', source: 'skill' },
			];
		},
		async getAvailableThinkingLevels() {
			return ['off', 'medium', 'high'];
		},
		promptResult: 'started',
		async prompt(text, images, streamingBehavior) {
			calls.push(images === undefined ? ['prompt', text] : ['prompt', text, images]);
			this.promptBehavior = streamingBehavior;
			return this.promptResult;
		},
		async abort() {
			calls.push(['abort']);
		},
		async waitForIdle() {
			calls.push(['waitForIdle']);
		},
		async setModel(provider, modelId) {
			calls.push(['setModel', provider, modelId]);
			session.model = { provider, id: modelId };
			return { provider, id: modelId };
		},
		async setThinkingLevel(level) {
			calls.push(['setThinkingLevel', level]);
			session.thinkingLevel = level;
		},
		async setSessionName(name) {
			calls.push(['setSessionName', name]);
			session.sessionName = name;
		},
		async compact(instructions) {
			calls.push(['compact', instructions]);
			return { tokensBefore: 100_000, estimatedTokensAfter: 20_000 };
		},
		sendRaw(record) {
			calls.push(['sendRaw', record]);
			return true;
		},
	};
}

async function harness({
	allowedUserId = 'default',
	stateFile,
	exists = () => true,
	richMethodsFail = false,
	supportsImages = false,
	config = {},
	fetch: fetchImpl = globalThis.fetch,
} = {}) {
	// 'default' → спарен с USER, null → бот ещё не спарен, число → задан явно
	const configuredUser = allowedUserId === 'default' ? USER : (allowedUserId ?? undefined);
	const api = [];
	const bot = new Bot(TOKEN, { botInfo: BOT_INFO });
	bot.api.config.use(async (_prev, method, payload) => {
		api.push({ method, payload });
		// transformer обязан вернуть ApiResponse, иначе grammy сочтёт ответ ошибкой
		if (richMethodsFail && (method === 'sendRichMessage' || method === 'sendRichMessageDraft')) {
			return { ok: false, error_code: 400, description: 'Bad Request: method not found' };
		}
		if (method === 'getFile') {
			return { ok: true, result: { file_id: payload.file_id, file_unique_id: 'u', file_path: 'voice/file_1.oga', file_size: 1024 } };
		}
		if (method === 'sendMessage' || method === 'sendRichMessage') return { ok: true, result: { message_id: api.length } };
		return { ok: true, result: true };
	});
	const instances = [];
	const file = stateFile ?? join(await mkdtemp(join(tmpdir(), 'pi-tg-bridge-')), 'state.json');
	const state = createState({ file });
	await state.load();
	const bridge = createBridge({
		bot,
		state,
		config: {
			cwd: '/Users/me/project-a',
			draftEnabled: true,
			timeoutMs: 60_000,
			idleMs: 600_000,
			maxIdleSessions: 3,
			allowedUserId: configuredUser,
			...config,
		},
		log: createLogger({ level: 'silent' }),
		SessionManager: { listAll: async () => SESSIONS },
		exists,
		cliPath: '/fake/cli.js',
		fetch: fetchImpl,
		createPi: (options) => {
			const instance = fakePi(options, instances.length + 1, { supportsImages });
			instances.push(instance);
			return instance;
		},
	});
	bridge.install();
	return { bot, state, bridge, api, instances, file, pi: () => instances.at(-1) };
}

/** Наши ответы уходят rich-сообщениями ({html}) с фолбэком на sendMessage ({text}). */
const sentOf = (api) => api.filter((call) => call.method === 'sendMessage' || call.method === 'sendRichMessage');
const textOfCall = (call) => call.payload?.text ?? call.payload?.rich_message?.html ?? call.payload?.rich_message?.markdown ?? '';

function textOf(api, index = -1) {
	return textOfCall(sentOf(api).at(index) ?? {});
}

const editedTextOf = (api) => api.filter((call) => call.method === 'editMessageText').at(-1)?.payload.text ?? '';
const buttonsOf = (call) => call?.payload?.reply_markup?.inline_keyboard?.flat() ?? [];

async function message(
	bot,
	text,
	{ updateId = 1, messageId = 10, userId = USER, chatId = CHAT, chatType = 'private', replyTo, threadId } = {},
) {
	await bot.handleUpdate({
		update_id: updateId,
		message: {
			message_id: messageId,
			date: Math.floor(NOW / 1000),
			chat: { id: chatId, type: chatType, is_forum: threadId !== undefined },
			from: { id: userId, is_bot: false, first_name: 'Тест' },
			text,
			...(threadId === undefined ? {} : { message_thread_id: threadId }),
			...(replyTo ? { reply_to_message: replyTo } : {}),
		},
	});
	await sleep(20);
}

async function voice(
	bot,
	{ updateId = 1, messageId = 10, userId = USER, chatId = CHAT, chatType = 'private', duration = 222, fileSize = 1024 } = {},
) {
	await bot.handleUpdate({
		update_id: updateId,
		message: {
			message_id: messageId,
			date: Math.floor(NOW / 1000),
			chat: { id: chatId, type: chatType },
			from: { id: userId, is_bot: false, first_name: 'Тест' },
			voice: { file_id: 'voice-1', file_unique_id: 'unique-1', duration, file_size: fileSize, mime_type: 'audio/ogg' },
		},
	});
	await sleep(20);
}

async function photoMessage(
	bot,
	{
		updateId = 1,
		messageId = 10,
		userId = USER,
		chatId = CHAT,
		caption,
		sizes = [
			{ file_id: 'small', file_unique_id: 'small-u', width: 10, height: 10, file_size: 10 },
			{ file_id: 'big', file_unique_id: 'big-u', width: 100, height: 100, file_size: 100 },
		],
	} = {},
) {
	await bot.handleUpdate({
		update_id: updateId,
		message: {
			message_id: messageId,
			date: Math.floor(NOW / 1000),
			chat: { id: chatId, type: 'private' },
			from: { id: userId, is_bot: false, first_name: 'Тест' },
			photo: sizes,
			...(caption === undefined ? {} : { caption }),
		},
	});
	await sleep(30);
}

async function documentMessage(
	bot,
	{
		updateId = 1,
		messageId = 10,
		userId = USER,
		chatId = CHAT,
		caption,
		document = {
			file_id: 'doc-1',
			file_unique_id: 'doc-u',
			file_name: 'смета.pdf',
			mime_type: 'application/pdf',
			file_size: 1024,
		},
	} = {},
) {
	await bot.handleUpdate({
		update_id: updateId,
		message: {
			message_id: messageId,
			date: Math.floor(NOW / 1000),
			chat: { id: chatId, type: 'private' },
			from: { id: userId, is_bot: false, first_name: 'Тест' },
			document,
			...(caption === undefined ? {} : { caption }),
		},
	});
	await sleep(30);
}

/** mock fetch: Telegram-файл отдаёт байты, OpenRouter — транскрипт или ошибку. */
function voiceFetch({ transcript = 'привет из голоса', fail = false } = {}) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url: String(url), init });
		if (String(url).startsWith('https://api.telegram.org/file/')) {
			return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
		}
		if (fail) return { ok: false, status: 502, text: async () => 'плохой шлюз' };
		return { ok: true, status: 200, json: async () => ({ text: transcript }) };
	};
	return { calls, impl };
}

const ASSISTANT_PROJECTS = [
	{
		id: 12,
		label: 'Аман склады Любучанск',
		type: 'склад',
		status: 'active',
		active_estimate_id: 52,
		estimates: [
			{ id: 50, object_id: 12, branch: 'main', seq: 1, status: 'draft', total: 340306.15 },
			{ id: 51, object_id: 12, branch: 'budget', seq: 1, status: 'draft', total: 326978 },
			{ id: 52, object_id: 12, branch: 'optimal', seq: 1, status: 'draft', total: 389740 },
		],
	},
	{ id: 13, label: 'Офис на Тверской', type: 'офис', status: 'active', active_estimate_id: 60, estimates: [{ id: 60, object_id: 13, branch: 'main', seq: 1, status: 'draft', total: 100000 }] },
];

const ASSISTANT_ESTIMATES = {
	51: {
		id: 51,
		object: { id: 12, label: 'Аман склады Любучанск', type: 'склад' },
		client: 'Аман',
		branch: 'budget',
		seq: 1,
		status: 'draft',
		total: 326978,
		rows: [
			{ sku: 'A-1', name: 'Шлагбаум', unit: 'шт', qty: 2, price: 1500, sum: 3000 },
			{ sku: 'A-2', name: 'Привод', unit: 'шт', qty: 1, price: 323978, sum: 323978 },
		],
		meta: { discountPct: 5 },
	},
	52: {
		id: 52,
		object: { id: 12, label: 'Аман склады Любучанск', type: 'склад' },
		client: 'Аман',
		branch: 'optimal',
		seq: 1,
		status: 'draft',
		total: 389740,
		rows: [{ sku: 'B-1', name: 'Привод', unit: 'шт', qty: 1, price: 389740, sum: 389740 }],
		meta: { discountPct: 5 },
	},
};

/** mock fetch локального API ассистента: проекты (активные и архив), сметы, PDF, архивирование. */
function assistantFetch({ projects = ASSISTANT_PROJECTS, estimates = ASSISTANT_ESTIMATES, pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]), fail } = {}) {
	const calls = [];
	const list = projects.map((object) => ({ ...object }));
	const reply = (data) => ({ ok: true, status: 200, json: async () => data });
	const impl = async (url, init = {}) => {
		calls.push(String(url));
		if (fail) throw fail;
		const parsed = new URL(String(url));
		if (parsed.pathname === '/api/projects') {
			const archived = parsed.searchParams.get('archived') === '1';
			return reply(list.filter((object) => (object.status === 'archived') === archived));
		}
		if (parsed.pathname === '/api/object/archive') {
			const body = JSON.parse(init.body);
			const object = list.find((item) => item.id === Number(body.id));
			const status = body.archived ? 'archived' : 'active';
			const changed = object.status !== status;
			object.status = status;
			return reply({ objectId: object.id, label: object.label, status, changed });
		}
		if (parsed.pathname === '/api/estimate') {
			const data = estimates[parsed.searchParams.get('id')];
			return data
				? { ok: true, status: 200, json: async () => data }
				: { ok: false, status: 404, json: async () => ({ error: 'нет такой сметы' }) };
		}
		if (parsed.pathname === '/api/pdf')
			return {
				ok: true,
				status: 200,
				headers: { get: () => encodeURIComponent('Смета №0209 — ПЕРИМЕТР..pdf') },
				arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength),
			};
		throw new Error(`неожиданный запрос ${url}`);
	};
	return { calls, impl };
}

async function callback(bot, data, { updateId = 500, userId = USER, chatId = CHAT } = {}) {
	await bot.handleUpdate({
		update_id: updateId,
		callback_query: {
			id: `cb-${updateId}-${chatId}`,
			from: { id: userId, is_bot: false, first_name: 'Тест' },
			message: {
				message_id: 99,
				date: Math.floor(NOW / 1000),
				chat: { id: chatId, type: 'private' },
				from: { id: 1, is_bot: true, first_name: 'bot' },
				text: 'список',
			},
			chat_instance: 'x',
			data,
		},
	});
	await sleep(20);
}

test('посторонний пользователь не управляет pi', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'привет', { userId: 999 });
	assert.equal(instances.length, 0);
	assert.match(textOf(api), /привязан к другому аккаунту/);
});

test('белый список фаундеров: чужие получают отказ, фаундеры работают', async () => {
	const { bot, api, instances } = await harness({ config: { allowedUserIds: [USER, 77] } });

	await message(bot, 'привет', { userId: 999 });
	assert.equal(instances.length, 0, 'посторонний не поднимает процесс pi');
	assert.match(textOf(api), /только с фаундерами/);

	await message(bot, 'привет', { userId: 77 });
	assert.equal(instances.length, 1, 'второй фаундер получает ответ');
});

test('/start у неспаренного бота привязывает владельца и сохраняет его', async () => {
	const { bot, state, api } = await harness({ allowedUserId: null });
	await message(bot, '/start');
	assert.equal(state.get().allowedUserId, USER);
	assert.match(textOf(api), /Дворецкий/);
	assert.equal(sentOf(api).at(-1).payload.reply_markup, undefined, 'приветствие без кнопок проектов');
});


test('мультисессии: два чата работают каждый в своей сессии и не мешают друг другу', async () => {
	const { bot, instances, bridge } = await harness();
	await message(bot, 'задача в первом', { chatId: 100, updateId: 1 });
	await message(bot, 'задача во втором', { chatId: 200, updateId: 2 });

	assert.equal(instances.length, 2, 'на каждый чат свой процесс');
	assert.deepEqual(instances[0].namesOf('prompt'), [['prompt', 'задача в первом']]);
	assert.deepEqual(instances[1].namesOf('prompt'), [['prompt', 'задача во втором']]);
	assert.equal(bridge.pool.size(), 2);
});

test('FR3: /status, /model, /thinking, /commands', async () => {
	const { bot, state, instances, api, bridge } = await harness();
	await message(bot, 'первый промпт');
	instances[0].become('/sessions/mine.jsonl');
	instances[0].emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ок' }], stopReason: 'stop' }] });
	instances[0].emit({ type: 'agent_settled', aborted: false });
	await sleep(30);
	await message(bot, '/status', { updateId: 2 });
	const status = textOf(api);
	assert.match(status, /<table bordered striped compact>/, '/status — таблица');
	assert.match(status, /<td>Модель<\/td><td><code>deepseek\/deepseek-flash<\/code><\/td>/);
	assert.match(status, /<td>Размышления<\/td><td>medium<\/td>/);
	assert.match(status, /<td>Токены<\/td><td>↑10k ↓2\.0k · R500 W100<\/td>/);
	assert.match(status, /<td>Стоимость<\/td><td>\$0\.042<\/td>/);
	assert.match(status, /<td>Контекст<\/td><td>6% из 200k<\/td>/);
	assert.match(status, /<td>Процессов pi<\/td>/);

	await message(bot, '/model deepseek/deepseek-pro', { updateId: 3 });
	assert.deepEqual(instances[0].namesOf('setModel'), [['setModel', 'deepseek', 'deepseek-pro']]);

	await message(bot, '/model пустота', { updateId: 4 });
	assert.match(textOf(api), /не найдена/);
	assert.equal(instances[0].namesOf('setModel').length, 1);

	await message(bot, '/thinking high', { updateId: 5 });
	assert.deepEqual(instances[0].namesOf('setThinkingLevel'), [['setThinkingLevel', 'high']]);

	await message(bot, '/thinking вверх', { updateId: 6 });
	assert.match(textOf(api), /Неизвестный уровень/);

	const before = instances.length;
	await message(bot, '/restart', { updateId: 9 });
	assert.equal(instances.length, before, 'как и раньше: нового процесса по /restart не поднимаем');
	assert.equal(state.getSession(CHAT)?.sessionPath, '/sessions/mine.jsonl', 'сессия осталась привязанной');
	assert.equal(bridge.pool.size(), 0, 'зависший процесс погашен');
});

test('FR3: команды расширений уходят в prompt, неизвестная — отказ с подсказкой', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, '/goal список');
	assert.deepEqual(instances[0].namesOf('prompt'), [['prompt', '/goal список']]);

	await message(bot, '/goalz', { updateId: 2 });
	assert.match(textOf(api), /Не знаю команду \/goalz/);
	assert.equal(instances[0].namesOf('prompt').length, 1);
});

test('FR4: текст идёт в pi, дельты — в живое сообщение, финал — отдельным сообщением', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'сделай ревью');
	const pi = instances[0];
	assert.deepEqual(pi.namesOf('prompt'), [['prompt', 'сделай ревью']]);

	pi.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
	pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Смотрю ' } });
	pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'файлы' } });
	await sleep(20);

	const drafts = api.filter((call) => call.method === 'sendRichMessageDraft');
	assert.ok(drafts.length >= 1, 'живое сообщение обновляется rich-черновиком');
	// строка хода — курсивом: смешная фраза и сразу укороченный статус (токены, контекст, стоимость)
	assert.equal(
		drafts[0].payload.rich_message.markdown,
		'_собираюсь с мыслями…_\n_↑10k ↓2.0k · 6% из 200k · $0.042_',
	);
	assert.equal(drafts[0].payload.can_stop, true);

	// троттлинг: обе дельты уезжают одним следующим обновлением
	await sleep(900);
	const later = api.filter((call) => call.method === 'sendRichMessageDraft');
	assert.equal(later.length, 2);
	assert.equal(
		later.at(-1).payload.rich_message.markdown,
		'_собираюсь с мыслями…_\n_↑10k ↓2.0k · 6% из 200k · $0.042_\n\nСмотрю файлы',
	);

	pi.emit({ type: 'tool_execution_start', toolName: 'read' });
	await sleep(900);
	assert.match(api.filter((c) => c.method === 'sendRichMessageDraft').at(-1).payload.rich_message.markdown, /⚙ read/);

	pi.emit({
		type: 'agent_end',
		messages: [{ role: 'assistant', content: [{ type: 'text', text: '**готово**' }], stopReason: 'stop' }],
	});
	pi.emit({ type: 'agent_settled', aborted: false });
	await sleep(30);

	const sent = api.filter((call) => call.method === 'sendRichMessage');
	assert.equal(sent.at(-1).payload.rich_message.markdown, '**готово**', 'markdown отдаём Telegram как есть');
});

test('FR4: мысли модели не попадают в чат — вместо них смешные фразы, меняющиеся по таймеру', async () => {
	const { bot, instances, api, bridge } = await harness();
	await message(bot, 'подумай');
	const pi = instances[0];
	const lastDraft = () => api.filter((call) => call.method === 'sendRichMessageDraft').at(-1).payload.rich_message.markdown;

	pi.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
	pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
	pi.emit({
		type: 'message_update',
		assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'СЕКРЕТНАЯ МЫСЛЬ про смету' },
	});
	await sleep(900);
	const first = lastDraft();
	assert.equal(first.split('\n')[0], '_собираюсь с мыслями…_', 'пока идёт ход — смешная фраза');
	assert.equal(first.includes('СЕКРЕТНАЯ'), false, 'текст мыслей модели в чат не попадает');
	assert.match(first.split('\n')[1], /^_↑10k ↓2\.0k · 6% из 200k · \$0\.042_$/, 'цифры — второй строкой');

	// таймер фразы: через 4 с от начала хода — следующая, содержимое мысли не при чём
	const entry = bridge.pool.list()[0];
	entry.turn.startedAt = Date.now() - 4100;
	pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'ещё мысль' } });
	await sleep(900);
	const second = lastDraft();
	assert.equal(second.split('\n')[0], '_листаю память…_');
	assert.notEqual(first.split('\n')[0], second.split('\n')[0], 'фразы меняются');
	assert.equal(second.includes('ещё мысль'), false);

	// инструмент показывается как раньше и вытесняет фразу
	pi.emit({ type: 'tool_execution_start', toolName: 'bash' });
	await sleep(900);
	assert.equal(lastDraft().split('\n')[0], '_⚙ bash_');

	pi.emit({
		type: 'message_update',
		assistantMessageEvent: { type: 'thinking_end', content: `${'долгое рассуждение '.repeat(20)}итог` },
	});
	await sleep(900);
	assert.equal(lastDraft().includes('долгое рассуждение'), false, 'и thinking_end не просачивается');
});

test('ответы команд уходят rich-сообщениями, при сбое rich — классика и повтор через N сообщений', async () => {
	const rich = await harness();
	await message(rich.bot, '/help');
	assert.equal(rich.api.filter((call) => call.method === 'sendRichMessage').length, 1, 'справка как rich');
	assert.ok(textOfCall(sentOf(rich.api)[0]).includes('<table bordered striped compact>'));

	const fallback = await harness({ richMethodsFail: true });
	await message(fallback.bot, '/help');
	await message(fallback.bot, '/help', { updateId: 2 });
	const richTries = () => fallback.api.filter((call) => call.method === 'sendRichMessage').length;
	assert.equal(richTries(), 1, 'rich пробуется один раз, дальше N сообщений — классикой');
	const plain = fallback.api.filter((call) => call.method === 'sendMessage');
	assert.equal(plain.length, 2, 'оба ответа ушли обычным сообщением');
	assert.equal(plain[0].payload.parse_mode, 'HTML');

	// после N сообщений rich пробуется снова, а не остаётся выключенным навсегда
	for (let index = 3; index <= RICH_RETRY_MESSAGES; index += 1) {
		await message(fallback.bot, '/help', { updateId: index });
	}
	assert.equal(richTries(), 1, 'внутри окна повтора rich не дёргаем');
	await message(fallback.bot, '/help', { updateId: RICH_RETRY_MESSAGES + 1 });
	assert.equal(richTries(), 2, 'после окна — повторная попытка rich');
});

test('FR4: если rich-методы недоступны, ход идёт классическим путём с HTML', async () => {
	const { bot, instances, api } = await harness({ richMethodsFail: true });
	await message(bot, 'сделай ревью');
	const pi = instances[0];
	pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'готовлю' } });
	await sleep(20);
	assert.equal(api.filter((call) => call.method === 'sendRichMessageDraft').length, 1, 'rich пробуется один раз');
	assert.equal(api.filter((call) => call.method === 'sendMessageDraft').length, 1);
	assert.equal(api.filter((call) => call.method === 'sendMessageDraft')[0].payload.can_stop, true);

	pi.emit({
		type: 'agent_end',
		messages: [{ role: 'assistant', content: [{ type: 'text', text: '**готово**' }], stopReason: 'stop' }],
	});
	pi.emit({ type: 'agent_settled', aborted: false });
	await sleep(30);
	const sent = sentOf(api);
	assert.equal(sent.at(-1).payload.text, '<b>готово</b>', 'классический путь конвертирует markdown в HTML');
	assert.equal(sent.at(-1).payload.parse_mode, 'HTML');
});

test('FR4: кнопка «стоп» в клиенте Telegram прерывает прогон', async () => {
	const { bot, instances } = await harness();
	await message(bot, 'долгая задача');
	await bot.handleUpdate({
		update_id: 900,
		stopped_message_generation: {
			chat: { id: CHAT, type: 'private' },
			draft_id: 123,
		},
	});
	await sleep(20);
	assert.equal(instances[0].namesOf('abort').length, 1);
});

test('падение процесса pi закрывает ход ошибкой и снимает занятость', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'задача');
	await message(bot, 'вторая задача', { updateId: 2 });
	assert.match(textOf(api), /в очереди \(позиция 1\)/);

	instances[0].emit({ type: 'pi_exit', code: 1, stderr: 'Error: boom\n    at x' });
	await sleep(30);

	const shown = api.filter((call) => ['sendRichMessage', 'sendMessage', 'editMessageText', 'sendRichMessageDraft'].includes(call.method));
	assert.ok(
		shown.some((call) => /процесс pi остановился/.test(textOfCall(call))),
		'человек видит, что процесс pi умер',
	);
	assert.ok(
		shown.some((call) => /повторите сообщение/.test(textOfCall(call))),
		'сообщение из очереди не потерялось молча',
	);
	assert.equal(instances[0].namesOf('stop').length >= 1, true, 'мёртвый процесс убран из пула');

	// мост не «занят»: следующее сообщение поднимает новый процесс
	await message(bot, 'ещё раз', { updateId: 3 });
	assert.equal(instances.length, 2);
	assert.deepEqual(instances[1].namesOf('prompt'), [['prompt', 'ещё раз']]);
});

test('FR5: после хода появившийся файл сессии уезжает в состояние', async () => {
	const { bot, state, instances } = await harness();
	await message(bot, 'первый промпт');
	assert.equal(state.getSession(CHAT), undefined, 'пока сессии нет на диске — маппинга нет');

	instances[0].become('/sessions/mine.jsonl');
	instances[0].emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ок' }], stopReason: 'stop' }] });
	instances[0].emit({ type: 'agent_settled', aborted: false });
	await sleep(40);

	assert.equal(state.getSession(CHAT).sessionPath, '/sessions/mine.jsonl');
	assert.equal(state.getSession(CHAT).sessionId, 'became-1');
});

/** Ход до конца: pi «создал» файл сессии и закрыл прогон — привязка чата пишется в state. */
async function finishTurnOn(instance, path) {
	instance.become(path);
	instance.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ок' }], stopReason: 'stop' }] });
	instance.emit({ type: 'agent_settled', aborted: false });
	await sleep(40);
}

test('одна сессия на чат: три сообщения подряд дают один и тот же файл', async () => {
	const { bot, state, instances } = await harness();
	const path = '/sessions/dm-100.jsonl';

	await message(bot, 'первое', { updateId: 1 });
	await finishTurnOn(instances[0], path);
	assert.equal(state.getSession(CHAT).sessionPath, path);

	await message(bot, 'второе', { updateId: 2 });
	await finishTurnOn(instances[0], path);
	await message(bot, 'третье', { updateId: 3 });
	await finishTurnOn(instances[0], path);

	assert.equal(instances.length, 1, 'процесс поднят один раз: сессия не пересоздаётся');
	assert.deepEqual(
		instances[0].namesOf('prompt').map((call) => call[1]),
		['первое', 'второе', 'третье'],
	);
	assert.equal(state.getSession(CHAT).sessionPath, path);
});

test('три чата — три сессии, тема форума сессию не меняет', async () => {
	const { bot, state, instances } = await harness();
	const GROUP = -1_003_432_441_991;

	await message(bot, 'личка Максима', { chatId: 100, updateId: 1 });
	await finishTurnOn(instances[0], '/sessions/dm-100.jsonl');
	await message(bot, 'личка владельца', { chatId: 200, updateId: 2 });
	await finishTurnOn(instances[1], '/sessions/dm-200.jsonl');
	await message(bot, '@test_bot общий чат', { chatId: GROUP, chatType: 'supergroup', updateId: 3 });
	await finishTurnOn(instances[2], '/sessions/group.jsonl');

	assert.deepEqual(Object.keys(state.get().chats).sort(), ['dm:100', 'dm:200', `group:${GROUP}`]);

	// та же группа, другая тема форума — та же сессия, новый процесс не поднимается
	await message(bot, '@test_bot в теме 42', { chatId: GROUP, chatType: 'supergroup', threadId: 42, updateId: 4 });
	await finishTurnOn(instances[2], '/sessions/group.jsonl');
	await message(bot, '@test_bot в теме 43', { chatId: GROUP, chatType: 'supergroup', threadId: 43, updateId: 5 });
	await finishTurnOn(instances[2], '/sessions/group.jsonl');
	assert.equal(instances.length, 3, 'темы форума не создают новых сессий');
	assert.equal(state.getSession(GROUP).sessionPath, '/sessions/group.jsonl');
	assert.deepEqual(instances[2].namesOf('prompt').map((call) => call[1]), ['общий чат', 'в теме 42', 'в теме 43'], 'адресация @бот снимается, темы идут в ту же сессию');
});

test('рестарт моста не заводит новый файл сессии', async () => {
	const { bot, state, instances, file } = await harness();
	await message(bot, 'до рестарта', { updateId: 1 });
	await finishTurnOn(instances[0], '/sessions/dm-100.jsonl');
	const bound = state.getSession(CHAT).sessionPath;

	const second = await harness({ stateFile: file });
	await message(second.bot, 'после рестарта', { updateId: 2 });
	assert.deepEqual(second.instances[0].options.args, ['--session', bound], 'поднят процесс на той же сессии');
	assert.equal(second.state.getSession(CHAT).sessionPath, bound);
});

test('файл сессии пропал → новая сессия и новая привязка в state', async () => {
	const { bot, state, instances } = await harness({ exists: (path) => path !== '/sessions/gone.jsonl' });
	state.setSession(CHAT, { sessionPath: '/sessions/gone.jsonl', sessionId: 'gone-1' });
	await state.save();

	await message(bot, 'после пропажи', { updateId: 1 });
	assert.equal(instances.length, 1);
	assert.notDeepEqual(instances[0].options.args, ['--session', '/sessions/gone.jsonl'], 'сессию по пропавшему файлу не поднимаем');
	await finishTurnOn(instances[0], '/sessions/fresh.jsonl');
	assert.equal(state.getSession(CHAT).sessionPath, '/sessions/fresh.jsonl', 'новая сессия записана');
});

test('FR5: сессия без файла на диске не пишется в состояние (процесс по ней не поднять)', async () => {
	const { bot, state } = await harness({ exists: (path) => path !== '/sessions/older.jsonl' });
	await message(bot, '/open 2');
	assert.equal(state.getSession(CHAT), undefined);
});

test('FR4: очередь входящих и /stop внутри одной сессии', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'первая задача');
	await message(bot, 'вторая задача', { updateId: 2 });
	assert.match(textOf(api), /в очереди \(позиция 1\)/);
	assert.deepEqual(instances[0].namesOf('prompt'), [['prompt', 'первая задача']]);

	instances[0].emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ок' }], stopReason: 'stop' }] });
	instances[0].emit({ type: 'agent_settled', aborted: false });
	await sleep(30);
	assert.deepEqual(instances[0].namesOf('prompt').at(-1), ['prompt', 'вторая задача']);

	await message(bot, 'stop', { updateId: 3 });
	assert.equal(instances[0].namesOf('abort').length, 1);
	assert.match(textOf(api), /Прерываю/);
});

test('FR4: ошибка провайдера показывается человеку, ход завершается', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'сломайся');
	instances[0].emit({
		type: 'agent_end',
		messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'нет ключа провайдера' }],
	});
	instances[0].emit({ type: 'agent_settled', aborted: false });
	await sleep(30);
	const shown = api.filter((call) => ['sendRichMessage', 'sendRichMessageDraft', 'sendMessageDraft', 'sendMessage', 'editMessageText'].includes(call.method));
	assert.ok(
		shown.some((call) => /нет ключа провайдера/.test(call.payload.rich_message?.markdown ?? call.payload.rich_message?.html ?? call.payload.text ?? '')),
		'ошибка провайдера видна человеку',
	);

	// после ошибки сессия снова свободна: следующий промпт не в очередь
	await message(bot, 'ещё раз', { updateId: 2 });
	assert.deepEqual(instances[0].namesOf('prompt').at(-1), ['prompt', 'ещё раз']);
});

test('статусы расширений из дочернего pi попадают в /status значками и балансом', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'привет');
	for (const [statusKey, statusText] of [
		['1-agent-skills', '👾'],
		['2-telegram-bridge', '📡'],
		['ponytail', '\u001b[38;2;1;2;3m●\u001b[39m 🐴 ponytail: ⚡ FULL'],
		['usage', 'deepseek USD 8.36'],
		['caffeinate', undefined],
	]) {
		instances[0].emit({ type: 'extension_ui_request', id: `s-${statusKey}`, method: 'setStatus', statusKey, statusText });
	}
	await sleep(20);
	await message(bot, '/status', { updateId: 2 });
	const status = textOf(api);
	assert.match(status, /<td>Скиллы<\/td><td>👾 📡 🐴<\/td>/);
	assert.match(status, /<td>Баланс API<\/td><td>deepseek USD 8\.36<\/td>/);
	assert.equal(status.includes('\u001b'), false, 'ANSI-коды не просачиваются в чат');

	// статус сняли — значок пропадает (наличие статуса = расширение включено)
	instances[0].emit({ type: 'extension_ui_request', id: 's-off', method: 'setStatus', statusKey: 'ponytail', statusText: undefined });
	await sleep(20);
	await message(bot, '/status', { updateId: 3 });
	assert.match(textOf(api), /<td>Скиллы<\/td><td>👾 📡<\/td>/);
});

test('диалог расширения не вешает ход: отвечаем cancelled и говорим в чат', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'работай');
	instances[0].emit({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Удалить всё?' });
	await sleep(20);
	assert.deepEqual(instances[0].namesOf('sendRaw'), [
		['sendRaw', { type: 'extension_ui_response', id: 'u1', cancelled: true }],
	]);
	assert.match(textOf(api), /Диалоги расширений в этой сборке не поддерживаются/);
});

test('остановка моста гасит все поднятые процессы pi', async () => {
	const { bot, bridge, instances } = await harness();
	await message(bot, 'первый', { chatId: 100, updateId: 1 });
	await message(bot, 'второй', { chatId: 200, updateId: 2 });
	assert.equal(bridge.pool.size(), 2);
	await bridge.stop();
	for (const instance of instances) assert.equal(instance.namesOf('stop').length, 1);
});

test('P0: если abort не отвечает, ход падает, процесс гасится и следующий поднимается свежим', async () => {
	const { bot, bridge, instances, api } = await harness();
	await message(bot, 'долгая задача');
	instances[0].abort = async () => {
		throw new Error('abort timeout');
	};

	await message(bot, '/stop', { updateId: 2 });
	await sleep(30);

	const shown = sentOf(api).map(textOfCall).join('\n');
	assert.match(shown, /процесс остановлен/);
	assert.equal(instances[0].namesOf('stop').length, 1, 'зависший процесс погашен');
	assert.equal(bridge.pool.size(), 0, 'записи в пуле нет');

	await message(bot, 'ещё раз', { updateId: 3 });
	assert.equal(instances.length, 2, 'следующее сообщение подняло новый процесс');
	assert.deepEqual(instances[1].namesOf('prompt'), [['prompt', 'ещё раз']]);
});

test('/stop без записи в пуле не поднимает процесс', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, '/stop');
	assert.equal(instances.length, 0, 'прерывать нечего — spawn не нужен');
	assert.match(textOf(api), /Нет активного прогона/);

	await message(bot, 'stop', { updateId: 2 });
	assert.equal(instances.length, 0);
});

test('watchdog: абсолютный потолок хода прерывает, гасит процесс и освобождает чат', async () => {
	const { bot, bridge, instances, api } = await harness({ config: { turnMaxMs: 40 } });
	await message(bot, 'зависни');
	const pi = instances[0];
	await sleep(80);

	assert.equal(pi.namesOf('abort').length, 1, 'потолок сначала прерывает ход');
	assert.equal(pi.namesOf('stop').length, 1, 'и гасит процесс');
	assert.equal(bridge.pool.size(), 0);
	assert.match(sentOf(api).map(textOfCall).join('\n'), /дольше 40 мс/);

	await message(bot, 'ещё раз', { updateId: 2 });
	assert.equal(instances.length, 2, 'следующее сообщение поднимает свежий процесс');
	assert.deepEqual(instances[1].namesOf('prompt'), [['prompt', 'ещё раз']]);
});

test('потолок процессов: сверх PI_TG_MAX_PROCESSES — понятная ошибка в чат, без spawn', async () => {
	const { bot, bridge, instances, api } = await harness({ config: { maxProcesses: 1 } });
	await message(bot, 'первый', { chatId: 100, updateId: 1 });
	assert.equal(instances.length, 1);

	await message(bot, 'второй', { chatId: 200, updateId: 2 });
	assert.match(textOf(api), /занято 1 сессий, попробуй позже или \/stop/);
	assert.equal(instances.length, 1, 'второй процесс не создавался');
	assert.equal(bridge.pool.size(), 1);
});

test('адресация: в личке — всё, в группе без @бот и без reply — молчание', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'привет в личку');
	assert.deepEqual(instances[0].namesOf('prompt'), [['prompt', 'привет в личку']]);

	const quiet = await harness();
	await message(quiet.bot, 'просто болтовня', { chatType: 'group', chatId: -100123 });
	assert.equal(quiet.instances.length, 0);
	assert.equal(sentOf(quiet.api).length, 0, 'бот не вмешивается в разговор группы');
});

test('адресация: @бот и reply на сообщение бота в группе дают ход, тег вырезается', async () => {
	const { bot, instances } = await harness();
	await message(bot, '@test_bot привет', { chatType: 'group', chatId: -100123 });
	assert.deepEqual(instances[0].namesOf('prompt'), [['prompt', 'привет']], 'тег не уходит в модель');
	instances[0].emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ок' }], stopReason: 'stop' }] });
	instances[0].emit({ type: 'agent_settled', aborted: false });
	await sleep(30);

	const botMessage = {
		message_id: 5,
		date: Math.floor(NOW / 1000),
		chat: { id: -100123, type: 'group' },
		from: { id: 1, is_bot: true, first_name: 'test', username: 'test_bot' },
		text: 'ответ бота',
	};
	await message(bot, 'это reply', { chatType: 'group', chatId: -100123, replyTo: botMessage, updateId: 2 });
	assert.deepEqual(instances[0].namesOf('prompt').at(-1), ['prompt', 'это reply']);
});

test('адресация: команды в группе работают без тега, PI_TG_REQUIRE_MENTION=false снимает фильтр', async () => {
	const commands = await harness();
	await message(commands.bot, '/help', { chatType: 'group', chatId: -100123 });
	assert.match(textOf(commands.api), /pi-telegram-bridge/);
	assert.equal(commands.instances.length, 0, 'справка не поднимает pi');

	const loose = await harness({ config: { requireMention: false } });
	await message(loose.bot, 'без тега', { chatType: 'group', chatId: -100123 });
	assert.deepEqual(loose.instances[0].namesOf('prompt'), [['prompt', 'без тега']]);
});

test('голос: скачивание, STT и префикс с длительностью уходят в сессию', async () => {
	const stt = voiceFetch({ transcript: 'привет из голоса' });
	const { bot, instances } = await harness({ config: { sttApiKey: 'test-key' }, fetch: stt.impl });
	await voice(bot, { duration: 222 });

	assert.deepEqual(instances[0].namesOf('prompt'), [['prompt', '[голос 3:42] привет из голоса']]);
	const request = stt.calls.find((call) => call.url.includes('/audio/transcriptions'));
	assert.ok(request, 'STT-запрос отправлен');
	assert.deepEqual(JSON.parse(request.init.body), {
		input_audio: { data: 'AQID', format: 'ogg' },
		language: 'ru',
		model: 'openai/whisper-large-v3',
	});
	assert.equal(request.init.headers.Authorization, 'Bearer test-key');
});

test('голос: лимиты 10 минут / 20 МБ и отсутствие ключа — текстом, без spawn', async () => {
	const stt = voiceFetch();
	const { bot, instances, api } = await harness({ config: { sttApiKey: 'test-key' }, fetch: stt.impl });
	await voice(bot, { duration: 601 });
	assert.match(textOf(api), /10 минут/);

	await voice(bot, { duration: 10, fileSize: 20 * 1024 * 1024 + 1, updateId: 2 });
	assert.match(textOf(api), /20 МБ/);
	assert.equal(stt.calls.length, 0, 'до скачивания дело не дошло');
	assert.equal(instances.length, 0);

	const noKey = await harness();
	await voice(noKey.bot);
	assert.match(textOf(noKey.api), /OPENROUTER_API_KEY/);
	assert.equal(noKey.instances.length, 0);
});

test('голос: ошибка STT видна в чате, pi не поднимается', async () => {
	const stt = voiceFetch({ fail: true });
	const { bot, instances, api } = await harness({ config: { sttApiKey: 'test-key' }, fetch: stt.impl });
	await voice(bot);
	await sleep(20);
	assert.match(textOf(api), /Не смог распознать голос: STT 502/);
	assert.equal(instances.length, 0);
});

test('фото: крупнейший размер скачивается в inbox и уходит в pi картинкой с подписью', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-files-'));
	const dataDir = join(dir, 'data');
	const download = voiceFetch();
	const { bot, instances, api } = await harness({ supportsImages: true, config: { dataDir }, fetch: download.impl });

	await photoMessage(bot, { caption: 'что тут?' });
	assert.equal(api.find((call) => call.method === 'getFile').payload.file_id, 'big', 'выбран самый крупный размер');

	const [, prompt, images] = instances[0].namesOf('prompt')[0];
	assert.equal(prompt, 'что тут?');
	assert.equal(images[0].type, 'image');
	assert.equal(images[0].mimeType, 'image/jpeg');
	assert.equal(Buffer.from(images[0].data, 'base64').length, 3, 'байты фото ушли в pi');

	const saved = await readdir(join(dataDir, 'inbox'));
	assert.equal(saved.length, 1);
	assert.match(saved[0], /^photo-\d+\.jpg$/);
	assert.ok(download.calls.some((call) => call.url.startsWith('https://api.telegram.org/file/bot')));
});

test('фото без поддержки изображений: путь и подпись уходят текстом, файл на диске', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-files-'));
	const dataDir = join(dir, 'data');
	const download = voiceFetch();
	const { bot, instances } = await harness({ config: { dataDir }, fetch: download.impl });

	await photoMessage(bot, { caption: 'посмотри' });
	const prompt = instances[0].namesOf('prompt')[0][1];
	assert.match(prompt, /^\[фото: .*\/inbox\/photo-\d+\.jpg\] посмотри/);
	assert.match(prompt, /Разбери файл инструментами/);
	assert.equal(instances[0].namesOf('prompt')[0].length, 2, 'картинка не приложена — только текст');
});

test('документ: pdf скачивается в inbox, путь уходит в pi; чужой формат и размер — отказ текстом', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-files-'));
	const dataDir = join(dir, 'data');
	const download = voiceFetch();
	const { bot, instances, api } = await harness({ config: { dataDir }, fetch: download.impl });

	await documentMessage(bot, { caption: 'проверь смету' });
	const prompt = instances[0].namesOf('prompt')[0][1];
	assert.match(prompt, /^\[документ: .*\/inbox\/смета-\d+\.pdf\] проверь смету/);
	const saved = await readdir(join(dataDir, 'inbox'));
	assert.equal(saved.length, 1);
	assert.ok((await readFile(join(dataDir, 'inbox', saved[0]))).length > 0);

	await documentMessage(bot, {
		updateId: 2,
		document: { file_id: 'exe', file_unique_id: 'exe-u', file_name: 'virus.exe', mime_type: 'application/x-msdownload', file_size: 10 },
	});
	assert.match(textOf(api), /принимаю документы: pdf, docx, xlsx, txt, csv, json, zip/);

	await documentMessage(bot, {
		updateId: 3,
		document: { file_id: 'big', file_unique_id: 'big-u', file_name: 'big.pdf', mime_type: 'application/pdf', file_size: 20 * 1024 * 1024 + 1 },
	});
	assert.match(textOf(api), /документ больше 20 МБ/);
	assert.equal(api.filter((call) => call.method === 'getFile').length, 1, 'лишние файлы не скачиваются');
});

test('файл из ответа: маркер скрыт, sendDocument с подписью; путь вне outbox/inbox — отказ текстом', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-files-'));
	const dataDir = join(dir, 'data');
	await mkdir(join(dataDir, 'outbox'), { recursive: true });
	const path = join(dataDir, 'outbox', 'смета.pdf');
	await writeFile(path, 'pdf');

	const { bot, instances, api } = await harness({ config: { dataDir } });
	await message(bot, 'дай файл');
	instances[0].emit({
		type: 'agent_end',
		messages: [{ role: 'assistant', content: [{ type: 'text', text: `Готово:\n[file:${path}]` }], stopReason: 'stop' }],
	});
	instances[0].emit({ type: 'agent_settled', aborted: false });
	await sleep(50);

	const docs = api.filter((call) => call.method === 'sendDocument');
	assert.equal(docs.length, 1);
	assert.equal(docs[0].payload.caption, 'Готово:', 'подпись — текст до маркера');
	assert.ok(docs[0].payload.document.fileData.endsWith(join('outbox', 'смета.pdf')), 'отправлен именно файл из outbox');
	assert.equal(sentOf(api).some((call) => textOfCall(call).includes('[file:')), false, 'маркер не виден');

	await message(bot, 'дай ещё', { updateId: 2 });
	instances[0].emit({
		type: 'agent_end',
		messages: [{ role: 'assistant', content: [{ type: 'text', text: 'держи:\n[file:/etc/passwd]' }], stopReason: 'stop' }],
	});
	instances[0].emit({ type: 'agent_settled', aborted: false });
	await sleep(50);

	assert.equal(api.filter((call) => call.method === 'sendDocument').length, 1, 'чужой путь не отправляется');
	assert.match(textOf(api), /путь вне разрешённых каталогов outbox\/inbox/);
	assert.equal(sentOf(api).some((call) => textOfCall(call).includes('/etc/passwd')), false, 'маркер не виден');
});

test('markdown-таблица уходит в rich как markdown, обычный текст — как html', async () => {
	const { richMessageFor } = await import('../src/richtext.js');
	const table = '| Позиция | Сумма |\n|---|---:|\n| Камера | 6 471 ₽ |';
	assert.equal(typeof richMessageFor(table).markdown, 'string', 'таблица — markdown-режим');
	assert.equal(typeof richMessageFor('<b>меню</b>').html, 'string', 'текст — html-режим');
});

/** Ответ модели с фактическим расходом — так pi отдаёт usage (объект с total). */
const replyWithCost = (total, text = 'считаю') => ({
	type: 'message_end',
	message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { cost: { total } } },
});

test('лимит стоимости прогона: перебор $2 останавливает прогон и называет причину в чате', async () => {
	const { bot, instances, api } = await harness({ config: { turnMaxCostUsd: 2 } });
	await message(bot, 'посчитай смету по объекту');
	const pi = instances[0];
	assert.deepEqual(pi.namesOf('abort'), [], 'до перебора прогон не трогаем');

	pi.emit(replyWithCost(0.9));
	await sleep(20);
	assert.deepEqual(pi.namesOf('abort'), [], '$0.9 из $2 — ещё в лимите');

	pi.emit(replyWithCost(1.6));
	await sleep(40);

	assert.deepEqual(pi.namesOf('abort'), [['abort']], 'прогон прерван: $2.5 больше $2');
	assert.deepEqual(pi.namesOf('stop'), [['stop']], 'процесс погашен, следующее сообщение поднимет свежий');
	const texts = api.map(textOfCall).join('\n');
	assert.match(texts, /остановил себя: прогон стоил больше \$2 \(факт \$2\.5\)/);
});

test('лимит стоимости прогона: расход инструментов внутри прогона тоже считается', async () => {
	const { bot, instances, api } = await harness({ config: { turnMaxCostUsd: 2 } });
	await message(bot, 'проверь смету');
	const pi = instances[0];
	// Вложенные вызовы модели приходят в toolResult — их расход относится к тому же прогону.
	pi.emit({ type: 'message_end', message: { role: 'toolResult', toolName: 'read', usage: { cost: { total: 2.2 } } } });
	await sleep(40);
	assert.deepEqual(pi.namesOf('abort'), [['abort']]);
	assert.match(api.map(textOfCall).join('\n'), /остановил себя: прогон стоил больше \$2 \(факт \$2\.2\)/);
});

test('лимит стоимости прогона: расход в пределах лимита прогон не останавливает', async () => {
	const { bot, instances } = await harness({ config: { turnMaxCostUsd: 2 } });
	await message(bot, 'просто вопрос');
	const pi = instances[0];
	pi.emit(replyWithCost(1.5));
	await sleep(40);
	assert.deepEqual(pi.namesOf('abort'), []);
	pi.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ок' }], stopReason: 'stop' }] });
	pi.emit({ type: 'agent_settled', aborted: false });
	await sleep(20);
});

// Требование владельца 29.10.2026: агент должен знать, где его попросили, — иначе напоминание уйдёт не туда.
test('контекст сообщения уходит в процесс pi, а входящее пишется в txt-лог', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-log-'));
	const { bot, instances } = await harness({ config: { logDir: dir } });
	await message(bot, '@test_bot поставь напоминание', { chatType: 'supergroup', chatId: -1003432441991 });

	assert.deepEqual(instances[0].options.env, {
		PI_CHAT_ID: '-1003432441991',
		PI_CHAT_TYPE: 'supergroup',
		PI_USER_ID: String(USER),
		PI_USER_NAME: 'Тест',
	});

	const file = join(dir, `bridge-${new Date().toISOString().slice(0, 10)}.txt`);
	const log = await readFile(file, 'utf8');
	assert.match(log, new RegExp(`\\[info\\] вход: чат -1003432441991 · supergroup · Тест \\(${USER}\\) · поставь напоминание`), 'тег бота вырезан из промпта');
});

test('тема форума попадает в контекст как PI_THREAD_ID', async () => {
	const { bot, instances } = await harness({ config: { logDir: null } });
	await message(bot, '@test_bot в теме', { chatType: 'supergroup', chatId: -1003432441991 });
	assert.equal(instances[0].options.env.PI_THREAD_ID, undefined, 'без темы ключа нет');
});

test('ответ в теме форума остаётся в теме: уходит с message_thread_id', async () => {
	const { bot, instances, api } = await harness({ config: { logDir: null } });
	await message(bot, '@test_bot что по складу', { chatType: 'supergroup', chatId: -1003432441991, threadId: 12 });
	const pi = instances[0];
	assert.equal(pi.options.env.PI_THREAD_ID, '12', 'тема уходит в инструменты: напоминание вернётся в неё');

	pi.emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Склад в работе' }], stopReason: 'stop' }] });
	pi.emit({ type: 'agent_settled', aborted: false });
	await sleep(50);

	const answer = sentOf(api).at(-1);
	assert.match(textOfCall(answer), /Склад в работе/);
	assert.equal(answer.payload.message_thread_id, 12, 'ответ вернулся в ту же тему');
});

test('два письменных прогона на один PDF: дубль маркера не даёт ложного «не удалось отправить»', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'pi-tg-files-'));
	const dataDir = join(dir, 'data');
	await mkdir(join(dataDir, 'outbox'), { recursive: true });
	const path = join(dataDir, 'outbox', 'смета.pdf');
	await writeFile(path, 'pdf');

	const { bot, instances, api } = await harness({ config: { dataDir } });
	await message(bot, 'дай файл');
	const pi = instances[0];
	// Один и тот же маркер дважды в одном ответе + пересборка файла во время отправки.
	pi.emit({
		type: 'agent_end',
		messages: [
			{ role: 'assistant', content: [{ type: 'text', text: `Готово:\n[file:${path}]\n[file:${path}]` }], stopReason: 'stop' },
		],
	});
	pi.emit({ type: 'agent_settled', aborted: false });
	await sleep(80);

	assert.equal(api.filter((call) => call.method === 'sendDocument').length, 1, 'файл отправлен один раз');
	assert.equal(sentOf(api).some((call) => /Не удалось отправить файл/.test(textOfCall(call))), false, 'ошибки нет');
	assert.equal(existsSync(path), false, 'после отправки одноразовый PDF удалён');
});

test('pi ещё стримит: сообщение уходит followUp, а не падает «already processing»', async () => {
	const { bot, instances, api } = await harness();
	await message(bot, 'первая задача');
	const pi = instances[0];
	pi.emit({ type: 'agent_settled' });
	await sleep(20);

	// Гонка: мост считает ход закрытым, а pi ещё занят — pi отвечает не 'started', а 'queued'.
	pi.promptResult = 'queued';
	await message(bot, 'добавь дадзайфу в подборку', { updateId: 2 });
	assert.equal(pi.promptBehavior, 'followUp', 'очередь вместо ошибки');
	assert.deepEqual(pi.namesOf('prompt').at(-1), ['prompt', 'добавь дадзайфу в подборку']);
	const afterQueue = sentOf(api).map(textOfCall).join('\n');
	assert.doesNotMatch(afterQueue, /already processing|прогон упал/);

	pi.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
	pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'добавил' } });
	pi.emit({ type: 'agent_settled' });
	await sleep(20);
	assert.match(textOf(api), /добавил/, 'ход закрывается по agent_settled, а не сразу после очереди');
});
