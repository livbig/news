/**
 * Фейковый локальный API ассистента для e2e: те же ручки, что `miniapp-server/server.mjs`,
 * но без баз — мост проверяет меню, проекты, карточку и смету настоящим кодом.
 */

import { createServer } from 'node:http';

const PROJECT = (id, label, status, estimate) => ({
	id,
	label,
	type: 'склад',
	status,
	estimates: [{ id: estimate, branch: 'main', seq: 1, status: 'draft', total: 48_260 }],
});

const ESTIMATES = {
	11: {
		id: 11,
		branch: 'main',
		seq: 1,
		status: 'draft',
		client: 'ООО «Ромашка»',
		total: 48_260,
		object: { id: 1, label: 'Склад Марьино', type: 'склад' },
		rows: [{ name: 'Монтаж камеры', unit: 'шт', qty: 4, price: 4500, sum: 18_000 }],
	},
	12: {
		id: 12,
		branch: 'budget',
		seq: 2,
		status: 'draft',
		client: 'ООО «Василёк»',
		total: 120_000,
		object: { id: 2, label: 'Офис Арбат', type: 'офис' },
		rows: [],
	},
};

const ACTIVE = [PROJECT(1, 'Склад Марьино', 'active', 11)];
const ARCHIVED = [PROJECT(2, 'Офис Арбат', 'archived', 12)];

export async function startFakeMiniapp({ token = 'service-token' } = {}) {
	const calls = [];
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		calls.push({ path: url.pathname, query: url.search, token: req.headers['x-service-token'] });

		const json = (payload) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		};

		if (token && req.headers['x-service-token'] !== token) {
			res.writeHead(403, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ error: 'нет доступа' }));
		}

		if (url.pathname === '/api/projects') {
			return json(url.searchParams.get('archived') === '1' ? ARCHIVED : ACTIVE);
		}
		if (url.pathname === '/api/estimate') {
			const found = ESTIMATES[Number(url.searchParams.get('id'))];
			if (!found) {
				res.writeHead(404, { 'content-type': 'application/json' });
				return res.end(JSON.stringify({ error: 'смета не найдена' }));
			}
			return json(found);
		}
		if (url.pathname === '/api/object/archive') {
			// Кто в архиве, тот и возвращается: состояние фикстуры не меняем, ответ мосту хватает.
			return json({ ok: true });
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'нет метода' }));
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		baseUrl: `http://127.0.0.1:${server.address().port}`,
		calls,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
