/**
 * Меню ассистента и навигация по проектам, когда Mini App отключён.
 * Чистые функции: один и тот же текст и клавиатура уходят в Telegram и проверяются тестами.
 */

import { escapeHtml } from './markdown.js';

export const PROJECTS_PAGE_SIZE = 8;
export const ESTIMATE_ROWS_LIMIT = 10;
export const ASSISTANT_MENU_TEXT = 'Чем помочь?';

export const ASSISTANT_MENU_KEYBOARD = [
	[
		{ text: '📁 Проекты', callback_data: 'menu:projects' },
		{ text: '🆕 Новая смета', callback_data: 'menu:new' },
	],
	[
		{ text: '🧾 Клиенты', callback_data: 'menu:clients' },
		{ text: '❓ Помощь', callback_data: 'menu:help' },
	],
];

const OBJECT_EMOJI = { склад: '🏬', офис: '🏢', дом: '🏠' };
const BRANCH_EMOJI = { main: '📋', budget: '💵', optimal: '⚖️' };
const MONEY = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const NUMBER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function formatMoney(value) {
	const number = Number(value);
	return `${MONEY.format(Number.isFinite(number) ? number : 0).replace(/\u00a0/g, ' ')} ₽`;
}

export function latestEstimate(object) {
	const list = Array.isArray(object?.estimates) ? object.estimates : [];
	return list.at(-1);
}

/**
 * Список объектов кнопками, по 8 на страницу; ⬅️/➡️ только когда страниц больше одной.
 * `archived` — показываем архив: тогда внизу кнопка возврата, а не «Показать архив».
 * `archivedCount` — сколько объектов в архиве (N в кнопке).
 */
export function formatProjectsPage(projects = [], page = 0, { archived = false, archivedCount = 0 } = {}) {
	const list = Array.isArray(projects) ? projects : [];
	const pages = Math.max(1, Math.ceil(list.length / PROJECTS_PAGE_SIZE));
	const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
	const shown = list.slice(current * PROJECTS_PAGE_SIZE, (current + 1) * PROJECTS_PAGE_SIZE);

	const keyboard = shown.map((object) => [
		{ text: projectButtonText(object), callback_data: `obj:${object.id}:${current}` },
	]);
	if (pages > 1) {
		const nav = [];
		if (current > 0) nav.push({ text: '⬅️', callback_data: `proj:${current - 1}` });
		if (current < pages - 1) nav.push({ text: '➡️', callback_data: `proj:${current + 1}` });
		keyboard.push(nav);
	}
	keyboard.push([
		archived
			? { text: '📁 Скрыть архив', callback_data: 'proj:0:active' }
			: { text: `🗄 Показать архив (${archivedCount})`, callback_data: 'proj:0:archive' },
	]);

	const lines = [
		`${archived ? '🗄' : '📁'} <b>${archived ? 'Архив' : 'Проекты'}</b>${pages > 1 ? ` · страница ${current + 1}/${pages}` : ''}`,
	];
	if (!list.length) lines.push(archived ? 'Архив пуст.' : 'Пока нет объектов.');
	return { text: lines.join('\n'), keyboard };
}

export function formatObjectCard(object, estimate, page = 0) {
	const last = latestEstimate(object);
	const keyboard = [];
	if (last) {
		keyboard.push([
			{ text: '📄 Версии', callback_data: `vers:${object.id}:${page}` },
			{ text: '⬇️ PDF последней', callback_data: `pdf:${last.id}` },
		]);
	} else {
		keyboard.push([{ text: '📄 Версии', callback_data: `vers:${object.id}:${page}` }]);
	}
	// Архив не удаляет данные: объект остаётся со сметами и возвращается одной кнопкой.
	keyboard.push([
		object?.status === 'archived'
			? { text: '↩️ Вернуть из архива', callback_data: `arch:${object.id}:${page}:active` }
			: { text: '🗄 В архив', callback_data: `arch:${object.id}:${page}:archive` },
	]);
	keyboard.push([{ text: '⬅️ Назад', callback_data: `proj:${page}` }]);

	return {
		text: [
			`${objectEmoji(object.type)} <b>${escapeHtml(object.label || 'Объект')}</b>${object?.status === 'archived' ? ' · 🗄 в архиве' : ''}`,
			`Заказчик: ${escapeHtml(estimate?.client || 'не указан')}`,
			last ? `Последняя версия: ${versionLabel(last)}` : 'Смет ещё нет',
		].join('\n'),
		keyboard,
	};
}

