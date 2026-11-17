/**
 * Обёртка над RpcClient pi: один дочерний `pi --mode rpc`, ленивый перезапуск.
 * Клиент берём готовый (docs/rpc.md: «For a subprocess-based TypeScript integration, prefer the
 * exported RpcClient, which starts Pi, correlates responses, exposes typed command methods»).
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RpcClient } from '@earendil-works/pi-coding-agent';

import { errorText } from './mask.js';

// Обёртка, которая сбрасывает root до uid зоны: RpcClient сам uid менять не умеет.
const ZONE_CLI = fileURLToPath(new URL('./zone-cli.js', import.meta.url));
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const require = createRequire(import.meta.url);
const STDERR_LIMIT = 64 * 1024;
// RpcClient.prompt(message, images): возможность есть, если сигнатура принимает второй аргумент.
const SUPPORTS_IMAGES = typeof RpcClient.prototype.prompt === 'function' && RpcClient.prototype.prompt.length > 1;

/** Явные маски: секреты фронтенда ребёнку не нужны (агент не должен писать в Telegram от имени бота).
 *  RpcClient сливает `{...process.env, ...env}`, поэтому маскируем явным undefined — spawn такие ключи не передаёт. */
export const CHILD_ENV_MASK = Object.freeze({
	TELEGRAM_BOT_TOKEN: undefined,
	PI_TG_BOT_TOKEN: undefined,
	OPENROUTER_API_KEY: undefined,
});

/** Имена, под которыми живёт токен бота: PI_TG_*, HELPER_*, NEWS_* и TELEGRAM_TOKEN из общего env. */
export const BOT_TOKEN_KEY = /(^|_)(BOT_TOKEN|TELEGRAM_TOKEN)$/;

/** Все ключи окружения, похожие на токен бота, в текущем процессе. */
export function botTokenKeys(env = process.env) {
	return Object.keys(env ?? {}).filter((key) => BOT_TOKEN_KEY.test(key));
}

/** Маска окружения для дочернего pi: токенов бота там нет под любым именем.
 *  Иначе маска гасит TELEGRAM_BOT_TOKEN, а HELPER_BOT_TOKEN (тот же токен) доезжает до модели. */
export function childEnvMask(env = process.env) {
	const mask = { ...CHILD_ENV_MASK };
	for (const key of botTokenKeys(env)) mask[key] = undefined;
	return mask;
}

/** Окружение ребёнка: маска сильнее контекста зоны — токен не вернуть даже если он там есть.
 *  Одна точка сборки: spawn зовёт только её, чтобы маску нельзя было обойти по забывчивости. */
export function buildChildEnv(extra = {}, source = process.env) {
	const merged = { ...childEnvMask(source), ...(extra ?? {}) };
	for (const key of botTokenKeys(source)) merged[key] = undefined;
	return merged;
}

/** RpcClient по умолчанию спавнит `node dist/cli.js` относительно cwd — этот путь почти всегда мимо. */
export function resolveCliPath(explicit) {
	const candidates = [];
	if (explicit) candidates.push(explicit);
	// exports-карта пакета не имеет условия "require", поэтому пробуем ESM-резолв, потом CJS.
	try {
		const entry = import.meta.resolve?.('@earendil-works/pi-coding-agent');
		if (entry) candidates.push(join(dirname(fileURLToPath(entry)), 'cli.js'));
	} catch {
		// пробуем следующий способ
	}
	try {
		candidates.push(join(dirname(require.resolve('@earendil-works/pi-coding-agent')), 'cli.js'));
	} catch {
		// пробуем следующий способ
	}
	if (process.env.PI_PACKAGE_DIR) candidates.push(join(process.env.PI_PACKAGE_DIR, 'dist', 'cli.js'));
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	throw new Error(
		`Не нашёл CLI pi (проверил: ${candidates.join(', ') || '—'}). Задайте PI_TG_CLI_PATH=/путь/к/dist/cli.js`,
	);
}

