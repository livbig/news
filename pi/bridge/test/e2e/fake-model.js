/**
 * Фейковая модель и фейковый STT для сквозных тестов: HTTP на 127.0.0.1, формат OpenAI.
 *
 * Подменяется только поставщик модели — сам `pi`, его инструменты (`document_build`, `estimate_*`,
 * `set_reminder`), движок и мост работают настоящие. Сценарий ответа задаётся репликой пользователя,
 * поэтому прогон детерминированный и не ходит в сеть.
 */

import { createServer } from 'node:http';

/** Текст, который «распознаёт» фейковый STT: по нему проверяется, что расшифровка дошла до модели. */
export const TRANSCRIPT = 'Проверка голосового: двадцать камер на объекте';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Содержимое tool-сообщения pi: строка или массив блоков `{type:'text'}`. */
function toolText(toolMessage) {
	const content = toolMessage?.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block?.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join('\n');
	}
	return '';
}

function userText(message) {
	const content = message?.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block?.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join('\n');
	}
	return '';
}

/** Какой инструмент дал последний результат: имя лежит в предыдущем assistant-сообщении. */
function lastToolCall(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const call = messages[index]?.tool_calls?.[0];
		if (!call) continue;
		return { name: call.function?.name, args: parseJson(call.function?.arguments) };
	}
	return { name: null, args: {} };
}

function parseJson(text) {
	try {
		return JSON.parse(String(text ?? ''));
	} catch {
		return {};
	}
}

/** JSON-блок инструмента: он идёт первым блоком, маркер `[file:]` — отдельной строкой. */
function jsonBlock(text) {
	const start = text.indexOf('{');
	if (start < 0) return null;
	for (let end = text.length; end > start; end -= 1) {
		try {
			return JSON.parse(text.slice(start, end));
		} catch {
			// пробуем более короткий кусок
		}
	}
	return null;
}

/**
 * Ответ ассистента, на котором ломалось форматирование (фидбек Максима 28.10.2026):
 * markdown-таблица сметы, жирный/курсив/списки, `<`/`&`, длинная строка и таблица длиннее лимита,
 * эмодзи и юникод. Прогоняется через настоящий мост в фейковый Bot API — по нему проверяется,
 * что в чат уходит валидный HTML без сырого markdown.
 */
export const FORMAT_PROBE_TABLE_HEADER = '| Позиция | Кол-во | Цена | Сумма |';
export const FORMAT_PROBE = [
	'Смета по складу готова.',
	'',
	FORMAT_PROBE_TABLE_HEADER,
	'| --- | ---: | ---: | ---: |',
	'| Уличная купольная IP-видеокамера с ИК-подсветкой до 30 м | 4 | 7 190 | 28 760 |',
	'| Монтаж и юстировка камеры, стандарт | 4 | 4 500 | 18 000 |',
	'| Транспортные расходы | 1 | 1 500 | 1 500 |',
	'| **Итого** | | | **48 260** |',
	'',
	'Что важно:',
	'- гарантия 12 месяцев, монтаж под ключ;',
	'- скидка 5 % — только за наличный расчёт.',
	'',
	'Заказчик — ООО «Ромашка» & партнёры, проём < 900 мм, смета < 50 000 ₽. 🎥✅',
	'### Это не заголовок, а строка с решётками',
	'Строка с *курсивом*, **жирным** и `кодом`.',
	'',
	`Длинная строка: ${'слово '.repeat(700)}конец длинной строки.`,
	'',
	'Таблица на 60 строк:',
	'',
	FORMAT_PROBE_TABLE_HEADER,
	'| --- | ---: | ---: | ---: |',
	...Array.from({ length: 60 }, (_, index) => `| Позиция сметы ${index + 1} — описание | ${index + 1} | ${(index + 1) * 100} | ${(index + 1) * 100} |`),
].join('\n');

/**
 * Сценарий хода. Возвращает `{ tool }` или `{ content }` — то, что модель «решила» сказать.
 * Правила по реплике пользователя, а не по счётчику вызовов: прогон остаётся читаемым.
 */
