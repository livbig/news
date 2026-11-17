import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	ASSISTANT_MENU_KEYBOARD,
	ASSISTANT_MENU_TEXT,
	formatEstimateSummary,
	formatMoney,
	formatObjectCard,
	formatProjectsPage,
	formatVersions,
	latestEstimate,
} from '../src/assistant.js';

const ESTIMATES = [
	{ id: 50, object_id: 12, branch: 'main', seq: 1, status: 'draft', total: 340306.15 },
	{ id: 51, object_id: 12, branch: 'budget', seq: 1, status: 'draft', total: 326978 },
	{ id: 52, object_id: 12, branch: 'optimal', seq: 1, status: 'draft', total: 389740 },
];

const OBJECT = {
	id: 12,
	label: 'Аман склады Любучанск',
	type: 'склад',
	status: 'active',
	active_estimate_id: 52,
	estimates: ESTIMATES,
};

const ESTIMATE = {
	id: 51,
	object: { id: 12, label: 'Аман склады Любучанск', type: 'склад' },
	client: 'Аман',
	branch: 'budget',
	seq: 1,
	status: 'draft',
	total: 326978,
	rows: [
		{ sku: 'A-1', name: 'Шлагбаум', unit: 'шт', qty: 2, price: 1500, sum: 3000 },
		{ sku: 'A-2', name: 'Привод', unit: 'шт', qty: 1, price: 323978, sum: 323978 },
	],
	meta: { discountPct: 5 },
};

test('меню: четыре кнопки с эмодзи и понятными callback-ами', () => {
	assert.equal(ASSISTANT_MENU_TEXT, 'Чем помочь?');
	const buttons = ASSISTANT_MENU_KEYBOARD.flat();
	assert.deepEqual(
		buttons.map((button) => button.text),
		['📁 Проекты', '🆕 Новая смета', '🧾 Клиенты', '❓ Помощь'],
	);
	assert.deepEqual(
		buttons.map((button) => button.callback_data),
		['menu:projects', 'menu:new', 'menu:clients', 'menu:help'],
	);
});

test('проекты: по 8 на страницу, эмодзи типа, число смет и пагинация', () => {
	const projects = Array.from({ length: 10 }, (_, index) => ({
		id: index + 1,
		label: `Объект ${index + 1}`,
		type: index === 0 ? 'склад' : index === 1 ? 'офис' : index === 2 ? 'дом' : 'другое',
		estimates: index === 0 ? ESTIMATES : [],
	}));

	const first = formatProjectsPage(projects, 0);
	const firstButtons = first.keyboard.flat();
	assert.equal(firstButtons.length, 10, '8 объектов + ➡️ + «Показать архив»');
	assert.equal(firstButtons[0].text, '🏬 Объект 1 · 3 сметы');
	assert.equal(firstButtons[1].text, '🏢 Объект 2 · 0 смет');
	assert.equal(firstButtons[2].text, '🏠 Объект 3 · 0 смет');
	assert.equal(firstButtons[3].text, '📍 Объект 4 · 0 смет');
	assert.equal(firstButtons[0].callback_data, 'obj:1:0');
	assert.equal(firstButtons[8].text, '➡️');
	assert.equal(firstButtons[8].callback_data, 'proj:1');
	assert.equal(firstButtons[9].text, '🗄 Показать архив (0)', 'архив — отдельный режим, по умолчанию пусто');
	assert.equal(firstButtons[9].callback_data, 'proj:0:archive');
	assert.match(first.text, /страница 1\/2/);

	const second = formatProjectsPage(projects, 1);
	const secondButtons = second.keyboard.flat();
	assert.equal(secondButtons.length, 4, '2 объекта + ⬅️ + «Показать архив»');
	assert.equal(secondButtons.at(-2).text, '⬅️');
	assert.equal(secondButtons.at(-2).callback_data, 'proj:0');
	assert.match(second.text, /страница 2\/2/);
	assert.ok(!secondButtons.some((button) => button.text === '➡️'));
});

test('проекты: одна страница — без стрелок, пустой список — честный текст', () => {
	const one = formatProjectsPage([OBJECT], 5);
	assert.equal(one.keyboard.flat().length, 2);
	assert.equal(one.keyboard.flat()[0].callback_data, 'obj:12:0', 'номер страницы не уезжает за границу');

	const empty = formatProjectsPage([], 0);
	assert.equal(empty.keyboard.length, 1, 'из пустого списка всё равно можно посмотреть архив');
	assert.match(empty.text, /Пока нет объектов/);
});

