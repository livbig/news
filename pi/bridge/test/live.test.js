import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { GrammyError } from 'grammy';

import { createLiveMessage, isParseError, resetRichSupport } from '../src/live.js';
import { htmlProblems, rawMarkdownProblems } from '../src/format-check.js';
import { RICH_RETRY_MESSAGES } from '../src/rich.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function grammyError(errorCode, description) {
	return new GrammyError(`Call to 'x' failed!`, { ok: false, error_code: errorCode, description }, 'x', {});
}

/**
 * @param {{draftError?: Error, parseError?: boolean, rich?: boolean, richError?: Error, richDraftError?: Error}} options
 * rich=true — транспорт умеет Rich Messages (как настоящий Bot API 10.3).
 */
function fakeApi({ draftError, parseError = false, rich = false, richError, richDraftError } = {}) {
	const calls = [];
	let nextId = 100;
	const bump = () => (nextId += 1);
	return {
		calls,
		of(method) {
			return calls.filter((call) => call.method === method);
		},
		...(rich
			? {
					async sendRichMessageDraft(chatId, draftId, richMessage, other) {
						calls.push({ method: 'sendRichMessageDraft', chatId, draftId, richMessage, other });
						if (richDraftError) throw richDraftError;
						if (richError) throw richError;
						return true;
					},
					async sendRichMessage(chatId, richMessage, other) {
						calls.push({ method: 'sendRichMessage', chatId, richMessage, other });
						if (richError) throw richError;
						return { message_id: bump() };
					},
				}
			: {}),
		async sendMessageDraft(chatId, draftId, text, options) {
			calls.push({ method: 'sendMessageDraft', chatId, draftId, text, options });
			if (draftError) throw draftError;
			return true;
		},
		async sendMessage(chatId, text, options) {
			calls.push({ method: 'sendMessage', chatId, text, options });
			if (parseError && options?.parse_mode === 'HTML') {
				throw grammyError(400, "Bad Request: can't parse entities: Unsupported start tag");
			}
			return { message_id: bump() };
		},
		async editMessageText(chatId, messageId, text, options) {
			calls.push({ method: 'editMessageText', chatId, messageId, text, options });
			if (parseError && options?.parse_mode === 'HTML') {
				throw grammyError(400, "Bad Request: can't parse entities: Unsupported start tag");
			}
			return { message_id: messageId };
		},
		async sendChatAction() {
			return true;
		},
	};
}

beforeEach(() => resetRichSupport());

test('rich: стрим идёт markdown-черновиком с кнопкой стоп, финал — rich-сообщением', async () => {
	const api = fakeApi({ rich: true });
	const live = createLiveMessage({ api, chatId: 1, replyTo: 7, rich: 'auto', draftEnabled: true });
	assert.equal(live.format, 'rich');

	live.update({ text: '**жирный** и `код`', status: 'думаю…' });
	await sleep(5);
	const draft = api.of('sendRichMessageDraft')[0];
	assert.equal(draft.richMessage.markdown, '_думаю…_\n\n**жирный** и `код`');
	assert.equal(draft.other.can_stop, true, 'в клиенте появляется кнопка остановки');

	await live.finish({ text: '**готово** <не тег>' });
	const sent = api.of('sendRichMessage');
	assert.equal(sent.length, 1);
	assert.equal(sent[0].richMessage.markdown, '**готово** <не тег>', 'markdown уходит как есть, без экранирования');
	assert.deepEqual(sent[0].other.reply_parameters, { message_id: 7 });
	assert.equal(api.of('sendMessage').length, 0);
	assert.equal(api.of('editMessageText').length, 0);
});

test('rich: заголовки уходят жирным текстом, код-блок остаётся как есть', async () => {
	const api = fakeApi({ rich: true });
	const live = createLiveMessage({ api, chatId: 9, rich: 'auto' });
	live.update({ text: '# Отчёт\n\n```sh\n# комментарий\n```' });
	await sleep(5);
	assert.equal(
		api.of('sendRichMessageDraft')[0].richMessage.markdown,
		'**Отчёт**\n\n```sh\n# комментарий\n```',
		'serif-заголовки в чате не нужны, а решётка в коде — это код',
	);
	await live.finish({ text: '## Итог' });
	assert.equal(api.of('sendRichMessage')[0].richMessage.markdown, '**Итог**');
});

