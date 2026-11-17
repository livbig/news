// Пол по глубоким темам: золото, валюта и роботы не должны выпадать из сводки.

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { applySectionFloors } = await import('../src/digest-service.js');

const row = (id, title, extra = {}) => ({ id, title, url: `https://ex.com/${id}`, sourceId: 1, gist: '', ...extra });

test('пол добивает металлы до трёх, не трогая остальное', () => {
  const metals = [row(1, 'Золото дорожает'), row(2, 'Серебро: обзор'), row(3, 'Платина и палладий')];
  const ai = [row(10, 'Новая модель GPT'), row(11, 'Nvidia отчиталась')];
  const selected = [metals[0], ...ai];
  const out = applySectionFloors(selected, [...selected, ...metals.slice(1)]);
  const metalCount = out.filter((item) => /золот|серебр|платин/i.test(item.title)).length;
  assert.equal(metalCount, 3);
  assert.ok(out.some((item) => item.id === 1), 'выбранное не теряется');
});

test('пол ничего не делает, если подходящих пунктов нет', () => {
  const selected = [row(10, 'Новая модель GPT')];
  assert.deepEqual(applySectionFloors(selected, selected), selected);
});

test('пол не берёт уже отправленное и не дублирует выборку', () => {
  const selected = [row(1, 'Золото: разбор')];
  const extra = [row(1, 'Золото: разбор'), row(2, 'Золото: утро'), row(3, 'Золото: вечер')];
  const out = applySectionFloors(selected, [...selected, ...extra], {
    consumedUrls: new Set(['https://ex.com/2']),
  });
  assert.deepEqual(out.map((item) => item.id), [1, 3]);
});

test('роботы и валюта тоже получают свой пол', () => {
  const rows = [
    row(20, 'Гуманоид нового поколения за $20 000'),
    row(21, 'Робот-сортировщик на складе'),
    row(22, 'Курс рубля к доллару: прогноз'),
  ];
  const out = applySectionFloors([], rows);
  assert.equal(out.filter((item) => /робот|гуманоид/i.test(item.title)).length, 2);
  assert.equal(out.filter((item) => /рубл|доллар/i.test(item.title)).length, 1);
});

test('китайские заголовки тоже считаются роботами', () => {
  const rows = [row(30, '人形机器人价格大跳水'), row(31, '全自动机器人咖啡师'), row(32, '中国机器人企业融资')];
  const out = applySectionFloors([], rows);
  assert.equal(out.length, 3);
});

test('добавка ограничена восемью пунктами', () => {
  const rows = Array.from({ length: 20 }, (_, index) => row(index + 100, `Золото: новость ${index}`));
  const out = applySectionFloors([], rows);
  assert.equal(out.length, 3, 'металлам нужно три, лишнего не берём');
});