test('архив: отдельный список, число в кнопке и возврат в текущие', () => {
	const archived = { ...OBJECT, id: 6, status: 'archived', estimates: [] };
	const view = formatProjectsPage([archived], 0, { archived: true, archivedCount: 1 });
	assert.match(view.text, /🗄 <b>Архив<\/b>/);
	assert.deepEqual(
		view.keyboard.flat().map((button) => button.text),
		['🏬 Аман склады Любучанск · 0 смет', '📁 Скрыть архив'],
	);
	assert.equal(view.keyboard.flat()[1].callback_data, 'proj:0:active');

	const current = formatProjectsPage([OBJECT], 0, { archivedCount: 1 });
	assert.equal(current.keyboard.flat().at(-1).text, '🗄 Показать архив (1)');

	const emptyArchive = formatProjectsPage([], 0, { archived: true });
	assert.match(emptyArchive.text, /Архив пуст/);
});

test('карточка объекта: заказчик, последняя версия и итог, кнопки версий/PDF/назад', () => {
	const view = formatObjectCard(OBJECT, { client: 'Аман' }, 2);
	assert.match(view.text, /🏬 <b>Аман склады Любучанск<\/b>/);
	assert.match(view.text, /Заказчик: Аман/);
	assert.match(view.text, new RegExp(`Последняя версия: ⚖️ optimal v1 · ${formatMoney(389740)} · draft`));

	const buttons = view.keyboard.flat();
	assert.deepEqual(
		buttons.map((button) => button.text),
		['📄 Версии', '⬇️ PDF последней', '🗄 В архив', '⬅️ Назад'],
	);
	assert.deepEqual(
		buttons.map((button) => button.callback_data),
		['vers:12:2', 'pdf:52', 'arch:12:2:archive', 'proj:2'],
	);
	assert.equal(latestEstimate(OBJECT).id, 52);
});

test('карточка архивного объекта: видно, что он в архиве, и есть кнопка возврата', () => {
	const view = formatObjectCard({ ...OBJECT, status: 'archived' }, { client: 'Аман' }, 0);
	assert.match(view.text, /· 🗄 в архиве/);
	const archiveButton = view.keyboard.flat().find((button) => button.callback_data.startsWith('arch:'));
	assert.equal(archiveButton.text, '↩️ Вернуть из архива');
	assert.equal(archiveButton.callback_data, 'arch:12:0:active');
});

test('версии: кнопки с эмодзи ветки, итогом и статусом', () => {
	const view = formatVersions(OBJECT, 1);
	const buttons = view.keyboard.flat();
	assert.equal(buttons.length, 4, '3 версии + назад');
	assert.deepEqual(
		buttons.slice(0, 3).map((button) => button.text),
		[
			`📋 main v1 · ${formatMoney(340306.15)} · draft`,
			`💵 budget v1 · ${formatMoney(326978)} · draft`,
			`⚖️ optimal v1 · ${formatMoney(389740)} · draft`,
		],
	);
	assert.deepEqual(
		buttons.slice(0, 3).map((button) => button.callback_data),
		['est:50:12:1', 'est:51:12:1', 'est:52:12:1'],
	);
	assert.equal(buttons[3].callback_data, 'obj:12:1');
});

test('сводка сметы: строки кратко, итог, скидка 5 % и к оплате; PDF и назад', () => {
	const view = formatEstimateSummary(ESTIMATE, 1);
	assert.match(view.text, /💵 <b>budget v1<\/b> · draft/);
	assert.match(view.text, /Заказчик: Аман/);
	assert.match(view.text, /• Шлагбаум — 2 шт × 1 500 ₽ = 3 000 ₽/);
	assert.match(view.text, new RegExp(`Итого: <b>${formatMoney(326978)}</b>`));
	assert.match(view.text, /Скидка 5 % за наличные: −/);
	assert.match(view.text, new RegExp(`К оплате: <b>${formatMoney(310629.1)}</b>`));

	const buttons = view.keyboard.flat();
	assert.equal(buttons[0].text, '⬇️ PDF');
	assert.equal(buttons[0].callback_data, 'pdf:51');
	assert.equal(buttons[1].text, '⬅️ Назад');
	assert.equal(buttons[1].callback_data, 'vers:12:1');
});

test('сводка сметы: длинный список позиций обрезается с остатком', () => {
	const rows = Array.from({ length: 12 }, (_, index) => ({
		name: `Позиция ${index + 1}`,
		unit: 'шт',
		qty: 1,
		price: 100,
		sum: 100,
	}));
	const view = formatEstimateSummary({ ...ESTIMATE, rows, total: 1200, meta: {} });
	assert.match(view.text, /… ещё 2 позиции/);
	assert.match(view.text, /Скидка 5 %/);
});

test('тексты экранируют HTML из данных API', () => {
	const view = formatObjectCard({ ...OBJECT, label: 'Склад <b>и & ко' }, { client: '<Аман>' }, 0);
	assert.match(view.text, /Склад &lt;b&gt;и &amp; ко/);
	assert.match(view.text, /Заказчик: &lt;Аман&gt;/);
});
