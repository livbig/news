/**
 * Живое сообщение хода (FR4): «думаю…» → растущий текст в ОДНОМ сообщении → финал.
 *
 * Основной путь — Rich Messages (`sendRichMessageDraft`/`sendRichMessage`): Telegram сам рендерит
 * markdown, поэтому не нужен конвертер, а `can_stop: true` даёт пользователю кнопку «стоп» в
 * клиенте (docs: core.telegram.org#sendrichmessagedraft). Всё это новое, поэтому при первой же
 * ошибке метод отключается и остаток процесса идёт классическим путём: черновик
 * `sendMessageDraft` → `editMessageText` по одному message_id → финал `sendMessage` с нашим
 * GFM→HTML. Черновик эфемерен («must call sendMessage with the complete message to persist it»),
 * поэтому финальный текст всегда уходит реальным сообщением.
 */

import { GrammyError } from 'grammy';

import { TELEGRAM_MAX_LENGTH, chunkHtml, chunkMarkdown } from './chunk.js';
import { escapeHtml, headingsToBold, htmlToPlain, markdownToPlain, toTelegramHtml, hardenLineBreaks } from './markdown.js';
import { createRichGate } from './rich.js';
import { createThrottle } from './throttle.js';

const DRAFT_INTERVAL_MS = 400;
const EDIT_INTERVAL_MS = 800;

/** Общий предохранитель для тестов и прямых вызовов createLiveMessage; мост передаёт свой. */
const defaultRichGate = createRichGate();

/**
 * Черновики Telegram недоступны не во всех чатах: группа/форум отвечает `TEXTDRAFT_PEER_INVALID`.
 * Запоминаем такой чат, иначе каждый ответ тратит попытку и пишет предупреждение в лог.
 */
const noDraftsIn = new Set();

/** Для тестов: сброс знания о поддержке rich-сообщений и черновиков. */
export function resetRichSupport(value = 'unknown') {
	defaultRichGate.reset(value !== 'no');
	noDraftsIn.clear();
}

/** Telegram ругается на разметку кодом 400: «can't parse entities: ...». */
export function isParseError(error) {
	if (!(error instanceof GrammyError)) return false;
	if (error.error_code !== 400) return false;
	return /parse|entit|tag|unsupported/i.test(error.description ?? '');
}

/** Правка без изменений — не ошибка. */
function isNotModified(error) {
	return error instanceof GrammyError && error.error_code === 400 && /not modified/i.test(error.description ?? '');
}

