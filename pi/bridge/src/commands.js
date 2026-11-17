/**
 * Разбор команд чата и их маппинг на RPC pi (FR3).
 *
 * Почему маппинг вообще нужен: docs/rpc-commands.md#get_commands — «Built-in TUI commands
 * (/settings, /hotkeys, etc.) are not included», т.е. встроенные слэш-команды pi снаружи
 * недоступны, и мост обязан реализовать их поверх конкретных RPC-команд.
 * Всё, что приходит из get_commands (расширения, шаблоны, /skill:...), уходит как есть в prompt.
 */

import { escapeHtml } from './markdown.js';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const TRUTHY = new Set(['stop', 'abort']);

/** Команды чата для /help. args — подсказка по аргументам. */
export const BRIDGE_COMMANDS = [
	{ name: 'restart', description: 'перезапустить сессию, если бот завис' },
	{ name: 'status', description: 'модель, контекст, очередь' },
	{ name: 'stop', description: 'прервать текущий прогон' },
	{ name: 'help', description: 'эта справка' },
];

/** true, если текст — команда чата «stop» словом без слэша. */
export function isStopWord(text) {
	return TRUTHY.has(String(text ?? '').trim().toLowerCase());
}

/** '/model openai/gpt-4o' → { name: 'model', args: 'openai/gpt-4o' }; иначе null. */
export function parseCommand(text) {
	const trimmed = String(text ?? '').trim();
	if (!trimmed.startsWith('/')) return null;
	const match = /^\/([A-Za-z0-9:_-]+)(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/.exec(trimmed);
	if (!match) return null;
	return { name: match[1].toLowerCase(), args: match[2].trim() };
}

/**
 * Команда чата → действие. Чистая функция: то, что в тестах, — то и в бою.
 * kind: sessions|continue|open|new|status|stop|help|name|models|model|thinking|compact|
 *       commands|chatid|menu|passthrough
 */
export function resolveCommand(name, args = '') {
	const arg = String(args ?? '').trim();
	switch (String(name ?? '').toLowerCase()) {
		case 'menu':
			return { kind: 'menu' };
		case 'admin':
			return { kind: 'admin', args: arg };
		case 'restart':
		case 'reload':
			return { kind: 'restart' };
		case 'status':
		case 'session':
			return { kind: 'status' };
		case 'stop':
		case 'abort':
			return { kind: 'stop' };
		case 'help':
			return { kind: 'help' };
		case 'start':
			return { kind: 'menu' };
		case 'chatid':
		case 'whoami':
			return { kind: 'chatid' };
		case 'sessions':
			return { kind: 'sessions' };
		case 'continue':
			return { kind: 'continue' };
		case 'open':
			return { kind: 'open', query: arg };
		case 'new':
			return { kind: 'new' };
		case 'name':
			return { kind: 'name', name: arg };
		case 'model':
		case 'models':
			return arg ? { kind: 'model', ref: arg } : { kind: 'models' };
		case 'thinking':
		case 'think':
			return { kind: 'thinking', level: arg.toLowerCase() };
		case 'commands':
			return { kind: 'commands' };
		default:
			return { kind: 'passthrough', command: String(name ?? '').toLowerCase(), args: arg };
	}
}

/**
 * Соответствие команды чата RPC-команде pi — доказательство FR3 (см. docs/rpc-commands.md).
 * Возвращает null для команд, которые мост выполняет сам из SDK/состояния.
 */
export function rpcCommandFor(action) {
	switch (action?.kind) {
		case 'new':
			return { type: 'new_session' };
		case 'status':
			return { type: 'get_state' };
		case 'models':
			return { type: 'get_available_models' };
		case 'model':
			return { type: 'set_model' };
		case 'thinking':
			return { type: 'set_thinking_level' };
		case 'compact':
			return { type: 'compact' };
		case 'open':
		case 'continue':
			return { type: 'switch_session' };
		case 'stop':
			return { type: 'abort' };
		default:
			return null;
	}
}

/**
 * 'openai/gpt-4o', 'gpt-4o', 'sonnet:high' → { provider, modelId, thinkingLevel }.
 * Модели — как их отдаёт get_available_models: [{ provider, id, ... }].
 */
export function resolveModelRef(models, ref) {
	const list = Array.isArray(models) ? models : [];
	const raw = String(ref ?? '').trim();
	if (!raw) return { error: 'пустая ссылка на модель' };

	let thinkingLevel;
	let rest = raw;
	const colon = raw.lastIndexOf(':');
	if (colon > 0 && THINKING_LEVELS.includes(raw.slice(colon + 1).toLowerCase())) {
		thinkingLevel = raw.slice(colon + 1).toLowerCase();
		rest = raw.slice(0, colon);
	}

	const slash = rest.indexOf('/');
	const provider = slash > 0 ? rest.slice(0, slash).toLowerCase() : undefined;
	const wanted = (slash > 0 ? rest.slice(slash + 1) : rest).toLowerCase();

	if (provider) {
		const pool = list.filter((m) => String(m.provider ?? '').toLowerCase() === provider);
		const exact = pool.find((m) => String(m.id ?? '').toLowerCase() === wanted);
		const fuzzy = exact ? [exact] : pool.filter((m) => String(m.id ?? '').toLowerCase().includes(wanted));
		if (fuzzy.length === 1) return { provider: fuzzy[0].provider, modelId: fuzzy[0].id, thinkingLevel };
		return {
			error: fuzzy.length
				? `под ${provider} неоднозначно: ${fuzzy.length} совпадений`
				: `у провайдера ${provider} нет модели «${wanted}»`,
			candidates: (fuzzy.length ? fuzzy : pool).slice(0, 8),
		};
	}

	const exact = list.filter((m) => String(m.id ?? '').toLowerCase() === wanted);
	const hits = exact.length ? exact : list.filter((m) => String(m.id ?? '').toLowerCase().includes(wanted));
	if (hits.length === 1) return { provider: hits[0].provider, modelId: hits[0].id, thinkingLevel };
	return {
		error: hits.length
			? `модель «${wanted}» есть у нескольких провайдеров, уточните provider/id`
			: `модель «${wanted}» не найдена`,
		candidates: hits.slice(0, 8),
	};
}

export function formatHelp() {
	// Текст справки — обычный текст, экранируем целиком: «<off|…>» в аргументах Telegram иначе
	// примет за начало тега и отвергнет разметку всего сообщения.
	const rows = BRIDGE_COMMANDS.map((command) => {
		const usage = `/${command.name}${command.args ? ` ${command.args}` : ''}`;
		return `<tr><td><code>${escapeHtml(usage)}</code></td><td>${escapeHtml(command.description)}</td></tr>`;
	}).join('');
	const hints = [
		'Любой другой текст — промпт в сессию этого чата.',
		'Команды pi из /commands (расширения, шаблоны, /skill:…) запускаются как есть.',
		'/restart гасит зависший процесс pi; следующий запрос поднимется на той же сессии.',
		'Голосовые сообщения распознаются; фото и документы (pdf, docx, xlsx, txt, csv, json, zip) сохраняются в inbox и разбираются инструментами.',
	].map((line) => escapeHtml(line));
	return [
		'<b>pi-telegram-bridge</b>',
		`<table bordered striped compact><tr><th>Команда</th><th>Что делает</th></tr>${rows}</table>`,
		'',
		...hints,
	].join('\n');
}

export function formatUnknownCommand(name, available = []) {
	const suggestions = available
		.filter((candidate) => candidate.toLowerCase().includes(String(name).toLowerCase().slice(0, 3)))
		.slice(0, 5);
	const tail = suggestions.length ? `\nПохожие: ${suggestions.map((s) => `/${s}`).join(', ')}` : '';
	return `Не знаю команду /${name}. /help — список команд, /commands — команды pi.${tail}`;
}