export function decide(messages) {
	const last = messages.at(-1);
	if (last?.role === 'tool') {
		const { name, args } = lastToolCall(messages);
		const text = toolText(last);
		if (name === 'estimate_show') return { tool: { name: 'document_build', args: { estimateId: args.estimateId } } };
		if (name === 'document_build') {
			// Провал самопроверки: файла нет, маркера `[file:]` нет — в чат уходит только ошибка.
			if (!text.includes('[file:')) return { content: `Не смог собрать документ: ${text.slice(0, 200)}` };
			const details = jsonBlock(text) ?? {};
			return { content: `Смета готова.\n\n${details.table ?? ''}\n\n[file:${details.path}]` };
		}
		if (name === 'write') {
			// Результат инструмента эхом: так видно и успех, и отказ guard'а («чужая зона»).
			return { content: `Правило: ${text.slice(0, 200)}` };
		}
		if (name === 'remember') {
			const details = jsonBlock(text) ?? {};
			return { content: `Запомнил: ${details.text ?? details.saved ?? '—'}` };
		}
		if (name === 'recall') {
			const details = jsonBlock(text) ?? {};
			const rows = Array.isArray(details.rows) ? details.rows : [];
			return { content: `Помню (${details.found ?? rows.length}): ${rows.map((row) => row.text).join('; ') || 'ничего'}` };
		}
		if (name === 'set_reminder') {
			const details = jsonBlock(text) ?? {};
			return { content: `Напоминание поставлено: ${details.due_moscow ?? details.due_at ?? '—'} — ${details.text ?? ''}` };
		}
		return { content: `Готово: ${text.slice(0, 200)}` };
	}

	const prompt = userText(last);

	// Дворецкий: правка правил — обычный write, путь приходит в промпте (как в бою агент знает cwd).
	const rule = /добавь правило \[path:([^\]]+)\]/i.exec(prompt);
	if (rule) {
		return { tool: { name: 'write', args: { path: rule[1], content: '# AGENTS.md\n\n- 2026-10-30: проверка самоулучшения\n' } } };
	}
	// Дворецкий: память — настоящие инструменты расширения, модель их вызывает как в бою.
	if (/^запомни[\s:,—-]/i.test(prompt)) {
		return { tool: { name: 'remember', args: { text: prompt.replace(/^запомни[\s:,—-]*/i, ''), kind: 'fact' } } };
	}
	if (/что (ты )?(обо мне )?помнишь|что помню/i.test(prompt)) {
		return { tool: { name: 'recall', args: { query: '' } } };
	}
	// Дворецкий: файл из ответа — маркер отдельной строкой, иначе мост его не вынет.
	if (/отправь файл/i.test(prompt)) {
		const path = /\[file:([^\]]+)\]/.exec(prompt)?.[1] ?? '';
		return { content: `Готово.\n[file:${path}]` };
	}
	if (/напомни/i.test(prompt)) {
		return { tool: { name: 'set_reminder', args: { deal_id: 1, due_at: '2020-01-01T09:00:00.000Z', text: 'позвонить по смете' } } };
	}
	// «битым» — отказная ветка: версии с таким id нет, инструмент обязан ответить ошибкой.
	// Раньше здесь была версия 3 с огромным итогом, но вёрстка кольца теперь масштабирует сумму,
	// и самопроверка PDF на ней больше не срабатывает (сама самопроверка покрыта test/pdf-estimate).
	if (/битым|битый/i.test(prompt)) return { tool: { name: 'estimate_show', args: { estimateId: 999 } } };
	// «проверка формата» — ответ со таблицей/разметкой для сквозного теста отправки.
	if (/проверка формата/i.test(prompt)) return { content: FORMAT_PROBE };
	if (/без телефона/i.test(prompt)) return { tool: { name: 'estimate_show', args: { estimateId: 2 } } };
	if (/смету/i.test(prompt)) return { tool: { name: 'estimate_show', args: { estimateId: 1 } } };
	return { content: `Слышал: ${prompt}` };
}

/** Поток OpenAI chat.completions с одним ответом модели: текст или один tool_call. */
function streamAnswer({ content, tool }) {
	const chunks = [];
	const frame = (delta, finish) =>
		chunks.push(
			`data: ${JSON.stringify({
				id: 'chatcmpl-e2e',
				object: 'chat.completion.chunk',
				created: 1,
				model: 'e2e-model',
				choices: [{ index: 0, delta, finish_reason: finish ?? null }],
			})}\n\n`,
		);
	if (tool) {
		frame({
			role: 'assistant',
			content: null,
			tool_calls: [
				{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } },
			],
		});
		frame({}, 'tool_calls');
	} else {
		frame({ role: 'assistant', content: content ?? '' });
		frame({}, 'stop');
	}
	chunks.push(
		`data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
	);
	chunks.push('data: [DONE]\n\n');
	return chunks.join('');
}

export async function startFakeModel({ transcript = TRANSCRIPT } = {}) {
	// Что модель реально получила: по этому проверяется, что расшифровка дошла до промпта.
	const requests = [];
	const sttRequests = [];

	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString('utf8');
		const url = new URL(req.url, 'http://127.0.0.1');

		if (url.pathname.endsWith('/audio/transcriptions')) {
			sttRequests.push({ at: Date.now(), bytes: raw.length });
			await sleep(10);
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ text: transcript }));
		}

		if (!url.pathname.endsWith('/chat/completions')) {
			res.writeHead(404, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ error: { message: 'not found' } }));
		}

		const payload = parseJson(raw);
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const answer = decide(messages);
		requests.push({
			at: Date.now(),
			model: payload.model,
			/** Все реплики пользователя: тест ищет в них расшифровку голосового. */
			user: messages.filter((message) => message.role === 'user').map(userText).join('\n'),
			tools: (payload.tools ?? []).map((tool) => tool.function?.name).filter(Boolean),
			answer,
		});
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
		return res.end(streamAnswer(answer));
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		sttRequests,
		get toolsSeen() {
			return [...new Set(requests.flatMap((request) => request.tools))];
		},
		async waitFor(predicate, { timeoutMs = 30_000, label = 'вызов модели' } = {}) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const hit = requests.find(predicate);
				if (hit) return hit;
				await sleep(25);
			}
			throw new Error(`не дождались: ${label}; модель звали ${requests.length} раз`);
		},
		async close() {
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
