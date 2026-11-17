/**
 * Конфигурация только через env (см. .env.example). Токен никогда не пишется на диск.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { maskSecret } from './mask.js';
import { ProfilesError, loadProfiles } from './profiles.js';

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{15,}$/;
const DEFAULT_STATE_FILE = join(homedir(), '.pi', 'agent', 'pi-telegram-bridge', 'state.json');
const DRAFT_MODES = new Set(['auto', 'off']);
const RICH_MODES = new Set(['auto', 'off']);
const THREAD_MODES = new Set(['separate', 'shared']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);

export class ConfigError extends Error {}

export function loadConfig(env = process.env) {
	// PI_TG_BOT_TOKEN — родное имя моста; TELEGRAM_BOT_TOKEN — общий env ассистента (единый файл ключей).
	// HELPER_BOT_TOKEN — родное имя Дворецкого; PI_TG_* остались для совместимости с мостом.
	const botToken = (env.HELPER_BOT_TOKEN ?? env.PI_TG_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN ?? '').trim();
	if (!botToken) {
		throw new ConfigError(
			'HELPER_BOT_TOKEN не задан. Заполните ~/.config/ai/env/helper.env (или /etc/dvoretsky/dvoretsky.env).',
		);
	}
	if (!TOKEN_RE.test(botToken)) {
		throw new ConfigError(
			`PI_TG_BOT_TOKEN не похож на токен BotFather (получено "${maskSecret(botToken)}"). Ожидался вид 123456789:AA...`,
		);
	}

	const draft = (env.PI_TG_DRAFT ?? 'auto').trim().toLowerCase();
	if (!DRAFT_MODES.has(draft)) throw new ConfigError('PI_TG_DRAFT: допустимо только "auto" или "off"');

	const logLevel = (env.PI_TG_LOG ?? 'info').trim().toLowerCase();
	if (!LOG_LEVELS.has(logLevel)) {
		throw new ConfigError(`PI_TG_LOG: допустимо ${[...LOG_LEVELS].join(', ')}`);
	}

	const rich = (env.PI_TG_RICH ?? 'auto').trim().toLowerCase();
	if (!RICH_MODES.has(rich)) throw new ConfigError('PI_TG_RICH: допустимо только "auto" или "off"');

	const threads = (env.PI_TG_THREADS ?? 'separate').trim().toLowerCase();
	if (!THREAD_MODES.has(threads)) throw new ConfigError('PI_TG_THREADS: допустимо только "separate" или "shared"');

	// Профили: два человека — две зоны. Без HELPER_PROFILES мост работает как раньше (разработка).
	let profileState;
	try {
		profileState = loadProfiles(env);
	} catch (error) {
		if (error instanceof ProfilesError) throw new ConfigError(error.message);
		throw error;
	}

	return {
		botToken,
		// зоны пользователей: profiles/byUser + корень; пустой список — режим разработки
		profileState,
		helperRoot: profileState.root,
		// корень Bot API: локальный сервер вместо api.telegram.org (e2e-тесты, свой прокси)
		apiRoot: (env.PI_TG_API_ROOT?.trim() || 'https://api.telegram.org').replace(/\/+$/, ''),
		allowedUserId: optionalInt(env.PI_TG_ALLOWED_USER_ID, 'PI_TG_ALLOWED_USER_ID'),
		// Белый список фаундеров: несколько человек и группа вместо спаривания с одним аккаунтом.
		allowedUserIds: (env.PI_TG_ALLOWED_USER_IDS ?? env.FOUNDER_USER_IDS ?? '')
			.split(',')
			.map((id) => Number(id.trim()))
			.filter((id) => Number.isInteger(id) && id > 0),
		// каталог файлов ассистента: outbox — агенту на отправку, inbox — принятые из Telegram
		dataDir: env.PI_TG_DATA_DIR?.trim() || '/srv/assistant/data',
		// текстовые логи рядом с данными: bridge-YYYY-MM-DD.txt и bridge-heartbeat.json для сторожа
		logDir: env.PI_TG_LOG_DIR?.trim() || join(env.PI_TG_DATA_DIR?.trim() || '/srv/assistant/data', 'logs'),
		stateFile: env.PI_TG_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
		cwd: env.PI_TG_CWD?.trim() || process.cwd(),
		cliPath: env.PI_TG_CLI_PATH?.trim() || undefined,
		piArgs: splitArgs(env.PI_TG_PI_ARGS),
		timeoutMs: intEnv(env.PI_TG_TIMEOUT_MS, 'PI_TG_TIMEOUT_MS', 15 * 60_000, 5_000, 24 * 60 * 60_000),
		draftEnabled: draft === 'auto',
		// Rich Messages (Bot API 10.1+): markdown рендерит Telegram, в клиенте появляется кнопка «стоп»
		rich,
		// separate — каждая тема форума считается отдельным чатом (своя сессия)
		threads,
		// Mini App API ассистента (проекты и сметы). Нет переменной — меню/сметы выключены,
		// у новостного бота их нет; всё остальное работает как раньше.
		// Личные каталоги сессий по telegram id (форк ассистента жил с этим до слияния):
		// `PI_TG_SESSION_DIRS=603522950:/srv/.../livbig,710223847:/srv/.../partner`.
		sessionDirs: parseSessionDirs(env.PI_TG_SESSION_DIRS),
		miniappApiUrl: env.MINIAPP_API_URL?.trim() || undefined,
		miniappServiceToken: env.MINIAPP_SERVICE_TOKEN?.trim() || undefined,
		// сколько простаивает процесс pi, прежде чем его погасить (один процесс на сессию)
		idleMs: intEnv(env.PI_TG_IDLE_MS, 'PI_TG_IDLE_MS', 30 * 60_000, 60_000, 24 * 60 * 60_000),
		// сколько бездействующих процессов держать (не считая используемого сейчас)
		maxIdleSessions: intEnv(env.PI_TG_MAX_IDLE_SESSIONS, 'PI_TG_MAX_IDLE_SESSIONS', 3, 0, 20),
		// жёсткий потолок дочерних pi: на Raspberry Pi 4 ГБ каждый процесс — заметная доля памяти
		maxProcesses: intEnv(env.PI_TG_MAX_PROCESSES, 'PI_TG_MAX_PROCESSES', 4, 1, 32),
		// абсолютный потолок хода: даже если события идут, бесконечный прогон недопустим
		turnMaxMs: intEnv(env.PI_TG_TURN_MAX_MS, 'PI_TG_TURN_MAX_MS', 20 * 60_000, 1_000, 24 * 60 * 60_000),
		// жёсткий потолок стоимости одного прогона: pi отдаёт фактический расход (stats.cost)
		turnMaxCostUsd: numberEnv(env.PI_TG_TURN_MAX_COST_USD, 'PI_TG_TURN_MAX_COST_USD', 2, 0.000001, 1000),
		// в группах реагировать только на @бот или ответ на его сообщение
		requireMention: boolEnv(env.PI_TG_REQUIRE_MENTION, 'PI_TG_REQUIRE_MENTION', true),
		// OpenRouter STT (голосовые): ключ не обязателен, пока голос не нужен
		sttApiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
		sttModel: env.STT_MODEL?.trim() || 'openai/whisper-large-v3',
		sttBaseUrl: (env.STT_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
		sttLanguage: env.STT_LANGUAGE?.trim() || 'ru',
		logLevel,
	};
}

/**
 * `PI_TG_SESSION_DIRS=603522950:/srv/assistant/data/sessions/livbig,710223847:/.../partner`
 * Личный каталог сессий на человека (как в форке ассистента). Пусто — один общий каталог зоны.
 */
