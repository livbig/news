import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ASSISTANT_API_CACHE_MS, ASSISTANT_API_TIMEOUT_MS, createAssistantApi } from '../src/assistant-api.js';

const PROJECTS = [
	{
		id: 12,
		label: 'Аман склады Любучанск',
		type: 'склад',
		status: 'active',
		active_estimate_id: 52,
		estimates: [
			{ id: 50, object_id: 12, branch: 'main', seq: 1, status: 'draft', total: 340306.15, created: '2026-10-27T13:58:40.000Z' },
			{ id: 51, object_id: 12, branch: 'budget', seq: 1, status: 'draft', total: 326978, created: '2026-10-27T15:43:41.638Z' },
		],
	},
];

const ESTIMATE = {
	id: 51,
	object: { id: 12, label: 'Аман склады Любучанск', type: 'склад' },
	client: 'Аман',
	branch: 'budget',
	seq: 1,
	status: 'draft',
	total: 326978,
	frozen: false,
	rows: [{ sku: 'SKU-1', name: 'Шлагбаум', unit: 'шт', qty: 2, price: 1500, sum: 3000 }],
	meta: { discountPct: 5 },
};

function jsonResponse(data, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('API: проекты и смета разбираются, токен уходит заголовком', async () => {
	const calls = [];
	const api = createAssistantApi({
		baseUrl: 'http://127.0.0.1:8088/',
		token: 'service-secret',
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			if (String(url).endsWith('/api/projects')) return jsonResponse(PROJECTS);
			return jsonResponse(ESTIMATE);
		},
	});

	assert.deepEqual(await api.listProjects(), PROJECTS);
	assert.deepEqual(await api.getEstimate(51), ESTIMATE);
	assert.equal(calls[0].url, 'http://127.0.0.1:8088/api/projects');
	assert.equal(calls[1].url, 'http://127.0.0.1:8088/api/estimate?id=51');
	assert.equal(calls[0].init.headers['x-service-token'], 'service-secret');
	assert.equal(calls[0].init.signal instanceof AbortSignal, true, 'запрос ограничен таймаутом');
	assert.equal(ASSISTANT_API_TIMEOUT_MS, 5000);
});

test('API: PDF отдаётся буфером и именем по правилу владельца', async () => {
	const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
	const calls = [];
	const api = createAssistantApi({
		baseUrl: 'http://127.0.0.1:8088',
		fetch: async (url) => {
			calls.push(String(url));
			return {
				ok: true,
				status: 200,
				headers: { get: (name) => (name === 'x-filename' ? encodeURIComponent('Смета №0209 — ПЕРИМЕТР..pdf') : null) },
				arrayBuffer: async () => bytes.buffer,
			};
		},
	});

	const pdf = await api.getPdf(51);
	assert.equal(Buffer.isBuffer(pdf.buffer), true);
	assert.deepEqual([...pdf.buffer], [...bytes]);
	assert.equal(pdf.filename, 'Смета №0209 — ПЕРИМЕТР..pdf');
	assert.equal(calls[0], 'http://127.0.0.1:8088/api/pdf?id=51');
});

test('API: кеш 30 секунд, потом свежий запрос', async () => {
	let clock = 1_000_000;
	let fetches = 0;
	const api = createAssistantApi({
		baseUrl: 'http://127.0.0.1:8088',
		fetch: async (url) => {
			fetches += 1;
			return String(url).endsWith('/api/projects') ? jsonResponse(PROJECTS) : jsonResponse(ESTIMATE);
		},
		now: () => clock,
	});

	await api.listProjects();
	await api.listProjects();
	await api.getEstimate(51);
	await api.getEstimate(51);
	assert.equal(fetches, 2, 'повторные нажатия берут данные из кеша');

	clock += ASSISTANT_API_CACHE_MS - 1;
	await api.listProjects();
	assert.equal(fetches, 2, 'на 29 999-й миллисекунде данные ещё свежие');

	clock += 2;
	await api.listProjects();
	assert.equal(fetches, 3, 'после 30 с кеш истёк');
});

test('API: таймаут и отказ объясняются текстом', async () => {
	const timeout = createAssistantApi({
		baseUrl: 'http://127.0.0.1:8088',
		timeoutMs: 5000,
		fetch: async () => {
			const error = new Error('The operation was aborted due to timeout');
			error.name = 'TimeoutError';
			throw error;
		},
	});
	await assert.rejects(timeout.listProjects(), /API не ответил за 5 с/);

	const forbidden = createAssistantApi({
		baseUrl: 'http://127.0.0.1:8088',
		fetch: async () => jsonResponse({ error: 'только фаундерам ПЕРИМЕТР' }, 403),
	});
	await assert.rejects(forbidden.listProjects(), /API отклонил доступ — проверьте MINIAPP_SERVICE_TOKEN/);

	const notFound = createAssistantApi({
		baseUrl: 'http://127.0.0.1:8088',
		fetch: async () => jsonResponse({ error: 'нет такой сметы' }, 404),
	});
	await assert.rejects(notFound.getEstimate(999), /нет такой сметы/);

	const down = createAssistantApi({
		baseUrl: 'http://127.0.0.1:8088',
		fetch: async () => {
			throw new Error('fetch failed');
		},
	});
	await assert.rejects(down.listProjects(), /API недоступен: fetch failed/);
});

test('API: мусор вместо данных не выдаётся за проекты', async () => {
	const api = createAssistantApi({
		baseUrl: 'http://127.0.0.1:8088',
		fetch: async () => jsonResponse({ error: 'что-то не то' }),
	});
	await assert.rejects(api.listProjects(), /API вернул не список проектов/);
});