export function formatVersions(object, page = 0) {
	const list = Array.isArray(object?.estimates) ? object.estimates : [];
	const keyboard = list.map((estimate) => [
		{
			text: `${branchEmoji(estimate.branch)} ${estimate.branch ?? 'main'} v${estimate.seq ?? '?'} · ${formatMoney(estimate.total)} · ${estimate.status ?? ''}`,
			callback_data: `est:${estimate.id}:${object.id}:${page}`,
		},
	]);
	keyboard.push([{ text: '⬅️ Назад', callback_data: `obj:${object.id}:${page}` }]);

	const lines = [`📄 <b>Версии</b> · ${escapeHtml(object?.label || 'объект')}`];
	if (!list.length) lines.push('Версий пока нет.');
	return { text: lines.join('\n'), keyboard };
}

/** Сводка версии: строки кратко, итог, скидка 5 % за наличные и итог со скидкой. */
export function formatEstimateSummary(estimate, page = 0) {
	const object = estimate?.object ?? {};
	const rows = Array.isArray(estimate?.rows) ? estimate.rows : [];
	const total = Number(estimate?.total) || 0;
	const rawPct = estimate?.meta?.discountPct;
	const pct = rawPct === undefined || rawPct === null || !Number.isFinite(Number(rawPct)) ? 5 : Number(rawPct);
	const discount = round2((total * pct) / 100);

	const lines = [
		`${objectEmoji(object.type)} <b>${escapeHtml(object.label || 'Смета')}</b>`,
		`${branchEmoji(estimate?.branch)} <b>${escapeHtml(estimate?.branch ?? 'main')} v${escapeHtml(estimate?.seq ?? '?')}</b> · ${escapeHtml(estimate?.status ?? '')}`,
		`Заказчик: ${escapeHtml(estimate?.client || 'не указан')}`,
		'',
	];
	if (rows.length) {
		for (const row of rows.slice(0, ESTIMATE_ROWS_LIMIT)) {
			const unit = row.unit ? ` ${escapeHtml(row.unit)}` : '';
			lines.push(
				`• ${escapeHtml(row.name ?? row.sku ?? 'позиция')} — ${formatQuantity(row.qty)}${unit} × ${formatMoney(row.price)} = ${formatMoney(row.sum)}`,
			);
		}
		if (rows.length > ESTIMATE_ROWS_LIMIT) {
			lines.push(`… ещё ${rows.length - ESTIMATE_ROWS_LIMIT} ${plural(rows.length - ESTIMATE_ROWS_LIMIT, ['позиция', 'позиции', 'позиций'])}`);
		}
	} else {
		lines.push('Позиций в этой версии нет.');
	}
	lines.push(
		'',
		`Итого: <b>${formatMoney(total)}</b>`,
		`Скидка ${formatQuantity(pct)} % за наличные: −${formatMoney(discount)}`,
		`К оплате: <b>${formatMoney(round2(total - discount))}</b>`,
	);

	return {
		text: lines.join('\n'),
		keyboard: [
			[
				{ text: '⬇️ PDF', callback_data: `pdf:${estimate?.id}` },
				{ text: '⬅️ Назад', callback_data: `vers:${object.id}:${page}` },
			],
		],
	};
}

function projectButtonText(object) {
	const count = Array.isArray(object?.estimates) ? object.estimates.length : 0;
	return `${objectEmoji(object?.type)} ${trim(object?.label, 40) || 'объект'} · ${count} ${plural(count, ['смета', 'сметы', 'смет'])}`;
}

function versionLabel(estimate) {
	return `${branchEmoji(estimate.branch)} ${escapeHtml(estimate.branch ?? 'main')} v${escapeHtml(estimate.seq ?? '?')} · ${formatMoney(estimate.total)} · ${escapeHtml(estimate.status ?? '')}`;
}

function objectEmoji(type) {
	return OBJECT_EMOJI[String(type ?? '').toLowerCase()] ?? '📍';
}

function branchEmoji(branch) {
	return BRANCH_EMOJI[String(branch ?? '').toLowerCase()] ?? '📄';
}

function formatQuantity(value) {
	const number = Number(value);
	return NUMBER.format(Number.isFinite(number) ? number : 0).replace(/\u00a0/g, ' ');
}

function plural(count, forms) {
	const value = Math.abs(Number(count) || 0) % 100;
	const last = value % 10;
	if (value > 10 && value < 20) return forms[2];
	if (last > 1 && last < 5) return forms[1];
	if (last === 1) return forms[0];
	return forms[2];
}

function trim(value, limit) {
	const text = String(value ?? '').trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
