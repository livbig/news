// Промпт сводки: профиль, нумерованный порядок разделов и требование «воздуха».

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { DEFAULT_INTERESTS, SECTIONS, SECTION_ORDER, digestPrompt, sectionList } = await import('../src/prompts.js');

test('порядок разделов — перестановка всех номеров', () => {
  const numbers = [...SECTION_ORDER].sort((a, b) => a - b);
  assert.deepEqual(numbers, SECTIONS.map((_, index) => index + 1));
  assert.equal(new Set(SECTIONS.map((row) => row.key)).size, SECTIONS.length);
  for (const row of SECTIONS) {
    assert.ok(row.emoji && row.title, `раздел ${row.key}`);
  }
});

test('sectionList: нумерация по порядку владельца и глубина раздела', () => {
  const list = sectionList([5, 1]);
  assert.match(list, /^1\. 🦾 PHYSICAL AI\/РОБОТОТЕХНИКА — полноценно/);
  assert.match(list, /\n  2\. 🥇 ДРАГМЕТАЛЛЫ\/СЫРЬЁ — полноценно/);
  assert.equal(sectionList([99]), '', 'несуществующий номер пропускается');
});

test('порядок владельца: сначала полноценно, потом коротко, в конце прочее', () => {
  const list = sectionList();
  assert.match(list, /^1\. 🌍 ГЕОПОЛИТИКА — полноценно/);
  assert.match(list, /2\. 🥇 ДРАГМЕТАЛЛЫ\/СЫРЬЁ — полноценно/);
  assert.match(list, /3\. 💵 ВАЛЮТЫ \(только USD\/RUB/);
  assert.match(list, /4\. 📈 РЫНОК США/);
  assert.match(list, /5\. 🤖 AI-МОДЕЛИ/);
  assert.match(list, /6\. 🦾 PHYSICAL AI/);
  assert.match(list, /8\. 🏦 МАКРО\/ЦБ — полноценно/);
  assert.match(list, /9\. 🚀 IPO\/БИОТЕХ — коротко/);
  assert.match(list, /10\. 💡 ИНВЕСТ-ИДЕИ\/ФОРУМЫ — коротко/);
  assert.match(list, /11\. ₿ КРИПТА — коротко/);
  assert.match(list, /12\. 🛠 ПРОЧЕЕ — полноценно/);
  assert.match(list, /ВАЛЮТЫ \(только USD\/RUB/);
  assert.equal(SECTION_ORDER.length, SECTIONS.length);
});

test('digestPrompt: профиль и список разделов подставлены, плейсхолдеров не осталось', () => {
  const prompt = digestPrompt('золото, роботы');
  assert.match(prompt, /золото, роботы/);
  assert.doesNotMatch(prompt, /\{INTERESTS_PROFILE\}|\{SECTIONS\}/);
  assert.match(prompt, /1\. 🌍 ГЕОПОЛИТИКА/);
  assert.match(prompt, /только USD\/RUB/);
  assert.match(prompt, /ВОЗДУХ/);
  assert.match(prompt, /коротко/);
  assert.match(prompt, /пустая строка/);
});

test('digestPrompt: свой порядок меняет список, пустой профиль — профиль по умолчанию', () => {
  const prompt = digestPrompt('   ', [9, 3]);
  assert.match(prompt, /1\. ⚡ ЭНЕРГИЯ — полноценно[\s\S]*2\. 📈 РЫНОК США/);
  assert.match(prompt, new RegExp(DEFAULT_INTERESTS.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('формат пункта: ссылка-эмодзи стоит в начале, а не в конце', () => {
  const prompt = digestPrompt('золото');
  assert.match(prompt, /<a href="URL">ЭМОДЗИ<\/a> <b>Суть новости<\/b>/);
  assert.doesNotMatch(prompt, /нейро-вывод\. <a href="URL">/);
  assert.match(prompt, /в конце пункта ссылок нет/);
});
