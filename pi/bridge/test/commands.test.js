import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	THINKING_LEVELS,
	formatHelp,
	formatUnknownCommand,
	isStopWord,
	parseCommand,
	resolveCommand,
	resolveModelRef,
	rpcCommandFor,
} from '../src/commands.js';

/** Теги, которыми нам разрешено писать собственные сообщения (rich HTML + классический HTML). */
const ALLOWED_TAGS = [
	'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'mark', 'sub', 'sup',
	'a', 'hr', 'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'aside',
	'footer', 'caption', 'table', 'tr', 'th', 'td', 'details', 'summary', 'img', 'video', 'audio',
	'figure', 'figcaption', 'cite', 'br', 'input',
];

/** Любой «<» обязан открывать известный тег: иначе Telegram отвергнет разметку целиком. */
function assertKnownTags(text) {
	for (const match of text.matchAll(/</g)) {
		const rest = text.slice(match.index + 1);
		assert.match(rest, /^\/?[a-zA-Z]/, `сырой «<» в позиции ${match.index}: ${rest.slice(0, 20)}`);
		const name = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)[1].toLowerCase();
		assert.ok(
			ALLOWED_TAGS.includes(name) || name.startsWith('tg-'),
			`неизвестный тег <${name}>`,
		);
	}
}

const MODELS = [
	{ provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
	{ provider: 'anthropic', id: 'claude-haiku-3' },
	{ provider: 'openai', id: 'gpt-4o' },
	{ provider: 'openai', id: 'gpt-4o-mini' },
];

test('разбор команды с аргументами и суффиксом @bot', () => {
	assert.deepEqual(parseCommand('/open  2  '), { name: 'open', args: '2' });
	assert.deepEqual(parseCommand('/model@MyBridgeBot openai/gpt-4o'), { name: 'model', args: 'openai/gpt-4o' });
	assert.equal(parseCommand('просто текст'), null);
	assert.equal(parseCommand('/'), null);
});

test('«stop» словом и /stop — одно и то же', () => {
	assert.equal(isStopWord('stop'), true);
	assert.equal(isStopWord(' STOP '), true);
	assert.equal(isStopWord('стоп'), false);
});

test('маппинг команд чата на действия', () => {
	assert.deepEqual(resolveCommand('menu'), { kind: 'menu' });
	assert.deepEqual(resolveCommand('start'), { kind: 'menu' });
	assert.deepEqual(resolveCommand('restart'), { kind: 'restart' });
	assert.deepEqual(resolveCommand('reload'), { kind: 'restart' });
	assert.deepEqual(resolveCommand('thinking', 'HIGH'), { kind: 'thinking', level: 'high' });
	assert.deepEqual(resolveCommand('model'), { kind: 'models' });
	assert.deepEqual(resolveCommand('model', 'openai/gpt-4o'), { kind: 'model', ref: 'openai/gpt-4o' });
});

test('неизвестная команда уходит в prompt (FR3: команды расширений и шаблонов)', () => {
	assert.deepEqual(resolveCommand('fix-tests', 'src/'), { kind: 'passthrough', command: 'fix-tests', args: 'src/' });
	assert.deepEqual(resolveCommand('skill:ponytail'), { kind: 'passthrough', command: 'skill:ponytail', args: '' });
});

test('встроенные команды pi получают конкретную RPC-команду (docs/rpc-commands.md)', () => {
	assert.equal(rpcCommandFor(resolveCommand('status')).type, 'get_state');
	assert.equal(rpcCommandFor(resolveCommand('model', 'x')).type, 'set_model');
	assert.equal(rpcCommandFor(resolveCommand('models')).type, 'get_available_models');
	assert.equal(rpcCommandFor(resolveCommand('thinking', 'high')).type, 'set_thinking_level');
	assert.equal(rpcCommandFor(resolveCommand('stop')).type, 'abort');
	assert.equal(rpcCommandFor(resolveCommand('restart')), null, 'restart — дело моста, не RPC');
});

test('модель по provider/id, по id и с уровнем thinking', () => {
	assert.deepEqual(resolveModelRef(MODELS, 'openai/gpt-4o'), { provider: 'openai', modelId: 'gpt-4o', thinkingLevel: undefined });
	assert.deepEqual(resolveModelRef(MODELS, 'gpt-4o-mini'), { provider: 'openai', modelId: 'gpt-4o-mini', thinkingLevel: undefined });
	assert.deepEqual(resolveModelRef(MODELS, 'sonnet:high'), {
		provider: 'anthropic',
		modelId: 'claude-sonnet-4-20250514',
		thinkingLevel: 'high',
	});
});

test('неоднозначная и несуществующая модель — понятная ошибка со списком', () => {
	const ambiguous = resolveModelRef(MODELS, 'claude');
	assert.equal(ambiguous.error, 'модель «claude» есть у нескольких провайдеров, уточните provider/id');
	assert.equal(ambiguous.candidates.length, 2);

	const missing = resolveModelRef(MODELS, 'gemini-2');
	assert.ok(missing.error.includes('не найдена'));
	assert.deepEqual(missing.candidates, []);
});

test('каждый уровень thinking из pi проходит валидацию', () => {
	for (const level of THINKING_LEVELS) {
		assert.deepEqual(resolveCommand('thinking', level), { kind: 'thinking', level });
	}
});

test('справка и подсказка по неизвестной команде', () => {
	const help = formatHelp();
	for (const name of ['/restart', '/status', '/stop', '/help']) assert.ok(help.includes(name));
	assert.ok(!help.includes('/sessions'), 'список сессий из справки убран');
	// Регрессия: «<off|minimal|…>» в справке ломало HTML, и Telegram показывал теги текстом.
	assertKnownTags(help);
	assert.match(help, /<table bordered striped compact>/, 'справка — таблица');
	assert.match(help, /<tr><td><code>\/restart<\/code><\/td><td>/, 'команда в левой колонке');

	const unknown = formatUnknownCommand('modl', ['model', 'models', 'commands']);
	assert.ok(unknown.includes('/modl'));
	assert.ok(unknown.includes('Похожие: /model, /models'));
	assert.equal(formatUnknownCommand('zzz', []).includes('Похожие'), false);
});

test('команды меню и сессий: /sessions, /open, /continue, /new, /name', () => {
	assert.deepEqual(resolveCommand('sessions'), { kind: 'sessions' });
	assert.deepEqual(resolveCommand('open'), { kind: 'open', query: '' });
	assert.deepEqual(resolveCommand('open', '01a1cbfe'), { kind: 'open', query: '01a1cbfe' });
	assert.deepEqual(resolveCommand('continue'), { kind: 'continue' });
	assert.deepEqual(resolveCommand('new'), { kind: 'new' });
	assert.deepEqual(resolveCommand('name'), { kind: 'name', name: '' });
	assert.deepEqual(resolveCommand('name', 'склад'), { kind: 'name', name: 'склад' });
});
