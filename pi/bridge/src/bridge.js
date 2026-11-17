/**
 * Мост: Telegram ↔ сессии pi (FR1–FR5).
 *
 * Роли: session-pool.js — по процессу pi на сессию, live.js — живое сообщение,
 * sessions.js/commands.js — чистые функции с тестами, state.js — состояние на диске.
 * Здесь только связка и политика: авторизация, роутинг чат → сессия, команды, очередь, стрим.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { InlineKeyboard, InputFile } from 'grammy';

import { appendAudit, listZoneFiles, readHistory, readLogTail, readMemory } from './admin.js';
import { createAssistantApi } from './assistant-api.js';
import {
	ASSISTANT_MENU_KEYBOARD,
	ASSISTANT_MENU_TEXT,
	formatEstimateSummary,
	formatObjectCard,
	formatProjectsPage,
	formatVersions,
	latestEstimate,
} from './assistant.js';
import { chunkHtml } from './chunk.js';
import { contextLine, messageContext } from './context.js';
import {
	MAX_INCOMING_BYTES,
	checkOutgoingFile,
	dataRoots,
	downloadTelegramFile,
	incomingDocumentName,
	incomingDocumentProblem,
	photoName,
	removeSentPdf,
	splitFileMarkers,
} from './files.js';
import { createRichGate } from './rich.js';
import {
	THINKING_LEVELS,
	formatHelp,
	formatUnknownCommand,
	isStopWord,
	parseCommand,
	resolveCommand,
	resolveModelRef,
} from './commands.js';
import { escapeHtml, htmlToPlain } from './markdown.js';
import { richMessageFor } from './richtext.js';
import { errorText, redactSecrets } from './mask.js';
import { createLiveMessage } from './live.js';
import { createTextLog, clip } from './txtlog.js';
import { createSessionPool } from './session-pool.js';
import { createTurnWatchdog, formatSpan } from './watchdog.js';
import { audioFormat, formatVoiceDuration, transcribeAudio, voiceLimitProblem } from './voice.js';
import { findSession, formatRelativeTime, listSessions, sessionLabel, shortId } from './sessions.js';
import { formatCommandsHtml, formatLiveStatus, formatModelsHtml, formatStatusHtml, formatTokens } from './status.js';

const ALLOWED_UPDATES = ['message', 'callback_query', 'stopped_message_generation'];
const COMMAND_CACHE_MS = 60_000;
const SESSION_CACHE_MS = 30_000;
const POLL_TIMEOUT_SECONDS = 30;
const ABORT_TIMEOUT_MS = 10_000;
const UNSUPPORTED_MEDIA_TEXT = 'Принимаю текст, голос, фото и документы (pdf, docx, xlsx, txt, csv, json, zip до 20 МБ).';
const DEFAULT_TURN_MAX_MS = 20 * 60_000;
// Потолок стоимости одного прогона: $2, если не задан PI_TG_TURN_MAX_COST_USD.
const DEFAULT_TURN_MAX_COST_USD = 2;
// Клавиатура списка сессий: страница = число кнопок.
const KEYBOARD_LIMIT = 8;
const BUTTON_LABEL_LIMIT = 28;

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);


export function createBridge({
	bot,
	state,
	config,
	log,
	SessionManager,
	exists = existsSync,
	cliPath,
	createPi,
	fetch: fetchImpl = globalThis.fetch,
}) {
	let allowedUserId = config.allowedUserId ?? state.get().allowedUserId ?? null;
	// Корень Bot API: боевой или локальный (PI_TG_API_ROOT) — от него же берётся скачивание файлов.
	const apiRoot = String(config.apiRoot ?? 'https://api.telegram.org').replace(/\/+$/, '');
	// Белый список фаундеров (FOUNDER_USER_IDS): несколько аккаунтов и группа вместо одного спаренного.
	const allowedUserIds = new Set(config.allowedUserIds ?? []);
	let lastChat = { chatId: undefined, threadId: undefined };
	let stopped = false;
	// Кэш списка сессий на зону: у каждого профиля свой каталог сессий.
	const sessionCaches = new Map();
	// Меню/списки/архив живут на чат-тему: следующее /menu удаляет предыдущее сообщение.
	const lastMenus = new Map();
	const lastLists = new Map();
	const archiveModes = new Map();
	let commandsCache = { at: 0, list: [] };
	// rich-ответы команд: общий предохранитель, после сбоя повтор через N сообщений
	const richGate = createRichGate();
	// Текстовый лог рядом с данными (дополнение к journald): входящие, инструменты, файлы, расход, ошибки.
	const textLog = createTextLog({ dir: config.logDir, log });
	// Проекты и сметы читаем из локального API ассистента: у новостного бота его нет,
	// поэтому меню/сметы включаются только при заданном MINIAPP_API_URL.
	const assistantApi = config.miniappApiUrl
		? createAssistantApi({ baseUrl: config.miniappApiUrl, token: config.miniappServiceToken, fetch: fetchImpl })
		: null;
	// Профили: id пользователя → зона (каталоги, память, сессии, uid). Пусто — режим разработки.
	const profileState = config.profileState ?? { profiles: [], byUser: new Map() };
	const profilesEnabled = profileState.profiles.length > 0;
	const profileOf = (userId) => profileState.byUser.get(Number(userId));
	const profileOfCtx = (ctx) => ctx?.dvProfile ?? profileOf(ctx?.from?.id);
	const dataDirFor = (profile) => profile?.dataDir ?? config.dataDir;
	const zoneEnvFor = (profile) =>
		profile
			? {
					PI_CODING_AGENT_DIR: profile.agentDir,
					PI_CODING_AGENT_SESSION_DIR: profile.sessionDir,
					PI_HELPER_PROFILE: profile.slug,
					PI_HELPER_MEMORY_DB: profile.memoryDb,
					PI_HELPER_WORK_DIR: profile.workDir,
					PI_HELPER_HOME: profile.home,
					PI_HELPER_TMP: join(profile.home, 'tmp'),
					TMPDIR: join(profile.home, 'tmp'),
					PI_HELPER_ADMIN: profile.admin ? '1' : '0',
					HOME: profile.home,
				}
			: {};
	const auditFile = join(config.helperRoot ?? '/srv/dvoretsky', 'logs', 'admin-audit.log');

	const pool = createSessionPool({
		cliPath,
		log,
		createPi,
		idleMs: config.idleMs,
		maxIdle: config.maxIdleSessions,
		maxProcesses: config.maxProcesses,
		onEvent: (entry, event) => {
			try {
				dispatchPiEvent(entry, event);
			} catch (error) {
				log.warn(`событие ${event?.type}: ${errorText(error)}`);
			}
		},
	});

	// ── Отправка текста ────────────────────────────────────────────────────────

	/**
	 * Наши сообщения пишутся в HTML, но уходят rich-сообщениями (Telegram сам рисует таблицы,
	 * заголовки, цитаты). Если rich недоступен — один раз переходим на sendMessage + parse_mode.
	 */
	async function sendMarkdown({ chatId, threadId, replyTo, markdown, replyMarkup, onSent }) {
		const options = threadId === undefined ? {} : { message_thread_id: threadId };
		const chunks = chunkHtml(markdown);
		let lastId;
		for (const [index, chunk] of chunks.entries()) {
			const shared = {
				...options,
				...(index === 0 && replyTo !== undefined ? { reply_parameters: { message_id: replyTo } } : {}),
				...(index === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}),
			};
			lastId = await sendOne({ chatId, chunk, shared, options }) ?? lastId;
		}
		if (onSent && lastId) onSent({ message_id: lastId });
		return lastId;
	}

	/** rich → (если сбой) классический HTML → (если разметку отвергли) чистый текст. */
	async function sendOne({ chatId, chunk, shared, options }) {
		if (config.rich !== 'off' && bot.api.sendRichMessage && richGate.take()) {
			try {
				// Markdown-таблицы Telegram рисует встроенной таблицей; в HTML-режиме они остались бы
				// текстом с палками, поэтому такой ответ отправляем как rich markdown.
				const message = await bot.api.sendRichMessage(chatId, richMessageFor(chunk), shared);
				richGate.ok();
				return message?.message_id;
			} catch (error) {
				richGate.fail(error, log);
			}
		}
		try {
			const message = await bot.api.sendMessage(chatId, chunk, { ...shared, parse_mode: 'HTML' });
			return message.message_id;
		} catch (error) {
			// Разметку отвергли — отправляем тот же текст без тегов, а не сырой HTML.
			if (!isParseError(error)) throw error;
			const message = await bot.api.sendMessage(chatId, htmlToPlain(chunk), { ...options });
			return message.message_id;
		}
	}

	const reply = (chatId, threadId, markdown, replyTo) => sendMarkdown({ chatId, threadId, replyTo, markdown });
	const replyCtx = (ctx, markdown) =>
		reply(ctx.chat.id, ctx.message?.message_thread_id, markdown, ctx.message?.message_id);

	function isParseError(error) {
		return error?.error_code === 400 && /parse|entit|tag|unsupported/i.test(error?.description ?? '');
	}

	// Ключи разные по смыслу: меню/списки/архив живут на чат-тему, сессия pi — на чат целиком.
	const sessionKeyOf = (chatId) => state.sessionKey(chatId);
	const threadOptions = (threadId) => (threadId === undefined ? {} : { message_thread_id: threadId });
	const threadKeyOf = (chatId, threadId) => state.threadKey(chatId, config.threads === 'shared' ? undefined : threadId);
	const callbackThread = (ctx) => ctx.callbackQuery?.message?.message_thread_id;

	// ── Сессии: список с диска и процессы pi ──────────────────────────────────

	async function cachedSessions(profileOrDir, force = false) {
		// Каталог может прийти строкой (личный каталог фаундера) или профилем зоны.
		const dir = typeof profileOrDir === 'string' ? profileOrDir : profileOrDir?.sessionDir;
		const key = typeof profileOrDir === 'string' ? `dir:${dir}` : (profileOrDir?.slug ?? 'default');
		const cached = sessionCaches.get(key) ?? { at: 0, list: [] };
		if (!force && Date.now() - cached.at < SESSION_CACHE_MS) return cached.list;
		try {
			const list = await listSessions({ SessionManager, sessionDir: dir });
			sessionCaches.set(key, { at: Date.now(), list });
		} catch (error) {
			log.warn(`список сессий${profile ? ` (${profile.slug})` : ''}: ${errorText(error)}`);
			if (!cached.list.length) throw error;
		}
		return sessionCaches.get(key)?.list ?? cached.list;
	}

	/** Рабочий каталог сессии: из её же заголовка через список, иначе — каталог зоны. */
	async function cwdForSession(sessionPath, profile) {
		try {
			const found = (await cachedSessions(profile)).find((info) => info.path === sessionPath);
			if (found?.cwd) return found.cwd;
		} catch {
			// нет списка — берём каталог зоны
		}
		return profile?.workDir ?? config.cwd;
	}

	/**
	 * Активный процесс чата: привязанная сессия, иначе — новая в каталоге по умолчанию.
	 * Привязка устойчивая: пока файл сессии на диске, новый файл не заводится — ни после рестарта
	 * моста, ни после компакции, ни при смене темы форума.
	 * `env` — контекст сообщения (PI_CHAT_*), он уходит в окружение процесса pi: агент знает, где его спросили.
	 */
	async function activeFor(chatId, env = {}, profile) {
		const key = sessionKeyOf(chatId);
		const saved = state.getSession(chatId);
		const zoneEnv = { ...env, ...zoneEnvFor(profile) };
		if (saved?.sessionPath && exists(saved.sessionPath)) {
			return pool.acquire({
				sessionPath: saved.sessionPath,
				cwd: await cwdForSession(saved.sessionPath, profile),
				chatKey: key,
				env: zoneEnv,
				profile,
			});
		}
		if (saved?.sessionPath) log.warn(`файл сессии ${saved.sessionPath} пропал — завожу новую для ${key}`);
		return pool.acquire({ cwd: profile?.workDir ?? config.cwd, chatKey: key, env: zoneEnv, profile });
	}

	/** Процесс чата для сообщения: контекст (PI_CHAT_*) и зона берутся из самого апдейта. */
	const activeForCtx = (ctx) => activeFor(ctx.chat.id, messageContext(ctx), profileOfCtx(ctx));

	/** Уже поднятый процесс чата (без spawn) — для /stop и проверки занятости. */

	/** Окружение прогона для контекста: контекст чата + зона профиля. */
	const zoneEnvOf = (ctx) => ({ ...messageContext(ctx), ...zoneEnvFor(profileOfCtx(ctx)) });
	const sessionDirs = config.sessionDirs ?? {};
	/** Каталог сессий: зона профиля, иначе личный каталог фаундера (личка), иначе общий. */
	const sessionDirOf = (ctx) =>
		profileOfCtx(ctx)?.sessionDir ??
		(ctx?.chat?.type === 'private' ? sessionDirs[Number(ctx.from?.id)] : undefined);

	/** Подключить существующую сессию к чату (кнопка из /sessions или /open). */
	async function openSession(ctx, info) {
		const threadId = ctx.message?.message_thread_id ?? callbackThread(ctx);
		const profile = profileOfCtx(ctx);
		const entry = await pool.acquire({
			sessionPath: info.path,
			cwd: info.cwd || profile?.workDir || config.cwd,
			chatKey: sessionKeyOf(ctx.chat.id),
			env: zoneEnvOf(ctx),
			profile,
		});
		await syncEntry(entry);
		await persistChat(ctx.chat.id, entry);
		pool.release(entry);
		await reply(
			ctx.chat.id,
			threadId,
			[
				`Подключил сессию: <b>${escapeHtml(info.name || sessionLabel(info))}</b>`,
				`id <code>${escapeHtml(String(entry.session.id ?? '').slice(0, 8))}</code> · ${info.messageCount ?? 0} сообщ.`,
				info.cwd ? `<code>${escapeHtml(info.cwd)}</code>` : '',
				'Пишите текст — это уйдёт в неё.',
			]
				.filter(Boolean)
				.join('\n'),
		);
	}

	/** Что показать, если /open не нашёл ровно одну сессию. */
	async function reportFound(ctx, result) {
		if (result.info) {
			await openSession(ctx, result.info);
			return;
		}
		const tail = result.matches?.length
			? `\n${result.matches.map((info, index) => `${index + 1}. ${escapeHtml(sessionLabel(info))} · <code>${escapeHtml(String(info.id).slice(0, 8))}</code>`).join('\n')}`
			: '';
		await replyCtx(ctx, `⚠️ ${escapeHtml(result.error ?? 'не нашёл сессию')}. /sessions — список.${tail}`);
	}

	/** Список сессий зоны: короткий заголовок + кнопки с превью. */
	async function showSessions(ctx) {
		const sessions = await cachedSessions(sessionDirOf(ctx) ?? profileOfCtx(ctx), true);
		if (!sessions.length) {
			await replyCtx(ctx, 'Сессий не найдено. /new — начать новую.');
			return;
		}
		const threadId = ctx.message?.message_thread_id;
		const page = sessions.slice(0, KEYBOARD_LIMIT);
		lastLists.set(threadKeyOf(ctx.chat.id, threadId), page);

		const currentPath = state.getSession(ctx.chat.id)?.sessionPath;
		const live = new Set(pool.list().map((entry) => entry.session.path).filter(Boolean));
		const keyboard = new InlineKeyboard();
		page.forEach((info, index) => {
			const mark = info.path === currentPath ? '▸' : live.has(info.path) ? '●' : '';
			keyboard.text(`${index + 1}.${mark ? ` ${mark}` : ''} ${sessionLabel(info, BUTTON_LABEL_LIMIT)}`, `open:${index}`).row();
		});

		const active = currentPath ? page.find((info) => info.path === currentPath) : undefined;
		const header = [`<b>Список сессий</b> (${sessions.length}):`];
		if (active) {
			header.push(
				`▸ сейчас: ${escapeHtml(sessionLabel(active, 40))} · <code>${escapeHtml(shortId(active))}</code> · ${escapeHtml(formatRelativeTime(active.modified))}`,
			);
		}
		if (sessions.length > page.length) {
			header.push(escapeHtml(`на кнопках ${page.length} свежих, остальные — /open <id или имя>`));
		}
		await sendMarkdown({
			chatId: ctx.chat.id,
			threadId,
			replyTo: ctx.message?.message_id,
			markdown: header.join('\n'),
			replyMarkup: keyboard,
		});
	}

	function existingFor(chatId) {
		const saved = state.getSession(chatId);
		return pool.find({ sessionPath: saved?.sessionPath, chatKey: sessionKeyOf(chatId) }) ?? pool.find({ chatKey: sessionKeyOf(chatId) });
	}

	/**
	 * Привязка чат → файл сессии на диске. Нет пути/файла — запись НЕ трогается: стереть известную
	 * привязку потому, что pi ещё не создал файл, значит завести новую сессию на ровном месте.
	 */
	async function persistChat(chatId, entry) {
		const path = entry.session.path;
		if (!path || !exists(path)) {
			log.debug(`сессия ${sessionKeyOf(chatId)}: файла ещё нет, привязку не меняю`);
			return;
		}
		const previous = state.getSession(chatId)?.sessionPath;
		state.setSession(chatId, { sessionPath: path, sessionId: entry.session.id, name: entry.session.name });
		await state.save();
		if (!previous) log.info(`сессия ${sessionKeyOf(chatId)} → ${path} (новая)`);
		else if (previous !== path) log.info(`сессия ${sessionKeyOf(chatId)}: ${previous} → ${path} (компакция/новый файл)`);
	}

	/** Свежие данные сессии + перевод записи пула под ключ пути, когда путь появился или сменился. */
	async function syncEntry(entry) {
		if (entry.disposed) return entry;
		await pool.refresh(entry).catch(() => {});
		if (!entry.session.path || !exists(entry.session.path)) return entry;
		return pool.rekey(entry, entry.session.path);
	}

	// ── Ход: очередь и стрим (на каждый процесс pi свой) ──────────────────────

	function renderTurnText(turn) {
		return [...turn.blocks.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, value]) => value)
			.join('')
			.trim();
	}

	/**
	 * Строка над ответом в живом сообщении: смешная фраза о процессе меняется каждые 4 с.
	 * Мысли модели (`thinking_delta`) в чат не попадают никогда — только фраза и ⚙ инструмент.
	 */
	const THINKING_PHRASES = [
	'собираюсь с мыслями…',
	'листаю память…',
	'прикидываю, что нужно…',
	'проверяю, что уже знаю…',
	'раскладываю по полочкам…',
	'сверяюсь со своими правилами…',
	'думаю, как короче…',
	'уточняю детали…',
];
	const PHRASE_PERIOD_MS = 4000;

	function statusLine(entry) {
		const turn = entry.turn;
		const lines = [];
		if (turn.note) lines.push(turn.note);
		else if (turn.tools.size > 0) lines.push(`⚙ ${[...turn.tools].slice(-4).join(', ')}`);
		else {
			const step = Math.floor((Date.now() - turn.startedAt) / PHRASE_PERIOD_MS);
			lines.push(THINKING_PHRASES[step % THINKING_PHRASES.length]);
		}
		const strip = formatLiveStatus({ stats: turn.stats, statuses: [...entry.statuses] });
		if (strip) lines.push(strip);
		return lines.join('\n');
	}

	/** Свежие токены/контекст/стоимость для живой строки: один запрос к pi на тик, не чаще. */
	async function refreshTurnStats(entry) {
		if (!entry.turn) return;
		try {
			const stats = await entry.pi.getSessionStats();
			if (entry.turn) entry.turn.stats = stats;
		} catch (error) {
			log.debug(`статистика хода: ${errorText(error)}`);
		}
	}

	function costLimit() {
		return Number(config.turnMaxCostUsd ?? DEFAULT_TURN_MAX_COST_USD);
	}

	/** «$2», «$0.0001», «$2.13» — лимит читается человеком, а не как 2.000000. */
	function money(usd) {
		const value = Number(usd) || 0;
		return `$${value.toFixed(4).replace(/\.?0+$/, '')}`;
	}

	/** Стоимость одного ответа pi: `usage.cost.total` (объект) или готовое число. */
	function usageCost(usage) {
		const cost = usage?.cost;
		if (typeof cost === 'number') return cost;
		const total = Number(cost?.total);
		return Number.isFinite(total) ? total : 0;
	}

	/** Добавить расход готового сообщения к прогону; возвращает текст для чата при переборе. */
	function spendOf(entry, message) {
		const turn = entry.turn;
		if (!turn) return null;
		turn.costSpent = (turn.costSpent ?? 0) + usageCost(message?.usage);
		return costOverText(turn);
	}

	/** Расход прогона и текст для чата, когда перебор: `null` — в пределах лимита. */
	function costOverText(turn) {
		const spent = Number(turn?.costSpent ?? 0);
		const limit = costLimit();
		if (!Number.isFinite(spent) || spent <= limit) return null;
		return `остановил себя: прогон стоил больше ${money(limit)} (факт ${money(spent)})`;
	}

	/**
	 * Жёсткий потолок стоимости прогона (требование владельца 28.10.2026): расход берётся из pi —
	 * `usage.cost.total` каждого готового ответа (фактические данные провайдера, своей формулы нет).
	 * Перебор прерывает прогон и уходит в чат. Проверка идёт на каждом готовом ответе модели,
	 * поэтому «остановить до оплаты» нельзя: прогон останавливается до следующего вызова.
	 */
	async function checkTurnCost(entry, message) {
		const turn = entry.turn;
		if (!turn || turn.costStop) return;
		const text = message === undefined ? costOverText(turn) : spendOf(entry, message);
		if (!text) return;
		turn.costStop = true;
		log.warn(`потолок стоимости прогона: ${text} (${entry.key})`);
		const pending = entry.queue.splice(0);
		await stopUnresponsive(entry, text, { abort: true });
		for (const item of pending) {
			await reply(item.chatId, item.threadId, `⛔ ${escapeHtml(text)}`).catch(() => {});
		}
	}

	function pushLive(entry) {
		if (!entry.turn) return;
		entry.turn.live.update({ text: renderTurnText(entry.turn), status: statusLine(entry) });
	}

	async function startTurn(entry, item) {
		if (stopped) return;
		entry.busy = true;
		const live = createLiveMessage({
			api: bot.api,
			chatId: item.chatId,
			threadId: item.threadId,
			replyTo: item.messageId,
			draftEnabled: config.draftEnabled,
			rich: config.rich,
			richGate,
			log,
		});
		entry.turn = {
			item,
			profile: entry.profile,
			live,
			blocks: new Map(),
			tools: new Set(),
			note: '',
			assistant: undefined,
			startedAt: Date.now(),
		};
		// Два сторожа: тишина N секунд — заметка в чате, абсолютный потолок — ход прерывается.
		entry.turn.watchdog = createTurnWatchdog({
			inactivityMs: config.timeoutMs,
			ceilingMs: config.turnMaxMs ?? DEFAULT_TURN_MAX_MS,
			onIdle: () => {
				if (!entry.turn) return;
				entry.turn.note = `Нет событий ${formatSpan(config.timeoutMs)} — pi молчит. /stop прерывает.`;
				pushLive(entry);
			},
			onCeiling: () => void onTurnCeiling(entry),
		});
		// Статистика сразу: чтобы в живой строке были цифры с первого обновления.
		await refreshTurnStats(entry);
		if (!entry.turn) return;
		// Строка обновляется по событиям, а токены/контекст/деньги меняются сами — тикаем раз в 4 с.
		entry.turn.ticker = setInterval(() => {
			void refreshTurnStats(entry)
				.then(() => checkTurnCost(entry))
				.then(() => pushLive(entry));
		}, 4000);
		entry.turn.ticker.unref?.();
		live.start();
		pushLive(entry);
		log.info(`ход: ${entry.session.id ? entry.session.id.slice(0, 8) : entry.key}, ${item.text.length} симв. промпта`);

		try {
			// followUp: если pi ещё стримит (гонка с прошлым ходом), сообщение встаёт в очередь,
			// а не падает «Agent is already processing». Начатый прогон закончится на agent_settled.
			const disposition = await entry.pi.prompt(item.text, item.images, 'followUp');
			if (disposition === 'handled') {
				// «handled»: прогон не начинался, agent_settled не придёт (docs/rpc.md#prompt).
				await entry.pi.waitForIdle(5000).catch(() => {});
				await finishTurn(entry, { aborted: false });
			}
		} catch (error) {
			await failTurn(entry, error);
		}
	}

	async function failTurn(entry, error) {
		const turn = entry.turn;
		entry.turn = null;
		entry.busy = false;
		clearTurnTimers(turn);
		const text = errorText(error);
		log.warn(`прогон упал: ${text}`);
		textLog.error(`прогон упал: ${error?.stack ?? text}`);
		await turn?.live.finish({ error: text });
		scheduleQueue(entry);
	}

	function clearTurnTimers(turn) {
		turn?.watchdog?.stop();
		if (turn?.ticker) clearInterval(turn.ticker);
	}

	async function finishTurn(entry, { aborted } = {}) {
		const turn = entry.turn;
		if (!turn || turn.abandoned) return;
		// Ход мог закончиться раньше, чем сработал тик: расход проверяем и здесь, до закрытия сообщения.
		const costOver = costOverText(turn);
		entry.turn = null;
		clearTurnTimers(turn);
		const text = (turn.assistant?.text ?? '').trim() || renderTurnText(turn);
		const error = !aborted && turn.assistant?.stopReason === 'error' ? turn.assistant.errorMessage : undefined;
		if (costOver) {
			log.warn(`потолок стоимости прогона: ${costOver} (${entry.key})`);
			await turn.live.finish({ text: `⛔ ${costOver}` });
			entry.busy = false;
			const canonical = await syncEntry(entry);
			await persistChat(turn.item.chatId, canonical).catch((failure) =>
				log.debug(`не удалось обновить состояние сессии: ${errorText(failure)}`),
			);
			scheduleQueue(canonical);
			return;
		}
		const spent = `$${Number(turn.costSpent ?? 0).toFixed(4)}`;
		log.info(
			`ход завершён за ${((Date.now() - turn.startedAt) / 1000).toFixed(1)} с · текста ${text.length} симв. · ${spent}${aborted ? ' · прерван' : ''}${error ? ` · ошибка: ${error}` : ''}`,
		);
		textLog.info(
			`ход: ${((Date.now() - turn.startedAt) / 1000).toFixed(1)} с · ${spent} · текста ${text.length} симв.${aborted ? ' · прерван' : ''}${error ? ` · ошибка: ${clip(error)}` : ''}`,
		);
		if (error || aborted) await turn.live.finish({ text, aborted, error });
		else await finishWithFiles(turn, text);
		entry.busy = false;
		const canonical = await syncEntry(entry);
		await persistChat(turn.item.chatId, canonical).catch((failure) =>
			log.debug(`не удалось обновить состояние сессии: ${errorText(failure)}`),
		);
		scheduleQueue(canonical);
	}

	/** Маркеры `[file:…]` из ответа: текст без них в чат, файлы — sendDocument. */
	async function finishWithFiles(turn, text) {
		const parsed = splitFileMarkers(text);
		const files = [];
		const errors = [];
		// Один и тот же файл может встретиться в ответе дважды: отправляем и удаляем его один раз,
		// иначе второй sendDocument читает уже удалённый файл и даёт ложное «не удалось отправить».
		for (const path of new Set(parsed.files)) {
			const checked = checkOutgoingFile(path, { dataDir: dataDirFor(turn.profile) });
			if (checked.error) errors.push(`⚠️ Не могу отправить файл: ${checked.error}`);
			else files.push(checked);
		}

		const visible = [parsed.text, ...errors].filter(Boolean).join('\n\n');
		// Подпись — текст до маркера, если он весь и не длиннее лимита подписи Telegram.
		const caption =
			files.length === 1 && errors.length === 0 && parsed.before && !parsed.after && parsed.before.length <= 1024
				? parsed.before
				: undefined;

		if (files.length && (caption || !visible)) await turn.live.close();
		else await turn.live.finish({ text: visible });

		for (const file of files) {
			try {
				const options = turn.item.threadId === undefined ? {} : { message_thread_id: turn.item.threadId };
				if (caption) options.caption = caption;
				await bot.api.sendDocument(turn.item.chatId, new InputFile(file.path, file.name), options);
				textLog.info(`файл: ${file.name} → чат ${turn.item.chatId}`);
				// PDF одноразовый: отправили — удалили. В outbox остаётся лёгкое (smeta.csv, estimate.json),
				// из которого документ собирается заново. Не ушло — файл доживёт до уборки.
				// Файл, пересобранный соседним прогоном, не удаляем: он нужен следующей отправке.
				if (isOneShotPdf(file.name)) {
					try {
						if (!removeSentPdf(file.path, file.mtimeMs)) log.info(`PDF ${file.name} изменился во время отправки — оставляю до уборки`);
					} catch (failure) {
						log.warn(`удаление PDF ${file.name}: ${errorText(failure)}`);
					}
				}
			} catch (failure) {
				const reason = errorText(failure);
				log.warn(`файл ${file.path}: ${reason}`);
				textLog.error(`файл ${file.name}: ${reason}`);
				await reply(turn.item.chatId, turn.item.threadId, `⚠️ Не удалось отправить файл: ${escapeHtml(reason)}`);
			}
		}
	}

	function scheduleQueue(entry) {
		setTimeout(() => void runQueue(entry), 0);
	}

	async function runQueue(entry) {
		if (entry.busy || entry.disposed) return;
		const item = entry.queue.shift();
		if (!item) {
			pool.release(entry);
			return;
		}
		await startTurn(entry, item);
	}

	async function enqueuePrompt(ctx, entry, text, images) {
		textLog.info(`вход: ${contextLine(messageContext(ctx))} · ${clip(text)}`);
		entry.queue.push({
			chatId: ctx.chat.id,
			threadId: ctx.message?.message_thread_id,
			messageId: ctx.message?.message_id,
			text,
			images,
		});
		if (entry.busy) {
			await replyCtx(ctx, `pi занят в этой сессии — сообщение в очереди (позиция ${entry.queue.length}). /stop прерывает.`);
			return;
		}
		void runQueue(entry);
	}

	async function doStop(chatId, threadId, entry, ctx) {
		if (!entry?.busy) {
			await reply(chatId, threadId, 'Нет активного прогона.');
			return;
		}
		const dropped = entry.queue.splice(0);
		const tail = dropped.length ? ` Очередь (${dropped.length}) очищена.` : '';
		try {
			await abortPi(entry);
		} catch (error) {
			// P0: pi не отвечает на abort — иначе чат останется занятым навсегда.
			const text = errorText(error);
			log.warn(`прервать не удалось: ${text}`);
			await stopUnresponsive(entry, `не удалось прервать pi: ${text} — процесс остановлен`);
			await reply(
				chatId,
				threadId,
				`⚠️ pi не ответил на прерывание — процесс остановлен, следующее сообщение поднимет свежий.${tail}`,
			);
			return;
		}
		if (ctx) await replyCtx(ctx, `⏹ Прерываю.${tail}`);
		else await reply(chatId, threadId, `⏹ Прерываю.${tail}`);
	}

	/** abort с собственным таймаутом: RpcClient отвечает за 30 с, но зависший stdin может не ответить вовсе. */
	async function abortPi(entry) {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`abort не ответил за ${ABORT_TIMEOUT_MS / 1000} с`)), ABORT_TIMEOUT_MS);
			timer.unref?.();
		});
		const request = Promise.resolve().then(() => entry.pi.abort());
		// Поздний отказ после таймаута не должен стать unhandled rejection.
		request.catch(() => {});
		try {
			await Promise.race([request, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Ход снят, процесс погашен; следующее сообщение поднимет свежий. */
	async function stopUnresponsive(entry, reason, { abort = false } = {}) {
		const turn = entry.turn;
		if (turn) turn.abandoned = true;
		const pending = entry.queue.splice(0);
		if (abort) {
			await abortPi(entry).catch((error) => log.warn(`abort перед остановкой: ${errorText(error)}`));
		}
		await pool.dispose(entry);
		await failTurn(entry, new Error(reason));
		for (const item of pending) {
			try {
				await reply(item.chatId, item.threadId, '⚠️ Прогон прерван — повторите сообщение.');
			} catch (error) {
				log.warn(`не смог предупредить очередь: ${errorText(error)}`);
			}
		}
	}

	async function onTurnCeiling(entry) {
		if (!entry.turn) return;
		const span = formatSpan(config.turnMaxMs ?? DEFAULT_TURN_MAX_MS);
		log.warn(`потолок хода ${span}: останавливаю процесс ${entry.key}`);
		await stopUnresponsive(entry, `ход идёт дольше ${span} — процесс pi остановлен`, { abort: true });
	}

	// ── События pi ────────────────────────────────────────────────────────────

	function dispatchPiEvent(entry, event) {
		const turn = entry.turn;
		// Любое событие — признак жизни: сбрасываем таймер тишины (потолок хода не сбрасывается).
		if (turn) turn.watchdog?.touch();
		switch (event?.type) {
			case 'message_start':
				if (turn && isAssistant(event.message)) turn.blocks.clear();
				break;
			case 'message_update': {
				const update = event.assistantMessageEvent;
				if (!turn || !update) return;
				if (update.type === 'text_delta') {
					turn.blocks.set(update.contentIndex, `${turn.blocks.get(update.contentIndex) ?? ''}${update.delta}`);
					if (turn.note) turn.note = '';
					pushLive(entry);
				} else if (update.type === 'text_end') {
					turn.blocks.set(update.contentIndex, update.content);
					pushLive(entry);
				} else if (update.type === 'thinking_delta' || update.type === 'thinking_end') {
					// Мысли модели в чат не уходят: только фраза в статусе, которая меняется по таймеру.
					if (turn.note) turn.note = '';
					pushLive(entry);
				}
				break;
			}
			case 'tool_execution_start':
				// Запуск инструмента виден в bridge-логе: по нему разбирается, что агент делал в чате.
				textLog.info(`инструмент: ${event.toolName}${turn ? ` (чат ${turn.item.chatId})` : ''}`);
				if (!turn) return;
				turn.tools.add(event.toolName);
				pushLive(entry);
				break;
			case 'tool_execution_end':
				if (!turn) return;
				turn.tools.delete(event.toolName);
				pushLive(entry);
				break;
			case 'compaction_start':
				if (turn) {
					turn.note = '🗜 сжимаю контекст…';
					pushLive(entry);
				}
				break;
			case 'compaction_end':
				if (turn) {
					turn.note = event.errorMessage ? `🗜 сжатие не удалось: ${event.errorMessage}` : '';
					pushLive(entry);
				}
				break;
			case 'auto_retry_start':
				if (turn) {
					turn.note = `🔁 повтор ${event.attempt}/${event.maxAttempts} через ${Math.round(event.delayMs / 1000)} с`;
					pushLive(entry);
				}
				break;
			case 'auto_retry_end':
				if (turn) {
					turn.note = '';
					pushLive(entry);
				}
				break;
			case 'message_end':
				// Ответ модели готов — расход уже известен; перебор останавливает прогон до следующего вызова.
				if (turn) void checkTurnCost(entry, event.message);
				break;
			case 'agent_end':
				if (turn) turn.assistant = extractAssistantResult(event.messages);
				break;
			case 'agent_settled':
				void finishTurn(entry, { aborted: Boolean(event.aborted) });
				break;
			case 'pi_exit':
				void onPiExit(entry, event);
				break;
			case 'extension_ui_request':
				void handleExtensionUi(entry, event);
				break;
			default:
				break;
		}
	}

	/**
	 * Процесс pi умер посреди хода (упал, убит снаружи): иначе чат остался бы «занят» навсегда.
	 * Закрываем ход ошибкой, гасим запись пула и честно отвечаем тем, чьи сообщения стояли в очереди.
	 */
	async function onPiExit(entry, event) {
		const reason = event.signal ? `сигнал ${event.signal}` : `код ${event.code ?? '?'}`;
		const tail = lastStderrLine(event.stderr);
		log.error(`процесс pi (${entry.key}) остановился: ${reason}${tail ? ` · ${tail}` : ''}`);
		textLog.error(`процесс pi остановился: ${reason}${tail ? ` · ${tail}` : ''}`);
		// Сначала выгребаем очередь и снимаем запись, иначе failTurn→runQueue начнёт ход на мёртвом.
		const pending = entry.queue.splice(0);
		await pool.dispose(entry);
		await failTurn(entry, new Error(`процесс pi остановился (${reason})${tail ? `: ${tail}` : ''}`));
		for (const item of pending) {
			try {
				await reply(item.chatId, item.threadId, '⚠️ Прогон оборвался вместе с процессом pi — повторите сообщение.');
			} catch (error) {
				log.warn(`не смог предупредить очередь: ${errorText(error)}`);
			}
		}
	}

	/**
	 * Диалоги расширений (docs/rpc-extension-ui.md). В этой сборке они не показываются:
	 * отвечаем штатным `cancelled` и говорим об этом в чат — иначе ход зависнет до таймаута.
	 */
	async function handleExtensionUi(entry, request) {
		const turn = entry.turn;
		const chatId = turn?.item.chatId ?? lastChat.chatId;
		const threadId = turn?.item.threadId ?? lastChat.threadId;
		if (request.method === 'setStatus') {
			// Индикаторы расширений дочернего pi (👾/📡/🐴, баланс pi-usage) — их показывает /status.
			if (request.statusText === undefined || request.statusText === null) entry.statuses.delete(request.statusKey);
			else entry.statuses.set(String(request.statusKey), String(request.statusText));
			return;
		}
		if (request.method === 'notify') {
			if (chatId !== undefined) await reply(chatId, threadId, `ℹ️ ${escapeHtml(String(request.message ?? ''))}`);
			return;
		}
		if (request.method === 'select' || request.method === 'confirm' || request.method === 'input' || request.method === 'editor') {
			const answered = entry.pi.sendRaw({ type: 'extension_ui_response', id: request.id, cancelled: true });
			log.warn(`диалог расширения (${request.method}) отклонён${answered ? '' : ': sendRaw недоступен'}`);
			if (chatId !== undefined) {
				await reply(
					chatId,
					threadId,
					`⚠️ Расширение pi просит ввод (<b>${escapeHtml(request.method)}</b>: ${escapeHtml(String(request.title ?? ''))}). Диалоги расширений в этой сборке не поддерживаются — ответил «отмена».`,
				);
			}
			return;
		}
		log.debug(`extension_ui_request ${request.method} проигнорирован`);
	}

	// ── Приветствие ──────────────────────────────────────────────────────────

	/** /start, /menu и слово «меню»: короткая карточка бота, без кнопок проектов. */
	async function greeting(ctx) {
		const profile = profileOfCtx(ctx);
		const lines = [
			'<b>Дворецкий</b> — личный помощник на двоих.',
			'Пишите текстом или голосом, присылайте файлы. Что скажете запомнить — запомню,',
			'что поправите в поведении — допишу себе в правила.',
			'',
			`/help — команды · /status — модель и контекст${profile ? ` · зона: ${escapeHtml(profile.slug)}` : ''}`,
		];
		await replyCtx(ctx, lines.join('\n'));
	}

	// ── Меню и проекты (Mini App отключён, данные — локальный API) ─────────────

	async function showMenu(ctx) {
		const key = threadKeyOf(ctx.chat.id, ctx.message?.message_thread_id);
		const previous = lastMenus.get(key);
		if (previous) await bot.api.deleteMessage(ctx.chat.id, previous).catch(() => {});
		await sendMarkdown({
			chatId: ctx.chat.id,
			threadId: ctx.message?.message_thread_id,
			replyTo: ctx.message?.message_id,
			markdown: ASSISTANT_MENU_TEXT,
			replyMarkup: InlineKeyboard.from(ASSISTANT_MENU_KEYBOARD),
			onSent: (message) => lastMenus.set(key, message.message_id),
		});
	}

	/** Долгая операция: сразу отдельное «⏳ собираю…», затем правим это же сообщение. */
	/** Одна «страница» меню: по кнопке правим существующее сообщение, а не плодим новые. */
	async function withProgress(ctx, label, load) {
		const chatId = ctx.chat.id;
		const options = threadOptions(callbackThread(ctx));
		const fromCallback = ctx.callbackQuery?.message;
		const placeholder = fromCallback
			? { message_id: fromCallback.message_id }
			: await bot.api.sendMessage(chatId, '⏳ собираю…', options);
		if (fromCallback) {
			await bot.api
				.editMessageText(chatId, placeholder.message_id, '⏳ собираю…', { ...options, parse_mode: 'HTML' })
				.catch(() => {});
		}
		try {
			const view = await load();
			await bot.api.editMessageText(chatId, placeholder.message_id, view.text, {
				parse_mode: 'HTML',
				...(view.keyboard?.length ? { reply_markup: InlineKeyboard.from(view.keyboard) } : {}),
			});
		} catch (error) {
			const reason = errorText(error);
			log.warn(`${label}: ${reason}`);
			await bot.api
				.editMessageText(chatId, placeholder.message_id, `⚠️ не смог получить ${label}: ${escapeHtml(reason)}`, {
					parse_mode: 'HTML',
				})
				.catch((failure) => log.warn(`сообщение об ошибке (${label}): ${errorText(failure)}`));
		}
	}

	async function sendPdf(ctx, id) {
		const chatId = ctx.chat.id;
		const options = threadOptions(callbackThread(ctx));
		const placeholder = ctx.callbackQuery?.message
			? null
			: await bot.api.sendMessage(chatId, '⏳ собираю…', options);
		try {
			const { buffer, filename } = await assistantApi.getPdf(id);
			await bot.api.sendDocument(chatId, new InputFile(buffer, filename), options);
			if (placeholder) await bot.api.deleteMessage(chatId, placeholder.message_id).catch(() => {});
		} catch (error) {
			const reason = errorText(error);
			log.warn(`PDF ${id}: ${reason}`);
			const target = placeholder?.message_id ?? ctx.callbackQuery?.message?.message_id;
			if (!target) return;
			await bot.api
				.editMessageText(chatId, target, `⚠️ не смог получить PDF: ${escapeHtml(reason)}`, {
					parse_mode: 'HTML',
				})
				.catch((failure) => log.warn(`сообщение об ошибке PDF: ${errorText(failure)}`));
		}
	}

	async function projectById(id) {
		// Архивный объект тоже открывается: его возвращают из архива той же карточкой.
		const [active, inArchive] = await Promise.all([
			assistantApi.listProjects(),
			assistantApi.listProjects({ archived: true }),
		]);
		const object = [...active, ...inArchive].find((item) => Number(item.id) === Number(id));
		if (!object) throw new Error('объект не найден — обновите список');
		return object;
	}

	const archiveModeOf = (ctx) => archiveModes.get(threadKeyOf(ctx.chat.id, callbackThread(ctx))) === true;

	/** Список проектов и счётчик архива одним заходом: кнопка «Показать архив (N)» всегда с числом. */
	async function projectsView(page, archived) {
		const [active, inArchive] = await Promise.all([
			assistantApi.listProjects(),
			assistantApi.listProjects({ archived: true }),
		]);
		return formatProjectsPage(archived ? inArchive : active, page, { archived, archivedCount: inArchive.length });
	}

	async function handleAssistantCallback(ctx, data) {
		const [kind, first, second, third] = String(data).split(':');
		const chatId = ctx.chat.id;
		const threadId = callbackThread(ctx);
		const chatKey = threadKeyOf(chatId, threadId);
		switch (kind) {
			case 'menu':
				if (first === 'projects') {
					// Меню открывается на активных: архив — отдельный режим этого же сообщения.
					archiveModes.set(chatKey, false);
					await withProgress(ctx, 'проекты', () => projectsView(0, false));
				} else if (first === 'help') {
					await reply(chatId, threadId, formatHelp());
				}
				return;
			case 'proj': {
				const archived = second === 'archive' ? true : second === 'active' ? false : archiveModeOf(ctx);
				archiveModes.set(chatKey, archived);
				await withProgress(ctx, 'проекты', () => projectsView(Number(first), archived));
				return;
			}
			case 'arch': {
				// third — куда двигаем объект; вид списка после правки остаётся тем же, где нажали.
				const archived = third === 'archive';
				const page = Number(second) || 0;
				await withProgress(ctx, 'объект', async () => {
					await assistantApi.setObjectArchived(first, archived);
					return projectsView(page, archiveModeOf(ctx));
				});
				return;
			}
			case 'obj': {
				const page = Number(second) || 0;
				await withProgress(ctx, 'объект', async () => {
					const object = await projectById(first);
					const last = latestEstimate(object);
					const estimate = last ? await assistantApi.getEstimate(last.id) : undefined;
					return formatObjectCard(object, estimate, page);
				});
				return;
			}
			case 'vers': {
				const page = Number(second) || 0;
				await withProgress(ctx, 'версии', async () => formatVersions(await projectById(first), page));
				return;
			}
			case 'est': {
				const page = Number(third) || 0;
				await withProgress(ctx, 'смету', async () => formatEstimateSummary(await assistantApi.getEstimate(first), page));
				return;
			}
			case 'pdf':
				await sendPdf(ctx, first);
				return;
			default:
				return;
		}
	}

	// ── Команды чата ──────────────────────────────────────────────────────────

	async function availableCommands(entry) {
		if (Date.now() - commandsCache.at < COMMAND_CACHE_MS) return commandsCache.list;
		try {
			const list = await entry.pi.getCommands();
			commandsCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
		} catch (error) {
			log.debug(`get_commands: ${errorText(error)}`);
			commandsCache = { at: Date.now(), list: [] };
		}
		return commandsCache.list;
	}

	async function handleCommand(ctx, parsed) {
		const chatId = ctx.chat.id;
		const threadId = ctx.message?.message_thread_id;
		const action = resolveCommand(parsed.name, parsed.args);
		// Процесс pi поднимаем только там, где он реально нужен: /help и /chatid не трогают пи.
		const profile = profileOfCtx(ctx);
		const entry = () => activeFor(chatId, {}, profile);

		switch (action.kind) {
			case 'menu':
				// У ассистента меню — проекты и сметы; у новостного бота — приветствие.
				if (assistantApi) await showMenu(ctx);
				else await greeting(ctx);
				return;
			case 'help':
				await replyCtx(ctx, formatHelp());
				return;
			case 'admin':
				await handleAdmin(ctx, action.args ?? '');
				return;
			case 'chatid': {
				const who = profileOfCtx(ctx);
				const lines = [
					`chat: <code>${chatId}</code>`,
					`thread: <code>${threadId ?? '—'}</code>`,
					`user: <code>${ctx.from?.id ?? '—'}</code>`,
				];
				if (who) {
					lines.push(
						`зона: <b>${escapeHtml(who.slug)}</b> · ${who.admin ? 'администратор' : 'личная'}`,
						`каталог: <code>${escapeHtml(who.workDir)}</code>`,
					);
				}
				await replyCtx(ctx, lines.join('\n'));
				return;
			}
			case 'restart':
				await doRestart(ctx);
				return;
			case 'sessions':
				await showSessions(ctx);
				return;
			case 'continue': {
				const mine = (await cachedSessions(sessionDirOf(ctx) ?? profile)).filter(
					(info) => info.cwd === (profile?.workDir ?? config.cwd),
				);
				if (!mine.length) {
					await replyCtx(ctx, `В <code>${escapeHtml(profile?.workDir ?? config.cwd)}</code> сессий нет. /new — начать новую.`);
					return;
				}
				await openSession(ctx, mine[0]);
				return;
			}
			case 'open': {
				if (!action.query) {
					await showSessions(ctx);
					return;
				}
				await reportFound(ctx, findSession(await cachedSessions(sessionDirOf(ctx) ?? profile, true), action.query));
				return;
			}
			case 'new': {
				const active = await entry();
				if (active.busy) {
					await replyCtx(ctx, 'Идёт прогон — /stop, потом /new.');
					return;
				}
				const fresh = await pool.acquireNew({
					cwd: profile?.workDir ?? config.cwd,
					chatKey: sessionKeyOf(chatId),
					env: zoneEnvOf(ctx),
					profile,
				});
				// Старую привязку снимаем явно: у новой сессии файла ещё нет, без этого сообщение вернулось бы в прежнюю.
				state.setSession(chatId, {});
				await state.save();
				await persistChat(chatId, fresh);
				await replyCtx(ctx, '🧹 Новая сессия. Пишите первый промпт.');
				return;
			}
			case 'name': {
				const active = await entry();
				if (!action.name) {
					const current = await active.pi.getState();
					await replyCtx(ctx, `Имя сессии: <b>${escapeHtml(current.sessionName ?? '(без имени)')}</b>`);
					return;
				}
				await active.pi.setSessionName(action.name);
				await syncEntry(active);
				await persistChat(chatId, active);
				sessionCaches.clear();
				await replyCtx(ctx, `Имя сессии: <b>${escapeHtml(action.name)}</b>`);
				return;
			}
			case 'status':
				await showStatus(ctx, await entry());
				return;
			case 'stop':
				// /stop не поднимает процесс: если записи нет, прерывать нечего.
				await doStop(chatId, threadId, existingFor(chatId), ctx);
				return;
			case 'models':
				await showModels(ctx, await entry());
				return;
			case 'model':
				await chooseModel(ctx, await entry(), action.ref);
				return;
			case 'thinking':
				await chooseThinking(ctx, await entry(), action.level);
				return;
			case 'compact': {
				const active = await entry();
				if (active.busy) {
					await replyCtx(ctx, 'Идёт прогон — /stop, потом /compact.');
					return;
				}
				await replyCtx(ctx, '🗜 Сжимаю контекст…');
				const result = await active.pi.compact(action.instructions || undefined);
				await replyCtx(
					ctx,
					`🗜 Готово: ${formatTokens(result?.tokensBefore)} → ~${formatTokens(result?.estimatedTokensAfter)} токенов.`,
				);
				return;
			}
			case 'commands': {
				const list = await availableCommands(await entry());
				if (!list.length) {
					await replyCtx(ctx, 'pi не отдал команд расширений, шаблонов и скиллов.');
					return;
				}
				const shown = list.slice(0, 60).map((command) => ({
					...command,
					description: trim(command.description ?? '', 120) || command.source,
				}));
				await replyCtx(ctx, formatCommandsHtml(shown));
				return;
			}
			case 'passthrough': {
				const active = await entry();
				const list = await availableCommands(active);
				const known = list.some((command) => String(command.name).toLowerCase() === action.command);
				if (!known) {
					await replyCtx(ctx, escapeHtml(formatUnknownCommand(action.command, list.map((c) => c.name))));
					return;
				}
				await enqueuePrompt(ctx, active, `/${action.command}${action.args ? ` ${action.args}` : ''}`);
				return;
			}
			default:
				await replyCtx(ctx, escapeHtml(formatUnknownCommand(parsed.name, (await availableCommands(await entry())).map((c) => c.name))));
		}
	}

	/** /restart: погасить процесс pi этого чата. Сессия на диске остаётся — следующий запрос её поднимет. */
	async function doRestart(ctx) {
		const chatId = ctx.chat.id;
		const entry = existingFor(chatId);
		if (!entry) {
			await replyCtx(ctx, 'Процесс не запущен — перезапускать нечего. Просто напишите.');
			return;
		}
		if (entry.busy) {
			await abortPi(entry).catch((error) => log.warn(`restart: прерывание хода — ${errorText(error)}`));
		}
		await pool.dispose(entry).catch((error) => log.warn(`restart: dispose — ${errorText(error)}`));
		log.info(`/restart: процесс чата ${chatId} погашен`);
		await replyCtx(ctx, '🔄 Перезапустил. Пишите — сессия поднимется заново.');
	}

	async function showStatus(ctx, entry) {
		const current = await entry.pi.getState();
		const stats = await entry.pi.getSessionStats().catch(() => undefined);
		await replyCtx(
			ctx,
			formatStatusHtml({
				state: current,
				stats,
				queue: entry.queue.length,
				busy: entry.busy,
				statuses: [...entry.statuses],
				processes: pool.size(),
				cwd: entry.cwd ?? config.cwd,
			}),
		);
	}

	async function showModels(ctx, entry) {
		const models = await entry.pi.getAvailableModels();
		const unique = [];
		for (const model of models) {
			if (!unique.some((seen) => seen.provider === model.provider && seen.id === model.id)) unique.push(model);
		}
		const shown = unique.slice(0, 60);
		const tail = unique.length > shown.length ? `\n\nпоказаны ${shown.length} из ${unique.length}` : '';
		await replyCtx(ctx, `${formatModelsHtml(shown)}${tail}\n\n/model &lt;provider/id&gt;`);
	}

	async function chooseModel(ctx, entry, ref) {
		const models = await entry.pi.getAvailableModels();
		const resolved = resolveModelRef(models, ref);
		if (resolved.error) {
			const candidates = (resolved.candidates ?? [])
				.map((model) => `<code>${escapeHtml(`${model.provider}/${model.id}`)}</code>`)
				.join('\n');
			await replyCtx(ctx, `⚠️ ${escapeHtml(resolved.error)}${candidates ? `\n${candidates}` : ''}`);
			return;
		}
		const model = await entry.pi.setModel(resolved.provider, resolved.modelId);
		if (resolved.thinkingLevel) await entry.pi.setThinkingLevel(resolved.thinkingLevel);
		await replyCtx(
			ctx,
			`Модель: <code>${escapeHtml(`${model.provider}/${model.id}`)}</code>${resolved.thinkingLevel ? ` · thinking: ${resolved.thinkingLevel}` : ''}`,
		);
	}

	async function chooseThinking(ctx, entry, level) {
		if (!level) {
			const [current, levels] = await Promise.all([entry.pi.getState(), entry.pi.getAvailableThinkingLevels()]);
			await replyCtx(ctx, `Сейчас: <b>${escapeHtml(String(current.thinkingLevel ?? '—'))}</b>\nДоступно: ${levels.join(', ')}`);
			return;
		}
		if (!THINKING_LEVELS.includes(level)) {
			await replyCtx(ctx, `⚠️ Неизвестный уровень «${escapeHtml(level)}». Допустимо: ${THINKING_LEVELS.join(', ')}`);
			return;
		}
		await entry.pi.setThinkingLevel(level);
		const current = await entry.pi.getState();
		await replyCtx(ctx, `thinking: <b>${escapeHtml(String(current.thinkingLevel ?? level))}</b>`);
	}

	// ── Админ-доступ (только владелец, только отладка) ────────────────────────

	/**
	 * Чужая зона открывается только здесь: код моста под root, не инструменты модели.
	 * Поэтому промпт и инъекция в документе до чужой истории не достают, а каждый вызов
	 * остаётся строкой в admin-audit.log.
	 */
	async function handleAdmin(ctx, raw) {
		const me = profileOfCtx(ctx);
		const usage =
			'Что можно: <code>/admin history &lt;slug&gt; [N]</code> · <code>memory &lt;slug&gt; [запрос]</code> · ' +
			'<code>files &lt;slug&gt;</code> · <code>logs [ГГГГ-ММ-ДД]</code>';
		if (!me?.admin) {
			log.warn(`/admin от ${me?.slug ?? ctx.from?.id ?? '—'}: нет прав`);
			await replyCtx(ctx, 'Недоступно.');
			return;
		}
		const [sub, targetArg, ...rest] = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
		if (!sub) {
			await replyCtx(ctx, usage);
			return;
		}

		if (sub === 'logs') {
			const date = targetArg && /^\d{4}-\d{2}-\d{2}$/.test(targetArg) ? targetArg : new Date().toISOString().slice(0, 10);
			const { lines, error } = await readLogTail(config.logDir, date, 60);
			if (error) {
				await replyCtx(ctx, escapeHtml(error));
				return;
			}
			await appendAudit(auditFile, { by: me.slug, action: 'admin-view', target: 'logs', summary: date });
			await replyCtx(ctx, `<b>Логи моста, ${escapeHtml(date)}</b>\n<pre>${escapeHtml(redactSecrets(lines.join('\n'))).slice(0, 3800)}</pre>`);
			return;
		}

		const target = profileState.profiles.find((profile) => profile.slug === targetArg);
		if (!target) {
			await replyCtx(ctx, `Не знаю зону «${escapeHtml(targetArg ?? '')}».\n${usage}`);
			return;
		}

		if (sub === 'history') {
			const limit = Math.min(Math.max(Number(rest[0]) || 20, 1), 100);
			const rows = await readHistory(target.sessionDir, limit);
			await appendAudit(auditFile, { by: me.slug, action: 'admin-view', target: target.slug, summary: `history ${rows.length}` });
			if (!rows.length) {
				await replyCtx(ctx, `В зоне ${escapeHtml(target.slug)} истории ещё нет.`);
				return;
			}
			const body = rows
				.map((row) => `${row.role === 'user' ? '👤' : '🤖'} ${escapeHtml(clip(row.text.replace(/\s+/g, ' '), 300))}`)
				.join('\n\n');
			await replyCtx(ctx, `<b>История ${escapeHtml(target.slug)}</b> (${rows.length})\n\n${body}`.slice(0, 3900));
			return;
		}

		if (sub === 'memory') {
			const result = await readMemory(target.memoryDb, rest.join(' '), 30);
			await appendAudit(auditFile, { by: me.slug, action: 'admin-view', target: target.slug, summary: 'memory' });
			if (result.error) {
				await replyCtx(ctx, escapeHtml(result.error));
				return;
			}
			if (!result.rows.length) {
				await replyCtx(ctx, `Память ${escapeHtml(target.slug)} пуста${rest.length ? ' по этому запросу' : ''}.`);
				return;
			}
			const body = result.rows.map((row) => `#${row.id} [${escapeHtml(row.kind)}] ${escapeHtml(clip(row.text, 200))}`).join('\n');
			await replyCtx(ctx, `<b>Память ${escapeHtml(target.slug)}</b> (${result.rows.length})\n${body}`.slice(0, 3900));
			return;
		}

		if (sub === 'files') {
			const listed = await listZoneFiles(target.dataDir);
			await appendAudit(auditFile, { by: me.slug, action: 'admin-view', target: target.slug, summary: 'files' });
			const part = (name, files) =>
				`<b>${name}</b>: ${files.length}\n${files.slice(0, 15).map((file) => `· ${escapeHtml(file.name)} (${formatSize(file.size)})`).join('\n')}`;
			await replyCtx(ctx, `${part('inbox', listed.inbox)}\n${part('outbox', listed.outbox)}`.slice(0, 3900));
			return;
		}

		await replyCtx(ctx, usage);
	}

	// ── Авторизация ───────────────────────────────────────────────────────────

	async function authorize(ctx) {
		const from = ctx.from;
		if (!from) return false;

		// Боевой режим: только двое, только личка, чужому — молчание (никаких «бот занят»).
		if (profilesEnabled) {
			const isPrivate = ctx.chat?.type === 'private' || ctx.callbackQuery?.message?.chat?.type === 'private';
			if (!isPrivate) {
				log.warn(`не личка (${ctx.chat?.type ?? '—'}) от ${from.id} — игнор`);
				return false;
			}
			const profile = profileOf(from.id);
			if (!profile) {
				log.warn(`чужой пользователь ${from.id} — игнор`);
				return false;
			}
			ctx.dvProfile = profile;
			return true;
		}

		if (allowedUserIds.size > 0) {
			if (allowedUserIds.has(from.id)) return true;
			log.warn(`отказ: ${from.id} не в белом списке фаундеров`);
			await safeReply(ctx, 'Бот работает только с фаундерами ПЕРИМЕТР.');
			return false;
		}

		if (allowedUserId === null) {
			if (isStart(ctx)) {
				allowedUserId = from.id;
				state.setPairedUser(from.id);
				await state.save();
				log.warn(`бот спарен с пользователем ${from.id} (${from.username ?? from.first_name ?? '—'})`);
				return true;
			}
			await safeReply(ctx, 'Бот ещё не спарен. Отправьте /start.');
			return false;
		}

		if (from.id !== allowedUserId) {
			log.warn(`отказ: сообщение от постороннего ${from.id}`);
			await safeReply(ctx, 'Бот привязан к другому аккаунту.');
			return false;
		}
		return true;
	}

	function isStart(ctx) {
		return ctx.message?.text?.trim().split(/\s+/)[0] === '/start';
	}

	async function safeReply(ctx, text) {
		await bot.api
			.sendMessage(ctx.chat.id, text, {
				...(ctx.message?.message_thread_id === undefined ? {} : { message_thread_id: ctx.message.message_thread_id }),
			})
			.catch(() => {});
	}

	// ── Роутинг апдейтов ──────────────────────────────────────────────────────

	async function onStart(ctx) {
		// Спаривание — только в личке: иначе первый /start в группе привяжет бота к случайному участнику.
		if (ctx.chat.type !== 'private' && allowedUserId === null) {
			await safeReply(ctx, 'Спаривание — только в личке: отправьте /start боту в личном чате.');
			return;
		}
		if (!(await authorize(ctx))) return;
		if (allowedUserIds.size === 0 && !profilesEnabled && ctx.from?.id !== allowedUserId) return;
		await greeting(ctx);
	}

	async function onMessage(ctx) {
		const raw = (ctx.message.text ?? '').trim();
		const parsed = raw ? parseCommand(raw) : null;
		// Команды разрешены в любой группе; обычный текст — только после @бот или reply.
		if (!parsed && !isAddressed(ctx)) return;
		// /start — отдельный путь (спаривание), а не обычная команда: редиректим до авторизации.
		if (parsed?.name === 'start') {
			await onStart(ctx);
			return;
		}
		if (!(await authorize(ctx))) return;
		lastChat = { chatId: ctx.chat.id, threadId: ctx.message.message_thread_id };
		if (!raw) return;
		const text = stripBotMention(raw, bot.botInfo?.username);

		if (isStopWord(text)) {
			try {
				await doStop(ctx.chat.id, ctx.message.message_thread_id, existingFor(ctx.chat.id), ctx);
			} catch (error) {
				log.warn(`stop: ${errorText(error)}`);
				await replyCtx(ctx, `⚠️ ${escapeHtml(errorText(error))}`);
			}
			return;
		}
		if (parsed) {
			try {
				await handleCommand(ctx, parsed);
			} catch (error) {
				log.warn(`команда /${parsed.name}: ${errorText(error)}`);
				await replyCtx(ctx, `⚠️ ${escapeHtml(errorText(error))}`);
			}
			return;
		}

		if (text.toLowerCase() === 'меню') {
			await greeting(ctx);
			return;
		}
		if (!text) return;
		try {
			await enqueuePrompt(ctx, await activeForCtx(ctx), text);
		} catch (error) {
			log.warn(`запуск сессии: ${errorText(error)}`);
			await replyCtx(
				ctx,
				`⚠️ Не удалось поднять pi: ${escapeHtml(errorText(error))}. Проверьте PI_TG_CWD и /sessions, чтобы выбрать другую сессию.`,
			);
		}
	}

	/** Голос/аудио: скачать, распознать в OpenRouter и отправить в сессию обычным путём. */
	async function onVoice(ctx) {
		if (!isAddressed(ctx)) return;
		if (!(await authorize(ctx))) return;
		lastChat = { chatId: ctx.chat.id, threadId: ctx.message.message_thread_id };

		const media = ctx.message.voice ?? ctx.message.audio;
		if (!media) return;
		const problem = voiceLimitProblem({ duration: media.duration, fileSize: media.file_size });
		if (problem) {
			await replyCtx(ctx, escapeHtml(problem));
			return;
		}
		if (!config.sttApiKey) {
			await replyCtx(ctx, 'Голос не настроен: задайте OPENROUTER_API_KEY в .env.');
			return;
		}

		try {
			const file = await ctx.getFile();
			if (!file?.file_path) throw new Error('Telegram не отдал путь к файлу');
			const token = config.botToken ?? bot.token;
			const response = await fetchImpl(`${apiRoot}/file/bot${token}/${file.file_path}`, {
				// 20 МБ по медленному каналу: таймаут только на зависание, а не на размер.
				signal: AbortSignal.timeout(900_000),
			});
			if (!response.ok) throw new Error(`Telegram не отдал файл (${response.status})`);
			const audio = Buffer.from(await response.arrayBuffer());
			const tooBig = voiceLimitProblem({ fileSize: audio.length });
			if (tooBig) {
				await replyCtx(ctx, escapeHtml(tooBig));
				return;
			}
			const transcript = await transcribeAudio({
				data: audio,
				format: audioFormat(ctx.message),
				language: config.sttLanguage ?? 'ru',
				model: config.sttModel ?? 'openai/whisper-large-v3',
				baseUrl: config.sttBaseUrl ?? 'https://openrouter.ai/api/v1',
				apiKey: config.sttApiKey,
				fetchImpl,
			});
			const text = `[голос ${formatVoiceDuration(media.duration)}] ${transcript}`;
			try {
				await enqueuePrompt(ctx, await activeForCtx(ctx), text);
			} catch (error) {
				log.warn(`запуск сессии из голоса: ${errorText(error)}`);
				await replyCtx(ctx, `⚠️ Не удалось поднять pi (${escapeHtml(errorText(error))}). Попробуйте позже.`);
			}
		} catch (error) {
			log.warn(`голос: ${errorText(error)}`);
			await replyCtx(ctx, `⚠️ Не смог распознать голос: ${escapeHtml(errorText(error))}. Пришлите текстом.`);
		}
	}

	/** Фото: самый крупный размер скачиваем в inbox и отдаём pi картинкой (или путём). */
	async function onPhoto(ctx) {
		if (!isAddressed(ctx)) return;
		if (!(await authorize(ctx))) return;
		lastChat = { chatId: ctx.chat.id, threadId: ctx.message.message_thread_id };

		const sizes = ctx.message.photo ?? [];
		if (!sizes.length) return;
		const sizeOf = (size) => size.file_size ?? (size.width ?? 0) * (size.height ?? 0);
		const best = sizes.reduce((largest, size) => (sizeOf(size) > sizeOf(largest) ? size : largest));
		if ((best.file_size ?? 0) > MAX_INCOMING_BYTES) {
			await replyCtx(ctx, `⚠️ Фото больше ${formatMegabytes(MAX_INCOMING_BYTES)}.`);
			return;
		}

		try {
			const saved = await downloadTelegramFile({
				ctx,
				fileId: best.file_id,
				token: config.botToken ?? bot.token,
				fetchImpl,
				apiRoot,
				dir: dataRoots(dataDirFor(profileOfCtx(ctx))).inbox,
				name: photoName(),
				owner: profileOfCtx(ctx),
			});
			if (saved.size > MAX_INCOMING_BYTES) {
				await rm(saved.path, { force: true });
				await replyCtx(ctx, `⚠️ Фото больше ${formatMegabytes(MAX_INCOMING_BYTES)}.`);
				return;
			}
			const caption = (ctx.message.caption ?? '').trim();
			const entry = await activeForCtx(ctx);
			const canAttachImages = entry.pi.supportsImages ?? ((entry.pi.prompt?.length ?? 0) > 1);
			if (canAttachImages) {
				await enqueuePrompt(ctx, entry, caption || 'Посмотри на фото.', [
					{ type: 'image', data: saved.data.toString('base64'), mimeType: 'image/jpeg' },
				]);
			} else {
				await enqueuePrompt(ctx, entry, filePrompt('фото', saved.path, caption));
			}
		} catch (error) {
			log.warn(`фото: ${errorText(error)}`);
			await replyCtx(ctx, `⚠️ Не смог принять фото: ${escapeHtml(errorText(error))}.`);
		}
	}

	/** Документ: проверяем формат/размер, скачиваем в inbox, путь уходит в pi текстом. */
	async function onDocument(ctx) {
		if (!isAddressed(ctx)) return;
		if (!(await authorize(ctx))) return;
		lastChat = { chatId: ctx.chat.id, threadId: ctx.message.message_thread_id };

		const document = ctx.message.document;
		const problem = incomingDocumentProblem(document);
		if (problem) {
			await replyCtx(ctx, escapeHtml(problem));
			return;
		}

		try {
			const saved = await downloadTelegramFile({
				ctx,
				fileId: document.file_id,
				token: config.botToken ?? bot.token,
				fetchImpl,
				apiRoot,
				dir: dataRoots(dataDirFor(profileOfCtx(ctx))).inbox,
				name: incomingDocumentName(document),
				owner: profileOfCtx(ctx),
			});
			if (saved.size > MAX_INCOMING_BYTES) {
				await rm(saved.path, { force: true });
				await replyCtx(ctx, `⚠️ Документ больше ${formatMegabytes(MAX_INCOMING_BYTES)}.`);
				return;
			}
			const caption = (ctx.message.caption ?? '').trim();
			const entry = await activeForCtx(ctx);
			await enqueuePrompt(ctx, entry, filePrompt('документ', saved.path, caption));
		} catch (error) {
			log.warn(`документ: ${errorText(error)}`);
			await replyCtx(ctx, `⚠️ Не смог принять документ: ${escapeHtml(errorText(error))}.`);
		}
	}

	/** Картинки/стикеры/видео, кроме фото и документов: честный отказ без запуска pi. */
	async function onUnsupported(ctx) {
		if (!isAddressed(ctx)) return;
		if (!(await authorize(ctx))) return;
		await replyCtx(ctx, UNSUPPORTED_MEDIA_TEXT);
	}

	/** В группах — только @бот или ответ на его сообщение; в личке — всё. */
	function isAddressed(ctx) {
		if (ctx.chat?.type === 'private') return true;
		if (config.requireMention === false) return true;
		const me = bot.botInfo;
		const text = `${ctx.message?.text ?? ''}\n${ctx.message?.caption ?? ''}`;
		if (me?.username && mentionsBot(text, me.username)) return true;
		return Boolean(me?.id && ctx.message?.reply_to_message?.from?.id === me.id);
	}

	/** Нативная кнопка «стоп» в клиенте (can_stop в черновике) — прерываем прогон этой сессии. */
	async function onGenerationStopped(ctx) {
		const stopped = ctx.stoppedMessageGeneration;
		if (!stopped) return;
		const entry = pool.list().find((item) => item.turn?.item.chatId === stopped.chat.id);
		if (!entry) return;
		log.info(`остановка из клиента Telegram: чат ${stopped.chat.id}`);
		try {
			await abortPi(entry);
		} catch (error) {
			log.warn(`прервать из Telegram: ${errorText(error)}`);
			await stopUnresponsive(
				entry,
				`не удалось прервать pi из Telegram: ${errorText(error)} — процесс остановлен`,
			);
		}
	}


	async function onCallback(ctx) {
		const data = String(ctx.callbackQuery.data ?? '');
		const toast =
			data === 'menu:new'
				? 'Новая смета — пока недоступно'
				: data === 'menu:clients'
					? 'Клиенты — пока недоступно'
					: undefined;
		await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => {});
		if (!(await authorize(ctx))) return;
		const threadId = callbackThread(ctx);
		lastChat = { chatId: ctx.chat.id, threadId };

		if (/^(menu|proj|arch|obj|vers|est|pdf):/.test(data)) {
			try {
				await handleAssistantCallback(ctx, data);
			} catch (error) {
				log.warn(`меню/проекты: ${errorText(error)}`);
				await reply(ctx.chat.id, threadId, `⚠️ ${escapeHtml(errorText(error))}`);
			}
			return;
		}

		const match = /^open:(\d+)$/.exec(data);
		if (!match) return;
		const list = lastLists.get(threadKeyOf(ctx.chat.id, threadId)) ?? [];
		const info = list[Number(match[1])];
		if (!info) {
			await reply(ctx.chat.id, threadId, 'Список устарел, наберите /sessions заново.');
			return;
		}
		try {
			await openSession(ctx, info);
		} catch (error) {
			log.warn(`открытие сессии: ${errorText(error)}`);
			await reply(ctx.chat.id, threadId, `⚠️ ${escapeHtml(errorText(error))}`);
		}
	}

	// ── Long polling с сохранением offset ─────────────────────────────────────

	async function setBotCommands() {
		// Меню — одна кнопка: остальное живёт в справке, а не в списке сессий и кнопках.
		const list = [{ command: 'restart', description: 'Перезапустить сессию, если бот завис' }];
		await bot.api.setMyCommands(list).catch((error) => log.debug(`setMyCommands: ${errorText(error)}`));
	}

	async function pollLoop() {
		let backoffMs = 1000;
		while (!stopped) {
			const offset = state.get().lastUpdateId === undefined ? undefined : Number(state.get().lastUpdateId) + 1;
			try {
				const updates = await bot.api.getUpdates({
					offset,
					timeout: POLL_TIMEOUT_SECONDS,
					allowed_updates: ALLOWED_UPDATES,
				});
				backoffMs = 1000;
				for (const update of updates) {
					await bot.handleUpdate(update).catch((error) => {
						log.error(`обработка апдейта ${update.update_id}: ${errorText(error)}`);
					});
					state.setLastUpdateId(update.update_id);
				}
				if (updates.length) await state.save();
			} catch (error) {
				if (stopped) return;
				const description = error?.description ?? error?.message ?? String(error);
				if (/terminated by other getUpdates|409/.test(description)) {
					log.error(
						'конфликт getUpdates: тем же токеном опрашивает кто-то ещё — либо второй экземпляр этого моста ' +
							'(ps ax | grep src/main.js), либо старый pi-telegram (там /telegram-disconnect). ' +
							'Пока конфликт не улажен, часть сообщений теряется',
					);
				} else {
					log.warn(`getUpdates: ${errorText(error)} — повтор через ${backoffMs} мс`);
				}
				await sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, 30_000);
			}
		}
	}

	async function start() {
		stopped = false;
		await bot.init();
		const me = bot.botInfo;
		log.info(`бот: @${me.username} (${me.id}), состояние: ${state.file}`);
		if (profilesEnabled) log.info(`доступ: ${profileState.profiles.map((profile) => `${profile.slug} (${profile.userId})`).join(', ')}`);
		else log.info(`спаренный пользователь: ${allowedUserId ?? 'ещё нет (отправьте /start)'}`);
		log.info(`зон: ${profileState.profiles.length || 'разработка'} · процессов pi сейчас: ${pool.size()}`);
		await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
		await setBotCommands();
		void pollLoop();
	}

	async function stop() {
		stopped = true;
		for (const entry of pool.list()) {
			if (entry.turn) {
				clearTurnTimers(entry.turn);
				await entry.turn.live.close().catch(() => {});
			}
		}
		await pool.stopAll();
	}

	function install() {
		bot.on('message:text', (ctx) => onMessage(ctx));
		bot.on('message:voice', (ctx) => onVoice(ctx));
		bot.on('message:audio', (ctx) => onVoice(ctx));
		bot.on('message:photo', (ctx) => onPhoto(ctx));
		bot.on('message:document', (ctx) => onDocument(ctx));
		for (const filter of ['message:sticker', 'message:video']) {
			bot.on(filter, (ctx) => onUnsupported(ctx));
		}
		// Кнопки меню/проектов и списка сессий — только если Mini App API настроен.
		if (assistantApi) bot.on('callback_query:data', (ctx) => onCallback(ctx));
		bot.on('stopped_message_generation', (ctx) => onGenerationStopped(ctx));
	}

	return { start, stop, install, onStart, onMessage, onCallback, onGenerationStopped, pool };
}

