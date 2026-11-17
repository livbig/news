// Рубрика «Physical AI и роботы»: курс, промпт, чистка HTML и один прогон без сети и часов.

import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  CURRICULUM,
  COURSE_DAYS,
  factEntry,
  factTask,
  isRoboticsItem,
  itemsBlock,
  nextFactDay,
  parseFactReply,
  renderDailyFact,
  reviewEntryFor,
  runDailyFact,
  sanitizeFactHtml,
} = await import('../src/daily-fact.js');

test('курс: 100 дней подряд, без дыр и повторов темы', () => {
  assert.equal(COURSE_DAYS, 100);
  assert.deepEqual(
    CURRICULUM.map((row) => row.day),
    Array.from({ length: 100 }, (_, index) => index + 1),
  );
  for (const row of CURRICULUM) {
    assert.ok(row.block.trim(), `блок дня ${row.day}`);
    assert.ok(row.topic.trim().length > 10, `тема дня ${row.day}`);
    assert.ok(row.word.trim(), `термин дня ${row.day}`);
    assert.ok(row.practice.trim(), `практика дня ${row.day}`);
  }
  assert.equal(new Set(CURRICULUM.map((row) => row.topic)).size, 100);
  const blocks = new Set(CURRICULUM.map((row) => row.block));
  assert.equal(blocks.size, 7);
  assert.ok(blocks.has('Анатомия') && blocks.has('Восприятие') && blocks.has('Обучение') && blocks.has('Деньги'));
});

test('nextFactDay: прогресс и конец курса', () => {
  assert.equal(nextFactDay(0), 1);
  assert.equal(nextFactDay(1), 2);
  assert.equal(nextFactDay(99), 100);
  assert.equal(nextFactDay(100), null);
  assert.equal(nextFactDay(150), null);
  assert.equal(factEntry(1).day, 1);
  assert.equal(factEntry(101), null);
});

test('isRoboticsItem: роботы на любом из трёх языков', () => {
  assert.equal(isRoboticsItem({ title: 'Serve Robotics открывает API' }), true);
  assert.equal(isRoboticsItem({ title: '机器人价格大跳水' }), true);
  assert.equal(isRoboticsItem({ title: 'Humanoid robot startup raises $300M' }), true);
  assert.equal(isRoboticsItem({ title: 'Gold demand falls 17%' }), false);
  assert.equal(isRoboticsItem({ title: 'Something', gist: 'робот-сортировщик посылок' }), true);
});

test('itemsBlock: только заголовок, ссылка и выжимка, максимум шесть', () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    title: `Робот ${index}`,
    url: `https://example.com/${index}`,
    gist: 'Короткая выжимка',
  }));
  const block = itemsBlock(items);
  assert.equal(block.split('\n').length, 6);
  assert.match(block, /https:\/\/example\.com\/0/);
  assert.doesNotMatch(block, /example\.com\/7/);
});

test('factTask: тема дня и запрет выдумывать новинки без пунктов', () => {
  const entry = factEntry(47);
  const task = factTask({ entry, items: [] });
  assert.match(task.user, /День 47 из 100/);
  assert.match(task.user, /PID/);
  assert.match(task.user, /Новинки рынка» не пиши/);
  assert.match(task.system, /только теги <b>/);
  const withItems = factTask({ entry, items: [{ title: 'X', url: 'https://a.b/c', gist: 'g' }] });
  assert.match(withItems.user, /https:\/\/a\.b\/c/);
});

test('sanitizeFactHtml: markdown в теги, чужие ссылки — в текст', () => {
  const allowed = ['https://a.b/ok'];
  const html = sanitizeFactHtml(
    '**Факт.** Робот <br> умеет.\n<a href="https://a.b/ok">свой</a> и <a href="https://evil.tld/x">чужой</a>\n[метка](https://a.b/ok) [плохая](https://evil.tld/y)',
    allowed,
  );
  assert.match(html, /<b>Факт\.<\/b>/);
  assert.match(html, /<a href="https:\/\/a\.b\/ok">свой<\/a>/);
  assert.match(html, /<a href="https:\/\/a\.b\/ok">метка<\/a>/);
  assert.match(html, /чужой/);
  assert.doesNotMatch(html, /evil\.tld/);
  assert.doesNotMatch(html, /<br>/);
  assert.doesNotMatch(html, /\*/);
});

test('sanitizeFactHtml: лишние теги срезаются', () => {
  const html = sanitizeFactHtml('<b>Факт.</b> <script>alert(1)</script><ul><li>пункт</li></ul><i>курсив</i>', []);
  assert.doesNotMatch(html, /script|ul|li/);
  assert.match(html, /<i>курсив<\/i>/);
});