export function createLiveMessage({
	api,
	chatId,
	threadId,
	replyTo,
	draftEnabled = true,
	rich = 'auto',
	richGate = defaultRichGate,
	log,
} = {}) {
	const throttle = createThrottle({
		intervalMs: () => (format === 'draft' || format === 'rich' ? DRAFT_INTERVAL_MS : EDIT_INTERVAL_MS),
	});

	// format — путь ЖИВОГО сообщения: rich (markdown черновиком) | draft (черновик + editMessageText) |
	// message (editMessageText с HTML) | plain (без разметки). Финальный ответ решает richFinal:
	// отказ ЧЕРНОВИКА (в группах их нет) не должен отменять rich-сообщение с таблицами.
	let richFinal = rich !== 'off' && richGate.take();
	const canDraft = () => draftEnabled && !noDraftsIn.has(String(chatId));
	let format = richFinal ? 'rich' : canDraft() ? 'draft' : 'message';
	let draftId = randomDraftId();
	let messageId;
	let text = '';
	let status = '';
	let sent = '';
	let replied = false;
	let closed = false;
	let typingTimer;

	const threadOption = threadId === undefined ? {} : { message_thread_id: threadId };
	const htmlOptions = () => ({ ...threadOption, ...(format === 'plain' ? {} : { parse_mode: 'HTML' }) });

	/** Ответ на исходное сообщение — один раз и только у обычного сообщения (черновик не умеет). */
	function replyOptions() {
		if (replied || replyTo === undefined) return {};
		replied = true;
		return { reply_parameters: { message_id: replyTo } };
	}

	function compose() {
		// markdown → HTML только в режиме message: там уходит parse_mode, и иначе в чате видны
		// звёздочки и палки таблицы. Черновик и plain — обычный текст.
		const body = !text ? '' : format === 'rich' ? hardenLineBreaks(headingsToBold(text)) : format === 'message' ? toTelegramHtml(text) : format === 'plain' ? markdownToPlain(text) : text;
		// Строка статуса может быть в две строки (ход + цифры): каждую оборачиваем отдельно.
		const head = status
			? status
					.split('\n')
					.map((line) => (format === 'rich' ? `_${line}_` : format === 'message' ? `<i>${escapeHtml(line)}</i>` : line))
					.join('\n')
			: '';
		return [head, body].filter(Boolean).join('\n\n');
	}

	function preview() {
		const body = compose();
		if (body.length <= TELEGRAM_MAX_LENGTH) return body;
		const limit = TELEGRAM_MAX_LENGTH - 1;
		return `${truncatePreview(body, limit, format === 'rich')}…`;
	}

	/** Rich-сообщение не сработало: на этом сообщении больше не пробуем, следующие N — классикой. */
	function downgrade(error) {
		richFinal = false;
		richGate.fail(error, log);
		format = canDraft() ? 'draft' : 'message';
		sent = '';
	}

	/**
	 * Черновик не сработал: живую строку ведём следующим путём (`next`), rich-сообщение в финале
	 * остаётся возможным. Отказ из-за типа чата запоминаем, чтобы не пробовать в нём каждый раз.
	 */
	function draftFailed(error, next) {
		const reason = error?.description ?? error?.message ?? error;
		if (/DRAFT_PEER_INVALID|CHAT_INVALID/i.test(reason)) noDraftsIn.add(String(chatId));
		format = noDraftsIn.has(String(chatId)) ? 'message' : next;
		log?.debug(`черновик не сработал (${reason}), живое сообщение — ${format}`);
		sent = '';
	}

	async function push() {
		if (closed) return;
		const body = preview();
		if (!body || body === sent) return;

		if (format === 'rich') {
			try {
				await api.sendRichMessageDraft(chatId, draftId, { markdown: body }, { ...threadOption, can_stop: true });
				richGate.ok();
				sent = body;
				return;
			} catch (error) {
				// Это отказ черновика, а не rich-сообщения: таблицы в финале всё ещё рисует Telegram.
				draftFailed(error, 'draft');
				return push();
			}
		}

		if (format === 'draft') {
			try {
				await api.sendMessageDraft(chatId, draftId, body, { ...threadOption, can_stop: true });
				sent = body;
				return;
			} catch (error) {
				if (isParseError(error) && format !== 'plain') {
					format = 'plain';
					return push();
				}
				draftFailed(error, 'message');
				return push();
			}
		}

		try {
			if (messageId === undefined) {
				const sentMessage = await api.sendMessage(chatId, body, { ...htmlOptions(), ...replyOptions() });
				messageId = sentMessage.message_id;
			} else {
				await api.editMessageText(chatId, messageId, body, htmlOptions());
			}
			sent = body;
		} catch (error) {
			if (isParseError(error) && format !== 'plain') {
				format = 'plain';
				return push();
			}
			if (isNotModified(error)) {
				sent = body;
				return;
			}
			throw error;
		}
	}

	function schedule() {
		throttle.schedule(String(chatId), () =>
			push().catch((error) => log?.debug(`живое обновление: ${error?.description ?? error?.message}`)),
		);
	}

	/** Rich-сообщение: markdown уходит как есть, таблицы рисует Telegram. Ошибка — наверх. */
	async function sendRich(markdown, { edit = false } = {}) {
		const message = await api.sendRichMessage(
			chatId,
			{ markdown: hardenLineBreaks(headingsToBold(markdown)) },
			{ ...threadOption, ...(edit ? {} : replyOptions()) },
		);
		richGate.ok();
		return message;
	}

	/** Классический путь: HTML уже собран, отправляем его по частям без разрыва тегов. */
	async function sendHtml(html, { edit }) {
		const options = { ...htmlOptions(), ...(edit ? {} : replyOptions()) };
		try {
			return edit
				? await api.editMessageText(chatId, messageId, html, options)
				: await api.sendMessage(chatId, html, { ...options });
		} catch (error) {
			if (isParseError(error) && format !== 'plain') {
				format = 'plain';
				return sendHtml(htmlToPlain(html), { edit });
			}
			if (edit && isNotModified(error)) return undefined;
			throw error;
		}
	}

	/** Финальный текст: одна часть — правим живое сообщение, много — живём дальше новыми. */
	async function deliver(finalText) {
		let chunks = chunkMarkdown(finalText);
		if (chunks.length === 0) {
			await replaceLive('✅ Готово');
			return;
		}

		if (richFinal) {
			let delivered = 0;
			try {
				for (const chunk of chunks) {
					await sendRich(chunk);
					delivered += 1;
				}
				return;
			} catch (error) {
				// Rich не сработал: тот же смысл досказываем классическим путём, без дублей уже ушедшего.
				downgrade(error);
				chunks = chunks.slice(delivered);
			}
		}

		// Классический путь: markdown режем по таблицам, потом HTML — по тегам.
		const parts = chunks.flatMap((chunk) => chunkHtml(format === 'plain' ? markdownToPlain(chunk) : toTelegramHtml(chunk)));
		if (parts.length === 0) {
			await replaceLiveHtml('✅ Готово');
			return;
		}
		await replaceLiveHtml(parts[0]);
		for (const part of parts.slice(1)) await sendHtml(part, { edit: false });
	}

	async function replaceLiveHtml(html) {
		if (messageId !== undefined) {
			await sendHtml(html, { edit: true });
			return;
		}
		await sendHtml(html, { edit: false });
	}

	/** Короткий финальный текст (стоп, ошибка, «готово»): rich, если он доступен, иначе классика. */
	async function replaceLive(markdown) {
		if (richFinal) {
			try {
				// В rich-режиме живого сообщения не существует (черновик эфемерен) — всегда новое.
				await sendRich(markdown);
				return;
			} catch (error) {
				downgrade(error);
			}
		}
		await replaceLiveHtml(format === 'plain' ? markdownToPlain(markdown) : toTelegramHtml(markdown));
	}

	function startTyping(action = 'typing') {
		void api.sendChatAction(chatId, action, threadOption).catch(() => {});
		typingTimer = setInterval(() => {
			void api.sendChatAction(chatId, action, threadOption).catch(() => {});
		}, 4000);
		typingTimer.unref?.();
	}

	return {
		get format() {
			return format;
		},
		get messageId() {
			return messageId;
		},
		get draftId() {
			return draftId;
		},
		start() {
			startTyping();
		},
		/** @param {{text?: string, status?: string}} next */
		update(next = {}) {
			if (next.text !== undefined) text = next.text;
			if (next.status !== undefined) status = next.status;
			schedule();
		},
		async finish({ text: finalText, aborted = false, error } = {}) {
			if (closed) return;
			closed = true;
			if (typingTimer) clearInterval(typingTimer);
			throttle.cancel(String(chatId));

			const body = (finalText ?? text).trim();
			if (body) {
				text = body;
				status = '';
			}
			try {
				if (error) {
					await replaceLive(`⚠️ pi: ${error}`);
					return;
				}
				if (aborted) {
					await replaceLive(text ? `${text}\n\n⏹ Остановлено` : '⏹ Остановлено');
					return;
				}
				await deliver(text);
			} catch (failure) {
				log?.warn(`не удалось отправить финал: ${failure?.description ?? failure?.message ?? failure}`);
				// Последний резерв: простой текст без разметки, а не сырой markdown.
				const plain = error ? String(error) : markdownToPlain(text || '⚠️ Не удалось отправить ответ');
				await api.sendMessage(chatId, plain.slice(0, TELEGRAM_MAX_LENGTH), threadOption).catch(() => {});
			}
		},
		/** Гасит живое сообщение, ничего не отправляя (используется при остановке моста). */
		async close() {
			if (closed) return;
			closed = true;
			if (typingTimer) clearInterval(typingTimer);
			throttle.cancel(String(chatId));
		},
	};
}