test('rich: несколько частей уходят несколькими rich-сообщениями', async () => {
	const api = fakeApi({ rich: true });
	const live = createLiveMessage({ api, chatId: 2, rich: 'auto' });
	live.start();
	await live.finish({ text: `${'строка **жирным**\n\n'.repeat(400)}конец` });
	const sent = api.of('sendRichMessage');
	assert.ok(sent.length >= 2, `частей: ${sent.length}`);
	for (const call of sent) assert.ok(call.richMessage.markdown.length <= 4096);
});

test('rich недоступен → одноразовый переход на черновики и HTML', async () => {
	const api = fakeApi({ draftError: grammyError(400, 'Bad Request: method not found') });
	const live = createLiveMessage({ api, chatId: 3, rich: 'auto', draftEnabled: true });
	live.update({ text: 'раз' });
	await sleep(5);
	live.update({ text: 'раз два' });
	await sleep(20);

	assert.equal(live.format, 'message', 'после двух неудач (rich → draft) остаётся editMessageText');
	assert.equal(api.of('sendMessage').length, 1);
	const messageId = live.messageId;
	await sleep(1600);
	assert.ok(api.of('editMessageText').length >= 1);
	assert.equal(api.of('editMessageText')[0].messageId, messageId);
});

test('rich: ошибка метода не теряет ответ — сообщение уходит классическим путём', async () => {
	const api = fakeApi({ rich: true, richError: grammyError(400, 'Bad Request: method not found') });
	const live = createLiveMessage({ api, chatId: 4, rich: 'auto' });
	await live.finish({ text: '**ответ**' });
	assert.equal(api.of('sendRichMessage').length, 1, 'rich пробуется ровно один раз');
	const sent = api.of('sendMessage');
	assert.equal(sent.length, 1);
	assert.equal(sent[0].text, '<b>ответ</b>');
});

test('rich=off: сразу классический путь', async () => {
	const api = fakeApi({ rich: true });
	const live = createLiveMessage({ api, chatId: 5, rich: 'off', draftEnabled: true });
	live.update({ text: 'текст' });
	await sleep(5);
	assert.equal(api.of('sendMessageDraft').length, 1);
	assert.equal(api.of('sendMessageDraft')[0].options.can_stop, true);
	assert.equal(api.of('sendRichMessageDraft').length, 0);
});

test('черновик классического пути эфемерен → финал отдельным сообщением', async () => {
	const api = fakeApi();
	const live = createLiveMessage({ api, chatId: 6, replyTo: 7, rich: 'off', draftEnabled: true });
	live.update({ text: 'п' });
	await sleep(5);
	assert.equal(api.of('sendMessageDraft').length, 1);
	assert.equal(live.format, 'draft');

	await live.finish({ text: 'привет, мир' });
	assert.equal(api.of('sendMessage').length, 1);
	assert.equal(api.of('sendMessage')[0].text, 'привет, мир');
	assert.deepEqual(api.of('sendMessage')[0].options.reply_parameters, { message_id: 7 });
});

test('многочастный ответ: первая часть правит живое сообщение, остальные — новые', async () => {
	const api = fakeApi({ draftError: grammyError(400, 'Bad Request: method not found') });
	const live = createLiveMessage({ api, chatId: 7, rich: 'off', draftEnabled: true });
	live.update({ text: 'начало' });
	await sleep(5);
	assert.equal(api.of('sendMessage').length, 1);

	await live.finish({ text: `${'строка\n\n'.repeat(800)}конец` });
	assert.equal(api.of('editMessageText').length, 1);
	assert.ok(api.of('sendMessage').length >= 2, 'остальные части уходят новыми сообщениями');
	for (const call of api.of('sendMessage')) assert.ok(call.text.length <= 4096);
});

test('вырезание куска под 4096 в живом сообщении и финал в несколько частей', async () => {
	const api = fakeApi();
	const live = createLiveMessage({ api, chatId: 8, rich: 'off', draftEnabled: true });
	live.update({ text: 'x'.repeat(5000) });
	await sleep(5);
	const draft = api.of('sendMessageDraft')[0];
	assert.ok(draft.text.length <= 4096);
	assert.ok(draft.text.endsWith('…'));

	await live.finish({ text: 'y'.repeat(5000) });
	const sent = api.of('sendMessage');
	assert.equal(sent.length, 2);
	assert.equal(sent[0].text.length, 4096);
	assert.equal(sent[1].text.length, 904);
});

