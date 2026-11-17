import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatCommandsHtml, formatLiveStatus, formatModelsHtml, formatStatusHtml, formatTokens } from '../src/status.js';

const STATE = {
	model: { provider: 'deepseek', id: 'deepseek-flash' },
	thinkingLevel: 'high',
	sessionName: 'моя сессия',
	sessionId: 'aaaa1111-2222-3333-4444-555555555555',
	sessionFile: '/Users/me/.pi/agent/sessions/x.jsonl',
	messageCount: 271,
	pendingMessageCount: 0,
};
const STATS = {
	tokens: { input: 5_000_000, output: 120_000, cacheRead: 4_000_000, cacheWrite: 30_000 },
	cost: 0.4213,
	contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 30 },
};

/** Таблица собрана из правильных тегов и в ячейках только инлайн-разметка. */
function assertTable(html, headers) {
	assert.match(html, /<table bordered striped compact>/);
	for (const header of headers) assert.ok(html.includes(`<th>${header}</th>`), `нет колонки ${header}`);
	const cells = [...html.matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)].map((match) => match[1]);
	assert.ok(cells.length >= headers.length);
	for (const cell of cells) assert.equal(/<(?!\/?code>|b>|\/b>|i>|\/i>|s>|\/s>|a |>)/.test(cell), false, `в ячейке лишний тег: ${cell}`);
	assert.equal(/\n/.test(html.split('<table')[1].split('</table>')[0]), false, 'переносов строк внутри таблицы нет');
}

test('живая строка: скиллы, токены, контекст, стоимость, баланс — в этом порядке', () => {
	const line = formatLiveStatus({
		stats: STATS,
		statuses: [
			['ponytail', '\u001b[38;2;1;2;3m●\u001b[39m 🐴 ponytail'],
			['1-agent-skills', '👾'],
			['2-telegram-bridge', '📡'],
			['usage', 'deepseek USD 8.36'],
		],
	});
	assert.equal(line, '👾 📡 🐴 · ↑5.0M ↓120k · 30% из 200k · $0.421 · USD 8.36');
});

test('живая строка растёт: чего нет — того и нет, без прочерков и ANSI', () => {
	assert.equal(formatLiveStatus({}), '');
	assert.equal(formatLiveStatus({ statuses: [['ponytail', '🐴']] }), '🐴');
	assert.equal(formatLiveStatus({ stats: { tokens: {}, cost: 0 } }), '$0.000');
	assert.equal(formatLiveStatus({ statuses: [['usage', 'deepseek USD 8.36']] }), 'USD 8.36');
});

test('статус — таблица с моделью, токенами и контекстом', () => {
	const html = formatStatusHtml({ state: STATE, stats: STATS, queue: 1, busy: true, processes: 2, cwd: '/Users/me/p' });
	assertTable(html, ['Параметр', 'Значение']);
	assert.match(html, /<td>Модель<\/td><td><code>deepseek\/deepseek-flash<\/code><\/td>/);
	assert.match(html, /<td>Размышления<\/td><td>high<\/td>/);
	assert.match(html, /<td>Токены<\/td><td>↑5\.0M ↓120k · R4\.0M W30k<\/td>/);
	assert.match(html, /<td>Стоимость<\/td><td>\$0\.421<\/td>/);
	assert.match(html, /<td>Контекст<\/td><td>30% из 200k<\/td>/);
	assert.match(html, /<td>Очередь<\/td><td>1 · идёт прогон<\/td>/);
	assert.match(html, /<td>Процессов pi<\/td><td>2<\/td>/);
	// пути — под таблицей: в ячейке они раздувают правый столбец и жмут левый
	assert.match(html, /\n📁 <code>\/Users\/me\/p<\/code>/);
	assert.match(html, /\n🗂 <code>\/Users\/me\/\.pi\/agent\/sessions\/x\.jsonl<\/code>/);
	assert.equal(/<td>[^<]*\/Users/.test(html), false, 'в ячейках нет длинных путей');
});