test('renderDailyFact: шапка с прогрессом, тема и слово дня', () => {
  const text = renderDailyFact({ day: 7, entry: factEntry(7), body: '<b>Факт.</b> текст' });
  assert.match(text, /день 7 из 100/);
  assert.match(text, /Анатомия — Гусеница, колесо и нога/);
  assert.match(text, /Слово дня: шасси/);
  const fallback = renderDailyFact({ day: 7, entry: factEntry(7), body: '', fallback: true });
  assert.match(fallback, /LLM не ответил/);
});

/** Фейковое окружение: состояние в Map, лента и отправка считаются. */
function makeDeps({ items = [], answer = '<b>Факт.</b> Робот умеет ходить.', fail = false } = {}) {
  const state = new Map();
  const sent = [];
  return {
    state,
    sent,
    deps: {
      getState: (key) => state.get(key) ?? null,
      setState: (key, value) => state.set(key, value),
      recentItems: async () => items,
      generate: async () => {
        if (fail) throw new Error('LLM down');
        return answer;
      },
      send: async (chatId, text) => sent.push({ chatId, text }),
      log: () => {},
    },
  };
}

test('runDailyFact: первый день уходит, второй раз за тот же день — нет', async () => {
  const items = [
    { title: 'Робот-сортировщик подешевел', url: 'https://news.example/robot', gist: 'Цена 50 000 юаней' },
    { title: 'Gold prices fall', url: 'https://news.example/gold', gist: 'не про роботов' },
  ];
  const { deps, sent, state } = makeDeps({ items });
  const first = await runDailyFact({ chatId: 5, slotKey: '2026-11-13T12:00', todayKey: '2026-11-13', deps });
  assert.equal(first.sent, true);
  assert.equal(first.day, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /день 1 из 100/);
  assert.equal(state.get('fact_day_done'), '1');
  assert.equal(state.get('factslot:2026-11-13T12:00'), '1');

  const again = await runDailyFact({ chatId: 5, slotKey: '2026-11-13T12:00', todayKey: '2026-11-13', deps });
  assert.equal(again.sent, false);
  assert.equal(sent.length, 1);

  const nextDay = await runDailyFact({ chatId: 5, slotKey: '2026-11-14T12:00', todayKey: '2026-11-14', deps });
  assert.equal(nextDay.day, 2);
  assert.equal(sent.length, 2);
});

test('runDailyFact: повторный тик другого слота в тот же день молчит', async () => {
  const { deps, sent } = makeDeps();
  await runDailyFact({ chatId: 5, slotKey: '2026-11-13T12:00', todayKey: '2026-11-13', deps });
  const second = await runDailyFact({ chatId: 5, slotKey: '2026-11-13T12:30', todayKey: '2026-11-13', deps });
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'date');
  assert.equal(sent.length, 1);
});

test('runDailyFact: LLM молчит — факт всё равно уходит, но честно', async () => {
  const { deps, sent } = makeDeps({ fail: true });
  const result = await runDailyFact({ chatId: 5, slotKey: 'k', todayKey: '2026-11-13', deps });
  assert.equal(result.sent, true);
  assert.match(sent[0].text, /LLM не ответил/);
  assert.match(sent[0].text, /Слово дня/);
});

test('runDailyFact: после 100 дней курс закрыт', async () => {
  const { deps, sent, state } = makeDeps();
  state.set('fact_day_done', '100');
  const result = await runDailyFact({ chatId: 5, slotKey: 'k', todayKey: '2027-03-01', deps });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'finished');
  assert.equal(sent.length, 0);
});

test('runDailyFact: отправка не удалась — день не засчитывается и повторится', async () => {
  const { deps, state } = makeDeps();
  deps.send = async () => 0; // Telegram не принял ни одного куска
  const first = await runDailyFact({ chatId: 5, slotKey: 'k', todayKey: '2026-11-13', deps });
  assert.equal(first.sent, false);
  assert.equal(first.reason, 'send');
  assert.equal(state.get('fact_day_done'), undefined, 'прогресс не двигается');
  assert.equal(state.get('fact_day_date'), undefined);

  deps.send = async () => 1; // канал восстановился — тот же день уходит
  const second = await runDailyFact({ chatId: 5, slotKey: 'k', todayKey: '2026-11-13', deps });
  assert.equal(second.sent, true);
  assert.equal(second.day, 1);
  assert.equal(state.get('fact_day_done'), '1');
});

test('промпт требует схему и квиз-блок', () => {
  const task = factTask({ entry: factEntry(2), items: [] });
  assert.match(task.system, /<pre>/);
  assert.match(task.system, /QUIZ:/);
  assert.match(task.system, /ANSWER:/);
  assert.match(task.system, /REVIEW:/);
  assert.match(task.system, /<b>Пример\.<\/b>/);
  assert.match(task.system, /бытовая аналогия/);
  assert.match(task.system, /выдумывать модели, компании и цифры запрещено/);
  assert.match(task.system, /<a href="URL">🛒<\/a>/);
  assert.match(task.system, /Ссылка ВСЕГДА спрятана в эмодзи/);
  assert.match(task.system, /не больше 6 строк/);
  assert.match(task.user, /кинематика/i);
});

