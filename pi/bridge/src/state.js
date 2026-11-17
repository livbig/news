/**
 * Состояние на диске: маппинг чат ↔ сессия pi (FR5) и offset long polling.
 * Запись атомарная (tmp + rename), чтобы рестарт не прочитал обрезанный файл.
 *
 * Сессия привязана к ЧАТУ, а не к теме форума: у владельца ровно три чата (две лички и общий
 * чат фаундеров), значит три сессии — `dm:<userId>` или `group:<chatId>` (требование 28.10.2026).
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 1;

export function emptyState() {
	return { version: VERSION, allowedUserId: undefined, lastUpdateId: undefined, chats: {} };
}

export function createState({ file, log } = {}) {
	if (!file) throw new Error('createState: не задан путь к файлу состояния');
	let data = emptyState();

	async function load() {
		let raw;
		try {
			raw = await readFile(file, 'utf8');
		} catch (error) {
			if (error?.code === 'ENOENT') return data;
			throw error;
		}
		try {
			data = migrate(JSON.parse(raw));
		} catch {
			const backup = `${file}.corrupt-${Date.now()}`;
			await copyFile(file, backup).catch(() => {});
			log?.warn(`state-файл повреждён, копия: ${backup}; начинаю с пустого состояния`);
			data = emptyState();
		}
		return data;
	}

	async function save() {
		await mkdir(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
		await rename(tmp, file);
	}

	return {
		file,
		load,
		save,
		get: () => data,
		threadKey,
		sessionKey,
		getSession(chatId) {
			return data.chats[sessionKey(chatId)];
		},
		setSession(chatId, value) {
			const key = sessionKey(chatId);
			if (!value?.sessionPath && !value?.sessionId) {
				delete data.chats[key];
				return;
			}
			data.chats[key] = { ...value, updatedAt: new Date().toISOString() };
		},
		setPairedUser(userId) {
			data.allowedUserId = userId;
		},
		setLastUpdateId(updateId) {
			data.lastUpdateId = updateId;
		},
	};
}

/** Ключ интерфейса (меню, список сессий, режим архива): тема форума — отдельный ключ. */
export function threadKey(chatId, threadId) {
	return threadId ? `${chatId}:${threadId}` : String(chatId);
}

/** Ключ сессии: личка — `dm:<userId>`, группа — `group:<chatId>`; тема форума сессию не меняет. */
export function sessionKey(chatId) {
	const id = String(chatId);
	return `${id.startsWith('-') ? 'group' : 'dm'}:${id}`;
}

/** Старые/битые записи не должны ломать старт. */
function migrate(parsed) {
	const base = emptyState();
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
	const chats = parsed.chats && typeof parsed.chats === 'object' && !Array.isArray(parsed.chats) ? parsed.chats : {};
	return {
		version: VERSION,
		allowedUserId: typeof parsed.allowedUserId === 'number' ? parsed.allowedUserId : undefined,
		lastUpdateId: typeof parsed.lastUpdateId === 'number' ? parsed.lastUpdateId : undefined,
		chats: migrateChatKeys(chats),
	};
}

/**
 * Старые ключи (`710223847`, `-1003432441991:32846`) сводятся к ключу чата: на чат остаётся
 * самая свежая запись, темы форума больше не дают своей сессии.
 */
function migrateChatKeys(chats) {
	const out = {};
	for (const [oldKey, value] of Object.entries(chats)) {
		if (!value || typeof value !== 'object') continue;
		// Новый ключ (`dm:100`) уже в нужном виде; старый — `<chatId>` или `<chatId>:<threadId>`.
		if (/^(dm|group):-?\d+$/.test(oldKey)) {
			out[oldKey] = value;
			continue;
		}
		const chatId = String(oldKey).split(':')[0];
		if (!/^-?\d+$/.test(chatId)) continue;
		const key = sessionKey(chatId);
		const previous = out[key];
		if (!previous || toTime(value.updatedAt) >= toTime(previous.updatedAt)) out[key] = value;
	}
	return out;
}

function toTime(value) {
	const time = new Date(value ?? 0).getTime();
	return Number.isFinite(time) ? time : 0;
}
