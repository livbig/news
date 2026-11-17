/**
 * Форматирование ответов команд. Отдельный модуль, потому что это чистая функция:
 * одна и та же строка уходит в чат и проверяется в тестах.
 *
 * Разметка — rich HTML (docs: `InputRichMessage.html`, синтаксис в @grammyjs/types/rich.d.ts):
 * поддерживаются `<table bordered striped compact>`, `<caption>`, `<tr><th>/<td>`, `<code>`, `<b>`.
 * В ячейках таблицы допустима только инлайн-разметка, поэтому переносов строк там нет.
 */

import { escapeHtml } from './markdown.js';

export function formatTokens(count) {
	const value = Number(count ?? 0);
	if (!Number.isFinite(value) || value <= 0) return '0';
	if (value < 1000) return String(value);
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * Три индикатора, которые владелец хочет видеть в чате: ключ статуса pi → значок.
 * Ключи заданы в самих расширениях (`pi-agent-skills`, `extensions/pi-telegram-bridge.ts`,
 * ponytail) и приходят в мост как `extension_ui_request` method=setStatus (docs/rpc-extension-ui.md).
 * Наличие статуса = расширение включено, поэтому текст не показываем.
 */
export const SKILL_EMOJI = [
	['1-agent-skills', '👾'],
	['2-telegram-bridge', '📡'],
	['ponytail', '🐴'],
];

/** Чужие статусы красят текст ANSI-кодами (ponytail, pi-usage) — в таблице они лишние. */
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text) {
	return String(text ?? '').replace(ANSI, '');
}

function table(headers, rows, { caption } = {}) {
	const head = headers.map((cell) => `<th>${cell}</th>`).join('');
	const body = rows
		.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
		.join('');
	const title = caption ? `<caption>${escapeHtml(caption)}</caption>` : '';
	return `<table bordered striped compact>${title}<tr>${head}</tr>${body}</table>`;
}

/**
 * Живая строка над ответом: скиллы, токены, контекст, стоимость, баланс — тот же порядок,
 * что и в `/status`, но без обвязки. Пустые части выпадают, поэтому строка растёт по мере хода.
 */
export function formatLiveStatus({ stats, statuses = [] } = {}) {
	const parts = [];
	const on = (key) => statuses.some(([k, value]) => k === key && value);
	const skills = SKILL_EMOJI.filter(([key]) => on(key)).map(([, emoji]) => emoji);
	if (skills.length) parts.push(skills.join(' '));
	const tokens = stats?.tokens ?? {};
	if (tokens.input || tokens.output) parts.push(`↑${formatTokens(tokens.input)}${tokens.output ? ` ↓${formatTokens(tokens.output)}` : ''}`);
	const usage = stats?.contextUsage;
	if (usage?.contextWindow) {
		const percent = usage.percent === null || usage.percent === undefined ? '?' : `${Math.round(usage.percent)}%`;
		parts.push(`${percent} из ${formatTokens(usage.contextWindow)}`);
	}
	if (typeof stats?.cost === 'number') parts.push(`$${stats.cost.toFixed(3)}`);
	const balance = statuses.find(([key]) => key === 'usage')?.[1];
	// «deepseek USD 8.36» → «USD 8.36»: провайдер и так ясен из модели
	if (balance) parts.push(stripAnsi(balance).replace(/[*_`~]/g, '').trim().replace(/^deepseek\s+/i, ''));
	return parts.join(' · ');
}

/**
 * `/status` — таблица «параметр → значение». `statuses` — пары [ключ, текст] из setStatus
 * дочернего pi (см. SKILL_EMOJI); оттуда же берётся баланс: pi-usage держит его в статусе `usage`.
 */
export function formatStatusHtml({ state, stats, queue = 0, busy = false, processes = 0, cwd, statuses = [] } = {}) {
	const rows = [];
	const on = (key) => statuses.some(([k, value]) => k === key && value);
	const skills = SKILL_EMOJI.filter(([key]) => on(key)).map(([, emoji]) => emoji);
	rows.push(['Скиллы', skills.length ? skills.join(' ') : '—']);
	// Значения держим короткими: длинная ячейка раздувает правый столбец и ломает левый
	// (ширины столбцов Telegram считает сам, `width` у ячеек нет). Пути — под таблицей.
	if (state?.model) {
		rows.push(['Модель', `<code>${escapeHtml(String(state.model.provider))}/${escapeHtml(String(state.model.id))}</code>`]);
	}
	if (state?.thinkingLevel) rows.push(['Размышления', escapeHtml(String(state.thinkingLevel))]);
	rows.push(['Сессия', `<code>${escapeHtml(String(state?.sessionId ?? '').slice(0, 8))}</code>`]);
	rows.push([
		'Сообщений',
		`${state?.messageCount ?? 0}${state?.pendingMessageCount ? ` (+${state.pendingMessageCount} внутри pi)` : ''}`,
	]);
	if (stats) {
		const tokens = stats.tokens ?? {};
		rows.push([
			'Токены',
			`↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)} · R${formatTokens(tokens.cacheRead)} W${formatTokens(tokens.cacheWrite)}`,
		]);
		if (typeof stats.cost === 'number') rows.push(['Стоимость', `$${stats.cost.toFixed(3)}`]);
		const usage = stats.contextUsage;
		if (usage?.contextWindow) {
			const percent = usage.percent === null || usage.percent === undefined ? '?' : `${Math.round(usage.percent)}%`;
			rows.push(['Контекст', `${percent} из ${formatTokens(usage.contextWindow)}`]);
		}
	}
	const balance = statuses.find(([key]) => key === 'usage')?.[1];
	rows.push(['Баланс API', balance ? escapeHtml(stripAnsi(balance).trim()) : '—']);
	rows.push(['Очередь', `${queue}${busy ? ' · идёт прогон' : ''}`]);
	rows.push(['Процессов pi', String(processes)]);

	const foot = [];
	if (cwd) foot.push(`📁 <code>${escapeHtml(String(cwd))}</code>`);
	if (state?.sessionFile) foot.push(`🗂 <code>${escapeHtml(String(state.sessionFile))}</code>`);
	const tail = foot.length ? `\n${foot.join('\n')}` : '';
	// Имя сессии — в подписи: оно длинное (часто это первые слова промпта) и в ячейке жмёт столбцы.
	const caption = state?.sessionName ? `pi · ${state.sessionName}` : 'pi · сессия этого чата';
	return `<b>Статус</b>\n${table(['Параметр', 'Значение'], rows, { caption })}${tail}`;
}

/** `/models` — таблица моделей. */
export function formatModelsHtml(models = []) {
	const rows = models.map((model) => [
		`<code>${escapeHtml(`${model.provider}/${model.id}`)}</code>`,
		model.contextWindow ? formatTokens(model.contextWindow) : '—',
		model.reasoning ? 'да' : '—',
	]);
	return `<b>Модели (${models.length})</b>\n${table(['Модель', 'Контекст', 'Рассуждения'], rows)}`;
}

/** `/commands` — таблица команд pi. */
export function formatCommandsHtml(commands = []) {
	const rows = commands.map((command) => [
		`<code>/${escapeHtml(String(command.name))}</code>`,
		escapeHtml(String(command.description ?? '—')),
		escapeHtml(String(command.source ?? '')),
	]);
	return `<b>Команды pi (${commands.length})</b>\n${table(['Команда', 'Что делает', 'Источник'], rows)}`;
}