test('sanitizeFactHtml: схема в <pre> сохраняется, теги внутри срезаются, строки ограничены', () => {
  const long = ['▣ база', ' ─⟳ 1 ► плечо <b>жирный</b>', '2', '3', '4', '5', '6', '7'].join('\n');
  const html = sanitizeFactHtml(`<b>Схема.</b>\n<pre>${long}</pre>`, []);
  assert.match(html, /^<b>Схема\.<\/b>\n<pre>/);
  assert.match(html, /<\/pre>$/);
  assert.doesNotMatch(html, /<b>жирный<\/b>/);
  const block = html.slice(html.indexOf('<pre>') + 5, html.indexOf('</pre>'));
  assert.equal(block.split('\n').length, 6, 'не длиннее шести строк');
  assert.ok(block.split('\n').every((line) => line.length <= 34), 'не шире 34 символов');
});

test('sanitizeFactHtml: пустая схема не оставляет пустой блок', () => {
  const html = sanitizeFactHtml('<pre>   </pre> текст', []);
  assert.doesNotMatch(html, /<pre>/);
  assert.match(html, /текст/);
});

test('extractScheme: схема вынимается из <pre>, теги срезаются', async () => {
  const { extractScheme } = await import('../src/visual.js');
  const body = '<b>Схема.</b>\n<pre>▣ база ─⟳1► плечо\n  └─↕3► кисть</pre>\nдальше';
  assert.deepEqual(extractScheme(body), ['▣ база ─⟳1► плечо', '  └─↕3► кисть']);
  assert.deepEqual(extractScheme('<b>без схемы</b>'), []);
  assert.deepEqual(extractScheme('<pre>  </pre>'), [], 'пустая схема = нет схемы');
});

test('runDailyFact: визуал уходит перед текстом, его сбой не ломает день', async () => {
  const { deps, sent, state } = makeDeps({ answer: '<b>Факт.</b> текст\n<pre>▣ база ─↻1► плечо</pre>' });
  const visuals = [];
  deps.sendVisual = async (chatId, payload) => visuals.push({ chatId, payload });
  const ok = await runDailyFact({ chatId: 5, slotKey: 'k', todayKey: '2026-11-13', deps });
  assert.equal(ok.sent, true);
  assert.equal(visuals.length, 1);
  assert.match(visuals[0].payload.title, /День 1 из 100/);
  assert.deepEqual(visuals[0].payload.lines, ['▣ база ─↻1► плечо']);

  const { deps: deps2, sent: sent2, state: state2 } = makeDeps({ answer: '<b>Факт.</b> без схемы' });
  let called = 0;
  deps2.sendVisual = async () => { called += 1; throw new Error('нет рендера'); };
  const second = await runDailyFact({ chatId: 5, slotKey: 'k2', todayKey: '2026-11-14', deps: deps2 });
  assert.equal(second.sent, true, 'текст уходит даже без картинки');
  assert.equal(called, 0, 'без схемы визуал не рисуется');
  assert.equal(sent2.length, 1);
  assert.equal(state2.get('fact_day_done'), '1');
});

test('parseFactReply: текст без служебных блоков, квизы отдельно', () => {
  const raw = '<b>Факт.</b> суть\n\nQUIZ: сколько осей?\n1) 3\n2) 4\n3) 6\nANSWER: 3\nEXPLAIN: три плюс три';
  const parsed = parseFactReply(raw);
  assert.equal(parsed.body, '<b>Факт.</b> суть');
  assert.doesNotMatch(parsed.body, /QUIZ|ANSWER/);
  assert.equal(parsed.quiz.length, 1);
  assert.equal(parsed.quiz[0].kind, 'today');
  assert.equal(parsed.quiz[0].correctIndex, 2);
  assert.deepEqual(parsed.quiz[0].options, ['3', '4', '6']);
});

test('reviewEntryFor: повторение через три дня, дальше первого — молчим', () => {
  assert.equal(reviewEntryFor(1), null);
  assert.equal(reviewEntryFor(3), null);
  assert.equal(reviewEntryFor(4).day, 1);
  assert.equal(reviewEntryFor(7).day, 4);
});

test('runDailyFact: квизы уходят опросами, текст — без служебных строк', async () => {
  const answer = '<b>Факт.</b> суть\n<pre>▣ база</pre>\nQUIZ: q?\n1) a\n2) b\n3) c\nANSWER: 2\nEXPLAIN: e';
  const { deps, sent } = makeDeps({ answer });
  const quizzes = [];
  deps.sendQuiz = async (chatId, item) => quizzes.push(item);
  const result = await runDailyFact({ chatId: 5, slotKey: 'k', todayKey: '2026-11-13', deps });
  assert.equal(result.sent, true);
  assert.equal(quizzes.length, 1);
  assert.equal(quizzes[0].correctIndex, 1);
  assert.doesNotMatch(sent[0].text, /QUIZ|ANSWER|EXPLAIN/);
});