test('ячейки таблицы короткие: длинная ячейка ломает столбцы в Telegram', () => {
	const html = formatStatusHtml({
		state: { ...STATE, sessionName: 'очень длинное имя сессии для проверки ширины столбцов' },
		stats: STATS,
		queue: 3,
		busy: true,
		processes: 4,
		cwd: '/Users/me/p',
		statuses: [['usage', 'deepseek USD 8.36']],
	});
	const cells = [...html.split('<table')[1].split('</table>')[0].matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)].map(
		(match) => match[1].replace(/<[^>]+>/g, ''),
	);
	const longest = cells.reduce((a, b) => (b.length > a.length ? b : a), '');
	assert.ok(longest.length <= 30, `слишком длинная ячейка (${longest.length}): ${longest}`);
});

test('статус без модели и статистики не ломается', () => {
	const html = formatStatusHtml({ state: { sessionId: 'x' } });
	assertTable(html, ['Параметр', 'Значение']);
	assert.match(html, /<td>Сессия<\/td>/);
	assert.ok(!html.includes('Токены'));
});

test('статус показывает включённые скиллы значками и баланс из статуса pi-usage', () => {
	const html = formatStatusHtml({
		state: STATE,
		stats: STATS,
		statuses: [
			['1-agent-skills', '👾'],
			['2-telegram-bridge', '📡'],
			['ponytail', '\u001b[38;2;1;2;3m●\u001b[39m 🐴 ponytail: ⚡ FULL'],
			['usage', 'deepseek USD 8.36'],
		],
	});
	assertTable(html, ['Параметр', 'Значение']);
	assert.match(html, /<td>Скиллы<\/td><td>👾 📡 🐴<\/td>/);
	assert.match(html, /<td>Баланс API<\/td><td>deepseek USD 8\.36<\/td>/);
	assert.equal(html.includes('\u001b'), false, 'ANSI-коды чужих статусов вырезаны');
});

test('выключенное расширение значок не рисует; без статусов — прочерки', () => {
	const off = formatStatusHtml({ state: STATE, statuses: [['1-agent-skills', '👾'], ['ponytail', undefined]] });
	assert.match(off, /<td>Скиллы<\/td><td>👾<\/td>/);
	const empty = formatStatusHtml({ state: STATE });
	assert.match(empty, /<td>Скиллы<\/td><td>—<\/td>/);
	assert.match(empty, /<td>Баланс API<\/td><td>—<\/td>/);
});

test('спецсимволы в данных экранируются', () => {
	const html = formatStatusHtml({
		state: { ...STATE, sessionName: '<b>зло</b> & "кавычки"' },
		cwd: '/tmp/<script>',
		statuses: [['usage', '<b>0</b>']],
	});
	assert.ok(html.includes('&lt;b&gt;зло&lt;/b&gt; &amp;'));
	assert.ok(html.includes('/tmp/&lt;script&gt;'));
	assert.ok(html.includes('&lt;b&gt;0&lt;/b&gt;'));
});

test('модели — таблица с контекстом и рассуждениями', () => {
	const html = formatModelsHtml([
		{ provider: 'deepseek', id: 'deepseek-flash', contextWindow: 200_000, reasoning: true },
		{ provider: 'openai', id: 'gpt-4o', contextWindow: 128_000, reasoning: false },
	]);
	assertTable(html, ['Модель', 'Контекст', 'Рассуждения']);
	assert.match(html, /<td><code>deepseek\/deepseek-flash<\/code><\/td><td>200k<\/td><td>да<\/td>/);
	assert.match(html, /<td><code>openai\/gpt-4o<\/code><\/td><td>128k<\/td><td>—<\/td>/);
});

test('команды pi — таблица', () => {
	const html = formatCommandsHtml([{ name: 'goal', description: 'Цели <важно>', source: 'extension' }]);
	assertTable(html, ['Команда', 'Что делает', 'Источник']);
	assert.match(html, /<td><code>\/goal<\/code><\/td><td>Цели &lt;важно&gt;<\/td><td>extension<\/td>/);
});

test('formatTokens округляет как в статусе', () => {
	assert.equal(formatTokens(0), '0');
	assert.equal(formatTokens(999), '999');
	assert.equal(formatTokens(1500), '1.5k');
	assert.equal(formatTokens(120_000), '120k');
	assert.equal(formatTokens(5_000_000), '5.0M');
	assert.equal(formatTokens(undefined), '0');
});