export function createPi({ cliPath, cwd, args = [], env, log, profile } = {}) {
	let client = null;
	const listeners = new Set();

	const emit = (record) => {
		for (const listener of [...listeners]) {
			try {
				listener(record);
			} catch (error) {
				log?.error(`подписчик событий pi упал: ${errorText(error)}`);
			}
		}
	};

	async function spawn() {
		// Контекст чата (PI_CHAT_*) — из окружения процесса, маски секретов сильнее: их не переопределить.
		const childEnv = buildChildEnv(env);
		// Зона профиля: pi должен работать от uid человека, иначе файлы и чужие каталоги доступны мосту.
		const asRoot = Boolean(profile?.uid) && IS_ROOT;
		if (asRoot) {
			childEnv.PI_HELPER_CLI = cliPath;
			childEnv.PI_HELPER_UID = String(profile.uid);
			childEnv.PI_HELPER_GID = String(profile.gid ?? profile.uid);
			childEnv.HOME = profile.home;
		} else if (profile) {
			log?.warn(`профиль ${profile.slug}: нет uid или мост не root — pi запустится от текущего пользователя`);
		}
		const next = new RpcClient({ cliPath: asRoot ? ZONE_CLI : cliPath, cwd, args, env: childEnv });
		next.onEvent(emit);
		await next.start();
		client = next;
		// shortcut: RpcClient 1.1.0 (dist/modes/rpc/rpc-client.js) копит stderr без границы
		// (`this.stderr += data`), на долгоживущем демоне это растёт в памяти; держим хвост.
		// Перепроверить при обновлении @earendil-works/pi-coding-agent.
		next.process?.stderr?.on('data', () => {
			if (typeof next.stderr === 'string' && next.stderr.length > STDERR_LIMIT) {
				next.stderr = next.stderr.slice(-STDERR_LIMIT);
			}
		});
		// shortcut: RpcClient не сообщает о выходе дочернего процесса, а без этого мост остаётся
		// «занятым» навсегда после падения. Вешаемся на child (приватное поле) и отдаём событие
		// наверх. Проверять при смене версии pi.
		next.process?.once('exit', (code, signal) => {
			if (client !== next) return;
			const stderr = (next.getStderr?.() ?? '').trim();
			emit({ type: 'pi_exit', code, signal, stderr });
		});
		const context = env?.PI_CHAT_ID ? ` · чат ${env.PI_CHAT_ID} (${env.PI_CHAT_TYPE ?? '—'})` : '';
		log?.info(`pi RPC запущен: ${cliPath}${args.length ? ` ${args.join(' ')}` : ''}${context}`);
		return next;
	}

	// shortcut: RpcClient не сообщает о выходе дочернего процесса и держит его в приватном поле.
	// Читаем exitCode, чтобы отличить «живой» от «упал» и лениво перезапустить. Проверять при смене версии pi.
	function isAlive() {
		const child = client?.process;
		return Boolean(child) && child.exitCode === null && child.signalCode === null;
	}

	async function ensure() {
		if (client && isAlive()) return client;
		if (client) log?.warn('процесс pi недоступен — перезапускаю');
		client = null;
		return spawn();
	}

	async function call(method, ...callArgs) {
		const active = await ensure();
		try {
			return await active[method](...callArgs);
		} catch (error) {
			if (!isAlive()) client = null;
			throw error;
		}
	}

	return {
		conf: { cliPath, cwd, args, env, profile },
		isAlive,
		supportsImages: SUPPORTS_IMAGES,
		start: () => ensure(),
		async stop() {
			const active = client;
			client = null;
			if (active) await active.stop().catch(() => {});
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		prompt: (text, images, streamingBehavior) => call('prompt', text, images, streamingBehavior),
		abort: () => call('abort'),
		waitForIdle: (timeout) => call('waitForIdle', timeout),

		getState: () => call('getState'),
		getSessionStats: () => call('getSessionStats'),
		setSessionName: (name) => call('setSessionName', name),

		setModel: (provider, modelId) => call('setModel', provider, modelId),
		getAvailableModels: () => call('getAvailableModels'),
		setThinkingLevel: (level) => call('setThinkingLevel', level),
		getAvailableThinkingLevels: () => call('getAvailableThinkingLevels'),
		compact: (customInstructions) => call('compact', customInstructions),
		getCommands: () => call('getCommands'),

		/**
		 * Ответ на extension_ui_request (docs/rpc-extension-ui.md).
		 * shortcut: RpcClient.send() проставляет id и ждёт ответа, поэтому для ответа расширению
		 * пишем JSONL прямо в stdin. Если поле переименуют — вернём false и залогируем.
		 */
		sendRaw(record) {
			const stdin = client?.process?.stdin;
			if (!stdin?.writable) return false;
			stdin.write(`${JSON.stringify(record)}\n`);
			return true;
		},
	};
}
