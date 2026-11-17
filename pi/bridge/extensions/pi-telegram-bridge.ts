/**
 * Обёртка pi-package: управление демоном моста из pi + индикатор в нижней панели (📡, когда живой).
 *
 * Сам бот живёт отдельным процессом: он держит свои `pi --mode rpc` по сессиям, поэтому
 * встраивать его внутрь текущей сессии нельзя (см. docs/DECISIONS.md, D1/D12).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PACKAGE_DIR, "src", "main.js");
const STATE_FILE =
	process.env.PI_TG_STATE_FILE ?? join(homedir(), ".pi", "agent", "pi-telegram-bridge", "state.json");
const PID_FILE = join(dirname(STATE_FILE), "bridge.pid");
// pi рисует статусы в порядке ключей (localeCompare в footer.js), поэтому цифра — место иконки.
const STATUS_KEY = "2-telegram-bridge";
const STATUS_EMOJI = "📡";
const POLL_MS = 5000;
/** Наш лог: при старте из pi stdout/stderr ребёнка иначе уходят в никуда (stdio: "ignore"). */
const LOG_FILE = join(dirname(STATE_FILE), "bridge.log");

function readPid(): number | undefined {
	try {
		const pid = Number(readFileSync(PID_FILE, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isRunning(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function start(ctx: ExtensionCommandContext): string {
	if (!existsSync(ENTRY)) return `Не найден ${ENTRY}: пакет не собран или это копия без src/`;
	if (isRunning(readPid())) return `Мост уже запущен (pid ${readPid()}).`;

	// Лог копим в файле: иначе после /telegram-bridge start некуда смотреть (stdio: "ignore").
	const log = openSync(LOG_FILE, "a");
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(
			process.execPath,
			[
				"--env-file-if-exists=" + join(PACKAGE_DIR, ".env"),
				"--env-file-if-exists=" + join(ctx.cwd, ".env"),
				ENTRY,
			],
			{
				cwd: ctx.cwd,
				detached: true,
				stdio: ["ignore", log, log],
				env: { ...process.env, PI_TG_CWD: process.env.PI_TG_CWD ?? ctx.cwd },
			},
		);
	} finally {
		closeSync(log); // у ребёнка остался свой дескриптор
	}
	child.unref();
	writeFileSync(PID_FILE, `${child.pid}\n`, "utf8");
	return `Мост запущен (pid ${child.pid}), каталог новых сессий: ${ctx.cwd}. Логи — ${LOG_FILE}`;
}

function stop(): string {
	const pid = readPid();
	if (!isRunning(pid)) {
		rmSync(PID_FILE, { force: true });
		return "Мост не запущен.";
	}
	process.kill(pid as number, "SIGTERM");
	rmSync(PID_FILE, { force: true });
	return `Мост остановлен (pid ${pid}).`;
}

function status(ctx: ExtensionCommandContext): string {
	const pid = readPid();
	if (!isRunning(pid)) return "Мост не запущен. /telegram-bridge start";
	let chats = 0;
	try {
		const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { chats?: Record<string, unknown> };
		chats = Object.keys(state.chats ?? {}).length;
	} catch {
		// состояния ещё нет
	}
	const tokenSet = Boolean(process.env.PI_TG_BOT_TOKEN);
	const envFile = existsSync(join(PACKAGE_DIR, ".env")) || existsSync(join(ctx.cwd, ".env"));
	return [
		`pid ${pid}, состояние: ${STATE_FILE}, чатов в маппинге: ${chats}`,
		`токен: ${tokenSet ? "в окружении" : envFile ? "в .env" : "не найден (демон не поднимется)"}`,
	].join(" | ");
}

export default function piTelegramBridge(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;
	let shown: string | undefined;

	/** 📡 в нижней панели, пока демон жив; иначе индикатора нет. */
	const refreshStatus = (ctx?: ExtensionContext) => {
		if (ctx?.ui) lastCtx = ctx;
		const target = ctx ?? lastCtx;
		const next = isRunning(readPid()) ? STATUS_EMOJI : undefined;
		if (next === shown) return;
		shown = next;
		target?.ui?.setStatus?.(STATUS_KEY, next);
	};

	const watch = (ctx: ExtensionContext) => {
		refreshStatus(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => refreshStatus(), POLL_MS);
		timer.unref?.();
	};

	pi.on("session_start", (_event, ctx) => watch(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		shown = undefined;
		ctx?.ui?.setStatus?.(STATUS_KEY, undefined);
	});

	pi.registerCommand("telegram-bridge", {
		description: "Мост Telegram → сессии pi: start | stop | status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const action = (args ?? "").trim().split(/\s+/)[0] || "status";
			let message: string;
			switch (action) {
				case "start":
					message = start(ctx);
					break;
				case "stop":
					message = stop();
					break;
				case "status":
					message = status(ctx);
					break;
				default:
					message = `Неизвестное действие «${action}». Доступно: start | stop | status`;
			}
			watch(ctx);
			ctx.ui.notify(message, action === "start" && message.includes("Не найден") ? "error" : "info");
		},
	});
}