test('битая разметка не роняет ход: повтор без parse_mode', async () => {
	const api = fakeApi({ parseError: true });
	const live = createLiveMessage({ api, chatId: 9, rich: 'off', draftEnabled: false });
	await live.finish({ text: 'жирный <b>уже</b>' });
	const sends = api.of('sendMessage');
	assert.equal(sends.length, 2);
	assert.ok(sends[0].options.parse_mode === 'HTML');
	assert.equal(sends[1].options.parse_mode, undefined);
	assert.ok(sends[1].text.includes('уже'));
});

test('aborted и error дают понятный текст в том же сообщении', async () => {
	const api = fakeApi({ draftError: grammyError(400, 'nope') });
	const live = createLiveMessage({ api, chatId: 10, rich: 'off', draftEnabled: true });
	live.update({ text: 'частичный ответ' });
	await sleep(5);
	await live.finish({ aborted: true });
	assert.equal(api.of('editMessageText').at(-1).text, 'частичный ответ\n\n⏹ Остановлено');

	const api2 = fakeApi({ draftError: grammyError(400, 'nope') });
	const live2 = createLiveMessage({ api: api2, chatId: 11, rich: 'off', draftEnabled: true });
	live2.update({ text: 'было' });
	await sleep(5);
	await live2.finish({ error: 'нет ключа провайдера' });
	assert.equal(api2.of('editMessageText').at(-1).text, '⚠️ pi: нет ключа провайдера');
});

test('ход без текста закрывается подтверждением', async () => {
	const api = fakeApi({ draftError: grammyError(400, 'nope') });
	const live = createLiveMessage({ api, chatId: 12, rich: 'off', draftEnabled: true });
	live.update({ status: 'думаю…' });
	await sleep(5);
	await live.finish({ text: '' });
	assert.equal(api.of('editMessageText').at(-1).text, '✅ Готово');
});

test('isParseError различает ошибку разметки и остальные 400', () => {
	assert.equal(isParseError(grammyError(400, "Bad Request: can't parse entities")), true);
	assert.equal(isParseError(grammyError(400, 'Bad Request: message is too long')), false);
	assert.equal(isParseError(grammyError(429, 'Too Many Requests')), false);
	assert.equal(isParseError(new Error('parse')), false);
});

test('rich: таблица на 60 строк уходит частями с повторённой шапкой, без обрыва разметки', async () => {
	const api = fakeApi({ rich: true });
	const live = createLiveMessage({ api, chatId: 20, rich: 'auto' });
	const header = '| № | Позиция | Сумма |';
	const rule = '|---:|---|---:|';
	const rows = Array.from(
		{ length: 60 },
		(_, index) => `| ${index + 1} | ${'позиция сметы '.repeat(8)}${index} | ${(index + 1) * 1000} |`,
	);
	await live.finish({ text: [header, rule, ...rows].join('\n') });

	const sent = api.of('sendRichMessage');
	assert.ok(sent.length > 1, `частей: ${sent.length}`);
	for (const call of sent) {
		const markdown = call.richMessage.markdown;
		assert.ok(markdown.length <= 4096, `часть длиной ${markdown.length}`);
		assert.equal(markdown.includes('```'), false);
		const lines = markdown.split('\n');
		if (lines.some((line) => line.startsWith('|'))) {
			assert.equal(lines[0], header, 'каждая часть таблицы начинается с шапки');
			assert.equal(lines[1], rule);
		}
	}
	const dataRows = sent.reduce((sum, call) => sum + call.richMessage.markdown.split('\n').filter((line) => /^\| \d+ \|/.test(line)).length, 0);
	assert.equal(dataRows, rows.length, 'все строки таблицы дошли');
});

test('rich: после N сообщений классического пути попытка rich повторяется', async () => {
	const api = fakeApi({ rich: true, richError: grammyError(400, 'Bad Request: method not found') });
	const first = createLiveMessage({ api, chatId: 21, rich: 'auto' });
	await first.finish({ text: 'первый' });
	assert.equal(api.of('sendRichMessage').length, 1);

	for (let index = 0; index < RICH_RETRY_MESSAGES - 1; index += 1) {
		const live = createLiveMessage({ api, chatId: 21, rich: 'auto' });
		await live.finish({ text: `сообщение ${index}` });
	}
	assert.equal(api.of('sendRichMessage').length, 1, 'внутри окна rich не дёргаем');

	const retry = createLiveMessage({ api, chatId: 21, rich: 'auto' });
	await retry.finish({ text: 'после окна' });
	assert.equal(api.of('sendRichMessage').length, 2, 'после окна — новая попытка');
});

