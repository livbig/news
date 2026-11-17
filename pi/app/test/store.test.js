import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendDigest, buildDigest, forget, normalizeText, openMemory, recall, remember } from '../src/memory/store.js';

const fresh = () => openMemory(':memory:');

test('запись: повтор обновляет строку, дублей нет', () => {
	const db = fresh();
	const first = remember(db, { text: 'Люблю чай с молоком', by: 'livbig' });
	const again = remember(db, { text: 'люблю   чай с молоком..', by: 'livbig' });
	assert.equal(first.updated, false);
	assert.equal(again.updated, true);
	assert.equal(again.id, first.id);
	const rows = recall(db, '', 10);
	assert.equal(rows.length, 1);
});

test('вид записи влияет на ключ: факт и правило могут совпадать текстом', () => {
	const db = fresh();
	remember(db, { kind: 'fact', text: 'встаю в 7' });
	remember(db, { kind: 'preference', text: 'встаю в 7' });
	assert.equal(recall(db, '', 10).length, 2);
});

test('поиск: все слова должны найтись, регистр не важен', () => {
	const db = fresh();
	remember(db, { text: 'Аллергия на пенициллин', tags: 'здоровье' });
	remember(db, { text: 'Любимая кофейня на Тверской' });
	assert.equal(recall(db, 'ПЕНИЦИЛЛИН').length, 1);
	assert.equal(recall(db, 'аллергия пенициллин').length, 1);
	assert.equal(recall(db, 'аллергия кофейня').length, 0);
	assert.equal(recall(db, 'кофейня').length, 1);
});

test('забыть: мягкое удаление, поиск и дайджест больше не видят', () => {
	const db = fresh();
	const row = remember(db, { kind: 'rule', text: 'не звонить до 10' });
	assert.equal(forget(db, row.id).found, true);
	assert.equal(recall(db, 'звонить').length, 0);
	assert.equal(buildDigest(db), '');
	assert.equal(forget(db, row.id).found, false, 'второй раз — уже нет');
});

test('дайджест: правила и предпочтения отдельно от фактов, длина ограничена', () => {
	const db = fresh();
	remember(db, { kind: 'rule', text: 'отвечай коротко' });
	remember(db, { kind: 'preference', text: 'без сахара' });
	remember(db, { kind: 'fact', text: 'день рождения Алины 12 мая' });
	const digest = buildDigest(db);
	assert.match(digest, /Правила и предпочтения:/);
	assert.match(digest, /Что помню:/);
	assert.match(digest, /12 мая/);
	const short = buildDigest(db, { maxChars: 50 });
	assert.equal(short.length, 50);
	assert.match(short, /…$/);
});

test('дайджест в промпт: не дублируется', () => {
	const db = fresh();
	remember(db, { kind: 'rule', text: 'пиши по-русски' });
	const prompt = appendDigest('Ты Дворецкий.', buildDigest(db));
	assert.match(prompt, /Ты Дворецкий\./);
	assert.match(prompt, /пиши по-русски/);
	assert.equal(appendDigest(prompt, buildDigest(db)), prompt);
	assert.equal(appendDigest('x', ''), 'x');
});

test('пустой текст и неизвестный вид — ошибка, а не мусор в базе', () => {
	const db = fresh();
	assert.throws(() => remember(db, { text: '   ' }), /пустой/);
	assert.throws(() => remember(db, { text: 'случай', kind: 'слух' }), /вид/);
});

test('нормализация: регистр, кавычки, краевая пунктуация, пробелы', () => {
	assert.equal(normalizeText('  «Привет,   мир!»  '), 'привет, мир');
});
