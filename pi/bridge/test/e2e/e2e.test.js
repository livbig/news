/**
 * Сквозные тесты (npm run e2e): апдейт Telegram → мост → настоящий процесс pi с настоящими
 * инструментами ассистента (`document_build`, `estimate_*, set_reminder`) → файл/сообщение → Telegram.
 *
 * Подменены ровно два внешних сервиса, и оба — HTTP на 127.0.0.1:
 *   • Bot API (`fake-telegram.js`): принимает getUpdates/sendMessage/sendDocument/getFile, отдаёт
 *     валидные ответы и записывает, что именно ушло в чат;
 *   • поставщик модели и STT (`fake-model.js`): детерминированные ответы по реплике пользователя.
 * Бизнес-логика не подменяется: инструменты ассистента, движок, PDF и мост работают по-настоящему.
 *
 * Отдельный набор: в `npm test` не входит (поднимает настоящий pi и два локальных сервера),
 * запускается перед деплоем — `npm run e2e`.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { FORMAT_PROBE, TRANSCRIPT, startFakeModel } from './fake-model.js';
import { BOT, startFakeTelegram } from './fake-telegram.js';
import { startFakeMiniapp } from './fake-miniapp.js';
import { ASSISTANT_DIR, REPO, assistantAvailable, createFixture } from './fixture.js';
import { htmlProblems, rawMarkdownProblems } from '../../src/format-check.js';

const TOKEN = '123456789:E2E-test-token-not-a-real-one';
const FOUNDER = { id: 1001, is_bot: false, first_name: 'Максим' };
const PRIVATE_CHAT = { id: 1001, type: 'private', first_name: 'Максим' };
const GROUP_CHAT = { id: -1_003_999_888_777, type: 'supergroup', title: 'ПЕРИМЕТР' };

const skip = assistantAvailable() ? false : `нет каталога ассистента (${ASSISTANT_DIR}): задайте E2E_ASSISTANT_DIR`;

let model;
let telegram;
let miniapp;
let fixture;
let bridge;
const bridgeLog = [];
let messageId = 500;

const logTail = () => bridgeLog.join('').split('\n').slice(-40).join('\n');

/** Текст, который человек увидел в чате: мост отдаёт его и новым сообщением, и правкой живого. */
const textOf = (call) => String(call.caption ?? call.text ?? '');
const saidIn = (chatId, pattern) => (call) =>
	call.chatId === Number(chatId) && (call.kind === 'message' || call.kind === 'edit') && pattern.test(textOf(call));

/** Апдейт обычного сообщения. В группе текст обязан содержать @бот — как в бою. */
function textUpdate({ chat, text, from = FOUNDER }) {
	messageId += 1;
	return { message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat, from, text } };
}

/** Апдейт голосового: Telegram отдаёт файл отдельным getFile, звук скачивается по /file/bot… */
function voiceUpdate({ chat, from = FOUNDER, duration = 3 }) {
	messageId += 1;
	return {
		message: {
			message_id: messageId,
			date: Math.floor(Date.now() / 1000),
			chat,
			from,
			voice: { file_id: 'voice-1', file_unique_id: 'voice-u1', duration, file_size: 2048, mime_type: 'audio/ogg' },
		},
	};
}

