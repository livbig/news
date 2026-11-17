/**
 * Расширение Дворецкого: память одного человека + границы зоны.
 *
 * Ставится в каталог агента каждой зоны (`pi install /srv/dvoretsky/app`). Пути берутся из env,
 * который кладёт мост (PI_HELPER_*): один и тот же код обслуживает двух человек, но база, зона
 * и права у каждого свои. Дайджест памяти подмешивается в системный промпт прогона — приём
 * Ассистента: отдельное system-сообщение до модели не доходит, а возвращённый systemPrompt доходит.
 */

import { blockedReason, backupRules } from '../src/memory/guard.js';
import {
	appendDigest,
	buildDigest,
	forget,
	listFacts,
	openMemory,
	recall,
	remember,
} from '../src/memory/store.js';

const json = (details) => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
const failure = (error) => ({
	content: [{ type: 'text', text: `Ошибка: ${String(error?.message ?? error)}` }],
	details: { error: String(error?.message ?? error) },
	isError: true,
});
const guard = (run) => async (...args) => {
	try {
		return await run(...args);
	} catch (error) {
		return failure(error);
	}
};

const KINDS = ['fact', 'preference', 'rule', 'plan', 'contact', 'note'];

export default function helperExtension(pi) {
	const memoryPath = process.env.PI_HELPER_MEMORY_DB;
	const slug = process.env.PI_HELPER_PROFILE ?? 'unknown';
	const admin = process.env.PI_HELPER_ADMIN === '1';
	if (!memoryPath) throw new Error('helper: не задан PI_HELPER_MEMORY_DB — расширение ставится мостом, а не руками');

	let db;
	const memory = () => {
		if (!db) db = openMemory(memoryPath);
		return db;
	};

	pi.registerTool({
		name: 'remember',
		label: 'Запомнить',
		description:
			'Запомнить факт, предпочтение, план или контакт этого человека в его личную память. ' +
			'Вызывай, когда просят «запомни», или когда человек сообщает о себе что-то постоянное. ' +
			'Повторная запись того же самого обновляет строку, а не создаёт дубль.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Одна мысль, коротко, словами человека' },
				kind: { type: 'string', enum: KINDS, description: 'Вид записи; по умолчанию fact' },
				tags: { type: 'string', description: 'Слова для поиска через запятую' },
			},
			required: ['text'],
			additionalProperties: false,
		},
		execute: guard(async (_toolCallId, params = {}) => {
			const saved = remember(memory(), {
				text: params.text,
				kind: params.kind ?? 'fact',
				tags: params.tags ?? '',
				by: slug,
			});
			return json({ saved: true, ...saved });
		}),
	});

	pi.registerTool({
		name: 'recall',
		label: 'Вспомнить',
		description:
			'Найти в личной памяти этого человека: факты, предпочтения, планы, контакты. ' +
			'Вызывай перед ответом на вопрос о прошлом («когда», «что решили», «где») и когда человек ссылается на сказанное раньше.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Слова для поиска; пусто — самое свежее' },
				limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Сколько записей вернуть, по умолчанию 10' },
			},
			required: [],
			additionalProperties: false,
		},
		execute: guard(async (_toolCallId, params = {}) => {
			const rows = recall(memory(), params.query ?? '', params.limit ?? 10);
			return json({ found: rows.length, rows });
		}),
	});

	pi.registerTool({
		name: 'forget',
		label: 'Забыть',
		description: 'Удалить запись из личной памяти по её номеру (#id из recall или дайджеста).',
		parameters: {
			type: 'object',
			properties: { id: { type: 'integer', description: 'Номер записи' } },
			required: ['id'],
			additionalProperties: false,
		},
		execute: guard(async (_toolCallId, params = {}) => {
			const result = forget(memory(), params.id, { by: slug });
			if (!result.found) return json({ deleted: false, reason: `записи #${params.id} нет` });
			return json({ deleted: true, ...result });
		}),
	});

	pi.registerTool({
		name: 'memory_list',
		label: 'Что помню',
		description: 'Список записей личной памяти, свежие сверху; можно отфильтровать по виду.',
		parameters: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: KINDS, description: 'Вид записи' },
				limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Сколько записей, по умолчанию 20' },
			},
			required: [],
			additionalProperties: false,
		},
		execute: guard(async (_toolCallId, params = {}) => {
			const rows = listFacts(memory(), { kind: params.kind, limit: params.limit ?? 20 });
			return json({ count: rows.length, rows });
		}),
	});

	// Дайджест: правила и предпочтения — в каждом прогоне, чтобы не переспрашивать.
	pi.on('before_agent_start', (event) => {
		let digest = '';
		try {
			digest = buildDigest(memory());
		} catch {
			// битая база не должна ронять прогон: работаем без дайджеста
		}
		const systemPrompt = appendDigest(event.systemPrompt, digest);
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	// Границы зоны: понятный отказ вместо EACCES. Настоящая граница — права ОС.
	pi.on('tool_call', (event) => {
		const reason = blockedReason(event.toolName, event.input);
		if (reason) return { block: true, reason };
		const path = event.input?.path ?? event.input?.file_path ?? event.input?.file;
		if (path && /^(edit|write)$/i.test(String(event.toolName))) {
			try {
				backupRules(path);
			} catch {
				// копия — удобство отката, а не условие правки
			}
		}
		return undefined;
	});

	// Значок в нижней панели pi: видно, что память подключена и чья это зона.
	pi.on('session_start', (event, ctx) => {
		const role = admin ? 'админ' : 'личная';
		ctx?.ui?.setStatus?.('3-dvoretsky', `🧹 ${slug} · память (${role})`);
	});
}