function randomDraftId() {
	// «must be non-zero» — docs#sendmessagedraft
	return Math.max(1, Math.floor(Math.random() * 2_000_000_000));
}

const VOID_TAGS = new Set(['br', 'img', 'hr']);

/** Черновик растёт, а не показывает один статус: режем по строке/тегу, не разваливая разметку. */
function truncatePreview(body, limit, rich) {
	let cut = body.slice(0, limit);
	if (rich) {
		// Строка markdown (в т.ч. строка таблицы) должна остаться целой; незакрытый fence закрываем.
		const newline = cut.lastIndexOf('\n');
		if (newline > 0) cut = cut.slice(0, newline);
		if (((cut.match(/^```/gm) ?? []).length) % 2 === 1) cut += '\n```';
		return cut;
	}

	// HTML: не обрываемся посреди тега и закрываем открытые inline-теги.
	const tag = cut.lastIndexOf('<');
	if (tag > cut.lastIndexOf('>')) cut = cut.slice(0, tag);
	const open = [];
	for (const match of cut.matchAll(/<(\/?)([A-Za-z0-9:-]+)[^>]*>/g)) {
		const name = match[2].toLowerCase();
		if (match[1]) {
			const index = open.lastIndexOf(name);
			if (index !== -1) open.splice(index, 1);
		} else if (!VOID_TAGS.has(name) && !match[0].endsWith('/>')) {
			open.push(name);
		}
	}
	return cut + open.reverse().map((name) => `</${name}>`).join('');
}