before(async () => {
	if (skip) return;
	model = await startFakeModel();
	telegram = await startFakeTelegram({ token: TOKEN });
	// Меню проектов и смет: настоящий код моста ходит в локальный API ассистента.
	miniapp = await startFakeMiniapp({ token: 'e2e-service-token' });
	fixture = await createFixture({
		modelBaseUrl: model.baseUrl,
		sttBaseUrl: `http://127.0.0.1:${model.port}/stt`,
		apiRoot: telegram.apiRoot,
		token: TOKEN,
	});

	// Диагностика: чей именно процесс поднимаем и с каким стендом.
	bridgeLog.push(`spawn: ${process.execPath} src/main.js (cwd ${REPO})\n`);
	bridgeLog.push(`pi: ${fixture.env.PI_TG_CLI_PATH} · агент ${fixture.env.PI_CODING_AGENT_DIR}\n`);
	bridge = spawn(process.execPath, ['src/main.js'], {
		cwd: REPO,
		env: { ...process.env, ...fixture.env, MINIAPP_API_URL: miniapp.baseUrl, MINIAPP_SERVICE_TOKEN: 'e2e-service-token' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	bridge.stdout.on('data', (chunk) => bridgeLog.push(chunk.toString('utf8')));
	bridge.stderr.on('data', (chunk) => bridgeLog.push(chunk.toString('utf8')));
	bridge.on('exit', (code, signal) => bridgeLog.push(`\n[мост завершился: код ${code}, сигнал ${signal}]\n`));

	await telegram.waitFor((call) => call.method === 'getMe' && call.kind === 'api', {
		timeoutMs: 30_000,
		label: 'мост представился (getMe)',
	});
	await telegram.waitFor((call) => call.method === 'getUpdates', { timeoutMs: 30_000, label: 'мост начал опрос getUpdates' });
	if (bridge.exitCode !== null) throw new Error(`мост завершился на старте (код ${bridge.exitCode}):\n${logTail()}`);
});

after(async () => {
	if (bridge && bridge.exitCode === null) {
		bridge.kill('SIGTERM');
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				bridge.kill('SIGKILL');
				resolve();
			}, 10_000);
			bridge.on('exit', () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
	await telegram?.close();
	await miniapp?.close();
	await model?.close();
	fixture?.cleanup();
	// E2E_LOG=1 — журнал моста: без него причина «ничего не пришло» не видна.
	if (process.env.E2E_LOG === '1') console.error(`\n--- журнал моста ---\n${logTail()}`);
});

test('(а) «сделай смету» → приходит документ с именем по правилу и таблицей в тексте', { skip }, async () => {
	telegram.push(textUpdate({ chat: PRIVATE_CHAT, text: 'сделай смету по складу' }));

	const document = await telegram.waitFor((call) => call.kind === 'document' && call.chatId === PRIVATE_CHAT.id, {
		label: 'PDF в приватный чат',
	});
	assert.equal(document.fileName, `Смета №${fixture.seeded.phone4} — ПЕРИМЕТР..pdf`, 'имя по правилу владельца');

	// Таблица едет подписью к документу: мост отдаёт её текстом, если он короткий.
	const caption = document.caption ?? '';
	assert.match(caption, /\| Позиция \|/, 'markdown-таблица в тексте');
	assert.match(caption, /\*\*Итого\*\*/, 'итог в таблице');
	assert.match(caption, /Смета готова/, 'ответ агента виден человеку');

	// Одноразовый PDF: файл удалён после отправки, в outbox осталось только лёгкое.
	const outbox = join(fixture.outbox, String(fixture.seeded.estimateWithPhone.id));
	assert.deepEqual(
		readdirSync(outbox).sort(),
		['estimate.json', 'smeta.csv'],
		'после отправки от PDF не осталось следа — только CSV и estimate.json',
	);
	const light = JSON.parse(readFileSync(join(outbox, 'estimate.json'), 'utf8'));
	assert.equal(light.total, 48260);
	assert.equal(light.fileName, `Смета №${fixture.seeded.phone4} — ПЕРИМЕТР..pdf`);
});

test('(д) смета без телефона заказчика → имя без номера', { skip }, async () => {
	telegram.push(textUpdate({ chat: PRIVATE_CHAT, text: 'сделай смету без телефона заказчика' }));

	const document = await telegram.waitFor(
		(call) => call.kind === 'document' && call.chatId === PRIVATE_CHAT.id && call.fileName === 'Смета — ПЕРИМЕТР..pdf',
		{ label: 'PDF без номера в имени' },
	);
	assert.equal(document.fileName, 'Смета — ПЕРИМЕТР..pdf');
	assert.match(document.caption ?? '', /\| Позиция \|/);
});

test('(б) голосовое → расшифровка дошла до промпта и агент ответил в чат', { skip }, async () => {
	telegram.push(voiceUpdate({ chat: PRIVATE_CHAT }));

	const answer = await telegram.waitFor(saidIn(PRIVATE_CHAT.id, new RegExp(`Слышал: .*${TRANSCRIPT}`)), {
		label: 'ответ на голосовое',
	});
	assert.match(textOf(answer), new RegExp(TRANSCRIPT), 'агент увидел расшифровку');

	// Это не мост подставил текст в ответ, а модель получила расшифровку в промпте.
	const request = await model.waitFor((item) => item.user.includes(TRANSCRIPT), { label: 'модель получила расшифровку' });
	assert.deepEqual(request.tools.length > 0, true, 'модель видит инструменты ассистента');
	assert.equal(model.sttRequests.length > 0, true, 'фейковый STT был вызван');
});

test('(в) напоминание, созданное в группе, приходит в группу', { skip }, async () => {
	telegram.push(textUpdate({ chat: GROUP_CHAT, text: `@${BOT.username} напомни про смету по складу` }));

	const created = await telegram.waitFor(saidIn(GROUP_CHAT.id, /Напоминание поставлено/), {
		label: 'подтверждение напоминания в группе',
	});
	assert.match(textOf(created), /Напоминание поставлено/);

	// Таймер ассистента — настоящий скрипт, отправляет в Bot API по TELEGRAM_API_BASE.
	const before = telegram.sentTo(GROUP_CHAT.id).length;
	const tick = await runRemindersTick();
	assert.equal(tick.code, 0, `напоминания не отправились: ${tick.output}`);

	const delivered = await telegram.waitFor(
		(call, index) => index >= before && call.chatId === GROUP_CHAT.id && /Ромашка/.test(textOf(call)),
		{ label: 'напоминание в группе' },
	);
	assert.match(textOf(delivered), /^Максим, /, 'в группе автор назван по имени');
	assert.match(textOf(delivered), /Склад Дзержинский/, 'объект назван в напоминании');
	assert.equal(
		telegram.sentTo(PRIVATE_CHAT.id).some((call) => /Ромашка/.test(textOf(call))),
		false,
		'клиенту в личку ничего не ушло',
	);
});

test('(г) отказная ветка: сметы нет → ошибка в чат, файла нет', { skip }, async () => {
	const documentsBefore = telegram.sentTo(PRIVATE_CHAT.id).filter((call) => call.kind === 'document').length;
	telegram.push(textUpdate({ chat: PRIVATE_CHAT, text: 'собери документ по смете с битым итогом' }));

	// Инструмент отвечает ошибкой («версии 999 нет»), модель пересказывает её человеку.
	const failure = await telegram.waitFor(saidIn(PRIVATE_CHAT.id, /Не смог собрать документ/), {
		label: 'ошибка документа в чате',
	});
	assert.match(textOf(failure), /999|нет|не найдена/iu, 'причина названа человеческим языком');

	const documentsAfter = telegram.sentTo(PRIVATE_CHAT.id).filter((call) => call.kind === 'document').length;
	assert.equal(documentsAfter, documentsBefore, 'файл в чат не ушёл');

	const outbox = join(fixture.outbox, String(fixture.seeded.brokenEstimate.id));
	const pdfs = existsSync(outbox) ? readdirSync(outbox).filter((name) => name.endsWith('.pdf')) : [];
	assert.deepEqual(pdfs, [], 'дефектный PDF не остался на диске');
});

/**
 * (е) Форматирование. Ответ ассистента с таблицей сметы, `*жирным*`, списками, `<>`/`&`, длинной
 * строкой и таблицей длиннее лимита доходит до Bot API валидным HTML: теги закрыты, `<`/`&`
 * экранированы, сырого markdown нет, таблица не потеряла шапку. Проверяется ровно то, что уходит
 * в Telegram (`text` и `parse_mode`), а не промежуточные строки моста.
 */
test('(е) форматирование: таблица, &<>, длинный текст и таблица длиннее лимита', { skip }, async () => {
	telegram.push(textUpdate({ chat: PRIVATE_CHAT, text: 'проверка формата' }));

	// Ждём последнюю часть ответа (конец таблицы на 60 строк) — значит, всё уже отправлено.
	await telegram.waitFor(
		(call) => call.chatId === PRIVATE_CHAT.id && (call.kind === 'message' || call.kind === 'edit') && /Позиция сметы 60/.test(textOf(call)),
		{ label: 'последняя часть ответа с таблицей' },
	);

	const parts = finalParts(PRIVATE_CHAT.id);
	assert.ok(parts.length >= 2, `частей ответа: ${parts.length}`);
	const full = parts.map(textOf).join('\n');

	for (const part of parts) {
		const text = textOf(part);
		assert.ok(text.length <= 4096, `часть длиной ${text.length}`);
		assert.equal(part.parseMode, 'HTML');
		assert.deepEqual(htmlProblems(text), [], 'теги закрыты, < и & экранированы');
		assert.deepEqual(rawMarkdownProblems(text), [], 'сырого markdown в чате нет');
	}

	assert.match(full, /<pre>Позиция\s+│ Кол-во/, 'таблица сметы стала моноширинным блоком');
	assert.match(full, /&lt; 50 000 ₽/, 'меньше и амперсанд экранированы');
	assert.match(full, /&amp; партнёры/);
	assert.match(full, /🎥✅/u, 'эмодзи дошли');
	assert.match(full, /- гарантия 12 месяцев/, 'список остался списком');
	assert.match(full, /конец длинной строки\./, 'длинная строка дошла целиком');

	// Каждая часть с таблицей начинается шапкой: строка-продолжение без шапки — дефект.
	const tables = parts.filter((call) => textOf(call).includes('│ Кол-во'));
	assert.ok(tables.length >= 1);
	for (const call of tables) {
		const firstRow = textOf(call).split('\n').find((line) => line.includes('│'));
		assert.match(firstRow, /Позиция\s+│ Кол-во/, 'шапка повторяется в каждой части таблицы');
	}
	const positions = new Set([...full.matchAll(/Позиция сметы (\d+)/g)].map((match) => match[1]));
	assert.equal(positions.size, 60, 'все 60 строк таблицы дошли');
	assert.ok(FORMAT_PROBE.length > 4096, 'probe действительно длиннее одного сообщения');
});

/** Окончательные тексты ответа в чате: последняя правка каждого сообщения плюс новые сообщения. */
function finalParts(chatId) {
	const byMessage = new Map();
	for (const call of telegram.sentTo(chatId)) {
		const text = textOf(call);
		if (call.kind !== 'message' && call.kind !== 'edit') continue;
		if (!/Смета по складу готова|Длинная строка|Таблица на 60 строк/.test(text)) continue;
		byMessage.set(call.messageId ?? `new-${call.at}`, call);
	}
	return [...byMessage.values()];
}

/** Один тик напоминаний: тот же скрипт, что у systemd-таймера, но по стенду и фейковому Bot API. */
async function runRemindersTick() {
	const child = spawn(process.execPath, [join(ASSISTANT_DIR, 'scripts/reminders-tick.mjs')], {
		cwd: ASSISTANT_DIR,
		env: { ...process.env, ...fixture.env, MINIAPP_API_URL: miniapp.baseUrl, MINIAPP_SERVICE_TOKEN: 'e2e-service-token' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const output = [];
	child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
	child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
	// Тик не должен подвешивать прогон: у него свой потолок, как у systemd-таймера.
	const code = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			resolve('таймаут 30 с');
		}, 30_000);
		child.on('exit', (exitCode) => {
			clearTimeout(timer);
			resolve(exitCode);
		});
	});
	return { code, output: output.join('').trim() };
}

test('(f) /menu → проекты → карточка объекта с ценой', { skip }, async () => {
	telegram.push(textUpdate({ chat: PRIVATE_CHAT, text: '/menu' }));
	const menu = await telegram.waitFor(saidIn(PRIVATE_CHAT.id, /Чем помочь\?/), { label: 'меню ассистента' });
	const menuKeyboard = JSON.stringify(menu.replyMarkup ?? menu.reply_markup ?? {});
	assert.match(menuKeyboard, /menu:projects/, 'в меню есть кнопка проектов');

	telegram.push({
		callback_query: {
			id: 'cb-projects',
			from: FOUNDER,
			chat_instance: 'e2e',
			data: 'menu:projects',
			message: { message_id: 900, date: Math.floor(Date.now() / 1000), chat: PRIVATE_CHAT, text: 'Чем помочь?' },
		},
	});
	const projects = await telegram.waitFor(saidIn(PRIVATE_CHAT.id, /Проекты/), { label: 'список проектов' });
	const projectsKeyboard = JSON.stringify(projects.replyMarkup ?? projects.reply_markup ?? {});
	assert.match(projectsKeyboard, /obj:1:0/, 'проект открывается кнопкой');
	assert.match(projectsKeyboard, /Show archive|Показать архив/iu, 'счётчик архива в кнопке');

	telegram.push({
		callback_query: {
			id: 'cb-object',
			from: FOUNDER,
			chat_instance: 'e2e',
			data: 'obj:1:0',
			message: { message_id: 901, date: Math.floor(Date.now() / 1000), chat: PRIVATE_CHAT, text: 'Проекты' },
		},
	});
	const card = await telegram.waitFor(saidIn(PRIVATE_CHAT.id, /Склад Марьино/), { label: 'карточка объекта' });
	assert.match(textOf(card), /Ромашка/, 'заказчик из сметы');
	assert.match(textOf(card), /48 260/, 'итог последней версии');
	assert.ok(miniapp.calls.some((call) => call.path === '/api/estimate'), 'карточка читает смету через API');
});