/** @бот в тексте или подписи: @test_bot не должен совпадать с @test_bot2. */
function mentionsBot(text, username) {
	if (!username) return false;
	const needle = `@${String(username).toLowerCase()}`;
	const haystack = String(text ?? '').toLowerCase();
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		const next = haystack[index + needle.length];
		if (!next || !/[a-z0-9_]/.test(next)) return true;
		index = haystack.indexOf(needle, index + 1);
	}
	return false;
}

function stripBotMention(text, username) {
	if (!username) return String(text ?? '');
	const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return String(text ?? '')
		.replace(new RegExp(`@${escaped}(?![A-Za-z0-9_])`, 'gi'), ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Последняя содержательная строка stderr — чтобы в чате было видно причину падения. */
function lastStderrLine(stderr) {
	const lines = String(stderr ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('['));
	return (lines.at(-1) ?? '').slice(0, 200);
}

function extractAssistantResult(messages) {
	const list = Array.isArray(messages) ? messages : [];
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const message = list[index];
		if (message?.role !== 'assistant') continue;
		const text = Array.isArray(message.content)
			? message.content
					.filter((block) => block?.type === 'text' && typeof block.text === 'string')
					.map((block) => block.text)
					.join('')
					.trim()
			: '';
		return {
			text: text || undefined,
			stopReason: typeof message.stopReason === 'string' ? message.stopReason : undefined,
			errorMessage: typeof message.errorMessage === 'string' ? message.errorMessage : undefined,
		};
	}
	return {};
}

function isAssistant(message) {
	return message?.role === 'assistant';
}

function trim(text, limit) {
	const value = String(text ?? '').replace(/\s+/g, ' ').trim();
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function formatMegabytes(bytes) {
	return `${Math.round(bytes / (1024 * 1024))} МБ`;
}

/** Одноразовый документ: PDF отправляется и сразу удаляется, остальные файлы живут как раньше. */
function isOneShotPdf(name) {
	return String(name ?? '').toLowerCase().endsWith('.pdf');
}

function filePrompt(kind, path, caption) {
	const head = `[${kind}: ${path}]${caption ? ` ${caption}` : ''}`;
	return `${head}\n\nРазбери файл инструментами (read/bash).`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
