#!/usr/bin/env node
/**
 * Сведение старых файлов сессий к одной сессии на чат (требование владельца 28.10.2026:
 * «максимум 3 сессии — личка Максима, личка владельца, общий чат фаундеров»).
 *
 * Что делает: для каждого чата из state.json берёт его сессию (привязку из state; если файла нет —
 * самый свежий файл в каталоге), записывает новые ключи `dm:<userId>` / `group:<chatId>`, остальные
 * файлы (и `.acp.json` рядом) уносит в `~/.pi/agent/sessions-archive/<дата>/` — не удаляет.
 *
 *   systemctl stop assistant-bridge           # файлы сессий не должны быть открыты
 *   node scripts/migrate-sessions.js          # показать план
 *   node scripts/migrate-sessions.js --apply  # сделать
 *   systemctl start assistant-bridge
 *
 * Каталог сессий: PI_SESSION_DIR или `~/.pi/agent/sessions/<закодированный cwd>`.
 * Файл состояния: PI_TG_STATE_FILE или `~/.pi/agent/pi-telegram-bridge/state.json`.
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { sessionKey } from '../src/state.js';

const apply = process.argv.includes('--apply');
const stateFile = process.env.PI_TG_STATE_FILE?.trim() || join(homedir(), '.pi', 'agent', 'pi-telegram-bridge', 'state.json');
const cwd = process.env.PI_TG_CWD?.trim() || '/srv/assistant/work';
const sessionsDir = process.env.PI_SESSION_DIR?.trim() || join(homedir(), '.pi', 'agent', 'sessions', `-${cwd.replace(/\//g, '-')}--`);

if (!exists(sessionsDir)) fail(`нет каталога сессий ${sessionsDir} (задайте PI_SESSION_DIR)`);
if (!exists(stateFile)) fail(`нет файла состояния ${stateFile} (задайте PI_TG_STATE_FILE)`);

const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const files = readdirSync(sessionsDir)
	.filter((name) => name.endsWith('.jsonl'))
	.map((name) => {
		const path = join(sessionsDir, name);
		const stat = statSync(path);
		return { path, name, mtime: stat.mtimeMs, size: stat.size };
	});

// Чаты из state: старые ключи (`710223847`, `-1003432441991:32846`) → ключ чата.
const byChat = new Map();
for (const [oldKey, value] of Object.entries(state.chats ?? {})) {
	if (!value?.sessionPath) continue;
	const chatId = String(oldKey).split(':')[0];
	if (!/^-?\d+$/.test(chatId)) continue;
	const entry = byChat.get(chatId) ?? { chatId, bindings: [] };
	entry.bindings.push(value);
	byChat.set(chatId, entry);
}

const newest = (list) => [...list].sort((a, b) => b.mtime - a.mtime)[0];
const keep = new Map();
for (const { chatId, bindings } of byChat.values()) {
	const usable = bindings
		.filter((binding) => files.some((file) => file.path === binding.sessionPath))
		.sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
	const target = usable[0]
		? files.find((file) => file.path === usable[0].sessionPath)
		: newest(files.filter((file) => !keep.has(file.path)));
	if (!target) continue;
	keep.set(target.path, { chatId, file: target });
}

if (!keep.size) {
	process.stdout.write('Нечего сводить: в состоянии нет привязок к существующим файлам сессий.\n');
	process.exit(1);
}

const archived = files.filter((file) => !keep.has(file.path));
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const archiveDir = join(homedir(), '.pi', 'agent', 'sessions-archive', stamp);

process.stdout.write(`каталог сессий: ${sessionsDir}\n`);
process.stdout.write(`файлов было: ${files.length}\n`);
for (const { chatId, file } of keep.values()) {
	process.stdout.write(`  остаётся ${sessionKey(chatId)} → ${file.name} (${Math.round(file.size / 1024)} КБ)\n`);
}
process.stdout.write(`в архив: ${archived.length} → ${archiveDir}\n`);

if (!apply) {
	process.stdout.write('Это план. Повторите с --apply, чтобы записать состояние и убрать лишние файлы в архив.\n');
	process.exit(0);
}

mkdirSync(archiveDir, { recursive: true });
for (const file of archived) {
	renameSync(file.path, join(archiveDir, file.name));
	const sidecar = `${file.path}.acp.json`;
	if (exists(sidecar)) renameSync(sidecar, join(archiveDir, `${file.name}.acp.json`));
}

const chats = {};
for (const { chatId, file } of keep.values()) {
	const previous = byChat.get(chatId)?.bindings.find((binding) => binding.sessionPath === file.path);
	const sessionId = previous?.sessionId ?? /_([0-9a-f-]{36})\.jsonl$/.exec(file.name)?.[1];
	chats[sessionKey(chatId)] = {
		sessionPath: file.path,
		...(sessionId ? { sessionId } : {}),
		...(previous?.name ? { name: previous.name } : {}),
		updatedAt: new Date().toISOString(),
	};
}
copyFileSync(stateFile, `${stateFile}.bak-${stamp}`);
mkdirSync(dirname(stateFile), { recursive: true });
writeFileSync(stateFile, `${JSON.stringify({ ...state, version: 1, chats }, null, 2)}\n`, 'utf8');

process.stdout.write(`готово: было ${files.length} → стало ${keep.size}, архив ${archived.length}\n`);
process.stdout.write(`состояние: ${stateFile} (копия ${stateFile}.bak-${stamp})\n`);

function exists(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
