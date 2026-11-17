/**
 * Фейковый Bot API для сквозных тестов: HTTP на 127.0.0.1, без сети наружу.
 *
 * Мост поднимается настоящим процессом (`src/main.js`) с `PI_TG_API_ROOT` на этот сервер:
 * `getUpdates` отдаёт то, что тест положил в очередь, а `sendMessage`/`sendDocument` пишут,
 * что именно ушло в чат. Так проверяется весь путь апдейта, а не обработчик в отрыве от транспорта.
 */

import { createServer } from 'node:http';

const BOT_ID = 7_000_001;
const BOT_USERNAME = 'e2e_bot';
const LONG_POLL_CAP_MS = 1000;

export const BOT = { id: BOT_ID, username: BOT_USERNAME };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Текстовые поля multipart-запора: grammY кладёт их частями `content-disposition:form-data;name="<ключ>"`. */
function multipartFields(raw) {
	const text = raw.toString('utf8');
	const field = (name) => {
		const match = new RegExp(`name="${name}"\r\n\r\n([^\r]*)`).exec(text);
		return match ? match[1] : undefined;
	};
	const chatId = Number(field('chat_id'));
	const threadId = Number(field('message_thread_id'));
	return {
		chat_id: Number.isInteger(chatId) && chatId !== 0 ? chatId : undefined,
		message_thread_id: Number.isInteger(threadId) && threadId !== 0 ? threadId : undefined,
		caption: field('caption'),
		parse_mode: field('parse_mode'),
	};
}

/** Имя файла из multipart: grammY пишет `content-disposition:form-data;name="<id>";filename=<имя>`. */
function fileNameOf(raw) {
	const match = /;filename=([^\r\n]+)/.exec(raw?.toString('latin1') ?? '');
	return match ? Buffer.from(match[1], 'latin1').toString('utf8') : undefined;
}

/** Поднять фейковый Bot API. `voiceBytes` — то, что отдаётся по `/file/bot<token>/<path>`. */
export async function startFakeTelegram({ token, voiceBytes = Buffer.from('OggS-e2e-voice') } = {}) {
	const calls = [];
	const updates = new Map();
	let nextUpdateId = 1;
	let nextMessageId = 100;
	let closed = false;

	const message = (params, extra = {}) => ({
		message_id: (nextMessageId += 1),
		date: Math.floor(Date.now() / 1000),
		chat: { id: Number(params.chat_id), type: 'private', first_name: 'E2E' },
		text: params.text ?? params.caption ?? '',
		...extra,
	});

	const handlers = {
		getMe: () => ({ id: BOT_ID, is_bot: true, first_name: 'E2E', username: BOT_USERNAME, can_join_groups: true }),
		deleteWebhook: () => true,
		setMyCommands: () => true,
		sendChatAction: () => true,
		deleteMessage: () => true,
		answerCallbackQuery: () => true,
		getFile: (params) => ({
			file_id: params.file_id,
			file_unique_id: String(params.file_id),
			file_size: voiceBytes.length,
			file_path: 'voice/e2e.oga',
		}),
		getUpdates: async (params) => {
			const offset = Number(params.offset ?? 0);
			for (const id of [...updates.keys()]) if (id < offset) updates.delete(id);
			const ready = () =>
				[...updates.values()].filter((item) => item.update_id >= offset).sort((a, b) => a.update_id - b.update_id);
			const deadline = Date.now() + Math.min(Number(params.timeout ?? 0) * 1000, LONG_POLL_CAP_MS);
			while (!closed && !ready().length && Date.now() < deadline) await sleep(20);
			return ready();
		},
		sendMessage: (params) => message(params),
		editMessageText: (params) => message(params, { message_id: Number(params.message_id) }),
		sendDocument: (params, raw) => message(params, { document: { file_id: 'doc-1', file_name: fileNameOf(raw) } }),
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks);

		// Скачивание файла Telegram: /file/bot<token>/<file_path>
		const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
		if (file) {
			res.writeHead(200, { 'content-type': 'application/octet-stream' });
			return res.end(voiceBytes);
		}

		const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
		if (!match) return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
		if (token && match[1] !== token) return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });

		const method = match[2];
		const handler = handlers[method];
		if (!handler) {
			// Неизвестный метод — честная ошибка Bot API: мост уходит на запасной путь, как в бою.
			return json(res, 404, { ok: false, error_code: 404, description: `Not Found: ${method}` });
		}
		let params = {};
		const contentType = String(req.headers['content-type'] ?? '');
		if (raw.length && contentType.includes('application/json')) {
			try {
				params = JSON.parse(raw.toString('utf8'));
			} catch {
				return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: bad JSON' });
			}
		} else if (raw.length && contentType.includes('multipart/form-data')) {
			// Файл (`sendDocument`) — это multipart: chat_id и подпись приходят частями формы.
			params = multipartFields(raw);
		}
		const call = {
			method,
			kind: method === 'sendDocument' ? 'document' : method === 'sendMessage' ? 'message' : method === 'editMessageText' ? 'edit' : 'api',
			messageId: params.message_id === undefined ? undefined : Number(params.message_id),
			chatId: Number(params.chat_id ?? 0) || undefined,
			threadId: params.message_thread_id,
			text: params.text,
			caption: params.caption,
			parseMode: params.parse_mode,
			replyMarkup: params.reply_markup,
			fileName: method === 'sendDocument' ? fileNameOf(raw) : undefined,
			at: Date.now(),
		};
		calls.push(call);
		try {
			const result = await handler(params, raw);
			return json(res, 200, { ok: true, result });
		} catch (error) {
			return json(res, 400, { ok: false, error_code: 400, description: String(error?.message ?? error) });
		}
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;

	return {
		port,
		apiRoot: `http://127.0.0.1:${port}`,
		calls,
		/** Апдейт в очередь: нумерация update_id своя, как у Telegram. */
		push(update) {
			const id = nextUpdateId++;
			const payload = { update_id: id, ...update };
			updates.set(id, payload);
			return payload;
		},
		/** Первый вызов Bot API по условию. */
		async waitFor(predicate, { timeoutMs = 30_000, label = 'вызов Bot API' } = {}) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const hit = calls.find(predicate);
				if (hit) return hit;
				await sleep(25);
			}
			const seen = calls
				.filter((call) => call.kind !== 'api')
				.map((call) => `${call.kind} → ${call.chatId}: ${String(call.caption ?? call.text ?? call.fileName ?? '').slice(0, 80)}`);
			throw new Error(`не дождались: ${label}. В Telegram ушло: ${seen.join(' | ') || 'ничего'}`);
		},
		sentTo(chatId) {
			return calls.filter((call) => call.chatId === Number(chatId) && call.kind !== 'api');
		},
		async close() {
			closed = true;
			// keep-alive соединения grammY держат server.close() бесконечно — рвём их явно.
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

function json(res, code, payload) {
	res.writeHead(code, { 'content-type': 'application/json' });
	res.end(JSON.stringify(payload));
}