export function parseSessionDirs(raw) {
	const text = String(raw ?? '').trim();
	const map = {};
	if (!text) return map;
	for (const item of text.split(',').map((part) => part.trim()).filter(Boolean)) {
		const [idRaw, pathRaw] = item.split(':').slice(0, 2).map((part) => (part ?? '').trim());
		const id = Number(idRaw);
		const path = String(pathRaw ?? '');
		if (!Number.isInteger(id) || id <= 0) throw new ConfigError(`PI_TG_SESSION_DIRS: «${item}» — нужен telegram id`);
		if (!path.startsWith('/')) throw new ConfigError(`PI_TG_SESSION_DIRS: «${item}» — путь должен быть абсолютным`);
		if (map[id] && map[id] !== path) throw new ConfigError(`PI_TG_SESSION_DIRS: id ${id} указан дважды`);
		map[id] = path;
	}
	return map;
}

function intEnv(raw, name, fallback, min, max) {
	if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
	const value = Number(String(raw).trim());
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
		throw new ConfigError(`${name}: нужно целое число от ${min} до ${max}`);
	}
	return value;
}

function numberEnv(raw, name, fallback, min, max) {
	if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
	const value = Number(String(raw).trim());
	if (!Number.isFinite(value) || value < min || value > max) {
		throw new ConfigError(`${name}: нужно число от ${min} до ${max}`);
	}
	return value;
}

function boolEnv(raw, name, fallback) {
	if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
	const value = String(raw).trim().toLowerCase();
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0') return false;
	throw new ConfigError(`${name}: допустимо true или false`);
}

function optionalInt(raw, name) {
	if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
	return intEnv(raw, name, 0, 1, Number.MAX_SAFE_INTEGER);
}

/** PI_TG_PI_ARGS="--approve --no-mcp" — флаги для дочернего `pi --mode rpc`. */
function splitArgs(raw) {
	if (!raw) return [];
	return String(raw)
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}
