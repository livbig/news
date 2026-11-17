/**
 * Контекст сообщения для агента (требование владельца 29.10.2026): напоминание приходит туда, где его
 * попросили. Мост кладёт чат, его тип, автора и тему форума в окружение процесса pi (PI_CHAT_*),
 * а этот тест держит контракт имён — на них смотрит `set_reminder` в ассистенте.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contextLine, messageContext, userName } from '../src/context.js';

const GROUP = -1003432441991;

test('группа: чат, тип, автор и имя попадают в окружение', () => {
	const context = messageContext({
		chat: { id: GROUP, type: 'supergroup' },
		from: { id: 710223847, first_name: 'Максим' },
		message: { message_thread_id: 12 },
	});
	assert.deepEqual(context, {
		PI_CHAT_ID: String(GROUP),
		PI_CHAT_TYPE: 'supergroup',
		PI_USER_ID: '710223847',
		PI_USER_NAME: 'Максим',
		PI_THREAD_ID: '12',
	});
});

test('личка: темы нет, ключа PI_THREAD_ID в окружении нет', () => {
	const context = messageContext({ chat: { id: 603522950, type: 'private' }, from: { id: 603522950, first_name: 'Лев' } });
	assert.equal(context.PI_CHAT_TYPE, 'private');
	assert.equal(context.PI_USER_ID, '603522950');
	assert.ok(!('PI_THREAD_ID' in context), 'без темы ключ не ставится: undefined в spawn не уходит');
});

test('имя автора: имя и фамилия, иначе username, иначе id', () => {
	assert.equal(userName({ first_name: 'Максим', last_name: 'Швец', username: 'shvets9o' }), 'Максим Швец');
	assert.equal(userName({ username: 'shvets9o' }), 'shvets9o');
	assert.equal(userName({ id: 42 }), '42');
});

test('деградированный апдейт не роняет контекст', () => {
	assert.deepEqual(messageContext({}), {});
	assert.deepEqual(messageContext(), {});
	assert.equal(contextLine({}), 'чат — · — · — (—)');
});

test('строка для лога: кто, где и в какой теме', () => {
	const context = messageContext({ chat: { id: GROUP, type: 'supergroup' }, from: { id: 710223847, first_name: 'Максим' }, message: { message_thread_id: 12 } });
	assert.equal(contextLine(context), `чат ${GROUP} · supergroup · тема 12 · Максим (710223847)`);
});
