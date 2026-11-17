#!/usr/bin/env node
/**
 * Точка входа: одна команда поднимает бота. Процессы `pi --mode rpc` запускаются лениво —
 * по одному на сессию, когда с ней впервые работают (см. src/session-pool.js).
 */

import { dirname, join } from 'node:path';

import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import { createBridge } from './bridge.js';
import { startOutboxSweep } from './files.js';
import { startHeartbeat } from './heartbeat.js';
import { ConfigError, loadConfig } from './config.js';
import { adoptLegacyPairing } from './legacy.js';
import { createLogger } from './log.js';
import { errorText, maskSecret } from './mask.js';
import { acquirePidLock, releasePidLock } from './pid-lock.js';
import { createPi, resolveCliPath } from './pi.js';
import { createState } from './state.js';

async function main() {
	const config = loadConfig();
	const log = createLogger({ level: config.logLevel });

	// Один демон на токен: второй экземпляр получает 409 и теряет часть сообщений.
	// Файл тот же, что пишет обёртка-расширение (bridge.pid рядом с state.json).
	const pidFile = join(dirname(config.stateFile), 'bridge.pid');
	const lock = acquirePidLock(pidFile);
	if (!lock.acquired) {
		process.stderr.write(
			`\n✖ Мост уже запущен (pid ${lock.pid}, ${pidFile}).\n` +
				'Второй экземпляр на том же токене даст 409 и потеряет часть сообщений.\n' +
				'Остановите его: /telegram-bridge stop в pi или kill ' +
				`${lock.pid}.\n\n`,
		);
		process.exit(3);
	}
	process.on('exit', () => releasePidLock(pidFile));
	log.debug(`pid-файл: ${pidFile}`);

	const state = createState({ file: config.stateFile, log });
	await state.load();
	await adoptLegacyPairing({ state, botToken: config.botToken, log });

	// Проверяем путь к pi сразу, чтобы ошибка была внятной до первого сообщения.
	const cliPath = resolveCliPath(config.cliPath);
	log.debug(`CLI pi: ${cliPath}`);

	const bot = new Bot(config.botToken, { client: { apiRoot: config.apiRoot } });
	bot.api.config.use(autoRetry());
	bot.catch((error) => {
		log.error(`grammy: ${errorText(error.error ?? error)}`);
	});

	const bridge = createBridge({ bot, state, config, log, SessionManager, cliPath, createPi });
	// Одноразовые файлы: в outbox живёт до отправки, зависшие убираем раз в час — по каждой зоне.
	const dataDirs = config.profileState.profiles.length
		? config.profileState.profiles.map((profile) => profile.dataDir)
		: [config.dataDir];
	for (const dataDir of dataDirs) startOutboxSweep({ dataDir, log });
	bridge.install();
	await bridge.start();

	// Отметка «мост жив» для сторожа (scripts/heartbeat.mjs в ассистенте): раз в минуту.
	const heartbeat = startHeartbeat({ dir: config.logDir, log });
	if (heartbeat.path) log.debug(`heartbeat: ${heartbeat.path}`);

		const zones = config.profileState.profiles.map((profile) => `${profile.slug}(${profile.osUser})`).join(', ');
	log.info(`токен: ${maskSecret(config.botToken)} · зоны: ${zones || `разработка, ${config.cwd}`}`);

	let shuttingDown = false;
	const shutdown = async (signal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`${signal}: останавливаюсь`);
		heartbeat.stop();
		await bridge.stop().catch(() => {});
		await state.save().catch(() => {});
		releasePidLock(pidFile);
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
	if (error instanceof ConfigError) {
		process.stderr.write(`\n✖ ${error.message}\n\n`);
		process.exit(2);
	}
	process.stderr.write(`\n✖ Не удалось запустить мост: ${errorText(error)}\n\n`);
	if (process.env.PI_TG_LOG === 'debug' && error instanceof Error) process.stderr.write(`${error.stack}\n`);
	process.exit(1);
});