const TABLE_MARKDOWN = ['| Позиция | Сумма |', '| --- | ---: |', '| Камера | 28 760 |'].join('\n');

test('черновик в группе не работает → rich-сообщение с таблицей всё равно уходит', async () => {
	// Боевой случай 28.10.2026: sendRichMessageDraft отвечает TEXTDRAFT_PEER_INVALID, и раньше
	// это на 10 сообщений отключало rich целиком — таблицы сметы приходили палками.
	const api = fakeApi({ rich: true, richDraftError: grammyError(400, 'Bad Request: TEXTDRAFT_PEER_INVALID') });
	const live = createLiveMessage({ api, chatId: 30, rich: 'auto', draftEnabled: true });
	assert.equal(live.format, 'rich');

	live.update({ text: TABLE_MARKDOWN });
	await sleep(10);
	assert.equal(api.of('sendRichMessageDraft').length, 1);
	assert.equal(live.format, 'message', 'живая строка — классикой');

	await live.finish({ text: TABLE_MARKDOWN });
	const sent = api.of('sendRichMessage');
	assert.equal(sent.length, 1, 'финал — rich-сообщением: таблицу рисует Telegram');
	assert.equal(sent[0].richMessage.markdown, TABLE_MARKDOWN);
	// Живая строка после отказа черновика идёт классикой, но финал с таблицей — rich.
	assert.equal(api.of('sendMessage').some((call) => call.text.includes('| ---')), false, 'сырой markdown в чат не уходит');
});

test('черновик классического пути не экранирует текст', async () => {
	const api = fakeApi({ draftError: grammyError(400, 'nope') });
	const live = createLiveMessage({ api, chatId: 31, rich: 'off', draftEnabled: true });
	live.update({ text: 'смета < 50 000 & «Ромашка»' });
	await sleep(10);
	const body = api.of('sendMessageDraft')[0].text;
	assert.ok(body.includes('смета < 50 000 & «Ромашка»'), `в черновике сам текст, а не HTML: ${body}`);
	assert.equal(body.includes('&lt;'), false);
});

test('классический финал: таблица уходит моноширинным блоком, без сырого markdown', async () => {
	const api = fakeApi();
	const live = createLiveMessage({ api, chatId: 32, rich: 'off', draftEnabled: false });
	await live.finish({ text: `${TABLE_MARKDOWN}\n\n**Итого** 48 260 & скидка < 5 %` });

	const sent = api.of('sendMessage');
	assert.equal(sent.length, 1);
	const html = sent[0].text;
	assert.equal(sent[0].options.parse_mode, 'HTML');
	assert.ok(html.includes('<pre>'), 'таблица стала <pre>');
	assert.ok(html.includes('<b>Итого</b>'));
	assert.ok(html.includes('&lt; 5 %'));
	assert.deepEqual(htmlProblems(html), []);
	assert.deepEqual(rawMarkdownProblems(html), []);
});

test('rich: жёсткие переносы сохраняют строки в черновике и финале', async () => {
	const api = fakeApi({ rich: true });
	const live = createLiveMessage({ api, chatId: 11, rich: 'auto', draftEnabled: true });
	live.update({ text: 'первая строка\nвторая строка' });
	await sleep(5);
	assert.equal(api.of('sendRichMessageDraft')[0].richMessage.markdown, 'первая строка  \nвторая строка');
	await live.finish({ text: 'итог одна\nитог два' });
	assert.equal(api.of('sendRichMessage')[0].richMessage.markdown, 'итог одна  \nитог два');
});

test('rich: таблица уходит в rich как есть — её рисует Telegram', async () => {
	const api = fakeApi({ rich: true });
	const live = createLiveMessage({ api, chatId: 12, rich: 'auto', draftEnabled: false });
	const table = '| Позиция | Цена |\n| --- | ---: |\n| Камера | 12 000 |';
	await live.finish({ text: `Смета:\n\n${table}` });
	const sent = api.of('sendRichMessage');
	assert.equal(sent.length, 1);
	assert.ok(sent[0].richMessage.markdown.includes('| --- | ---: |'), 'палки таблицы не экранируются');
	assert.equal(api.of('sendMessage').length, 0, 'в классику не уходим');
});
