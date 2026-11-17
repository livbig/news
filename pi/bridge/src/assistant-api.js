/**
 * Локальный HTTP API ассистента (Mini App отключён, данные — только на Pi).
 * Операции моста: проекты (активные и архив), смета, PDF, архивирование объекта.
 * Ответы кешируются на 30 с: навигация кнопками не должна дёргать API на каждое нажатие.
 */

export const ASSISTANT_API_URL = 'http://127.0.0.1:8088';
export const ASSISTANT_API_TIMEOUT_MS = 5000;
// Запись ждёт дольше чтения: на Pi SD-карта иногда встаёт в jbd2_log_wait_commit на 10–20 с,
// и короткий таймаут показывал бы «API не ответил», хотя архивная отметка уже записалась.
export const ASSISTANT_API_WRITE_TIMEOUT_MS = 30_000;
export const ASSISTANT_API_CACHE_MS = 30_000;

export function createAssistantApi({
	baseUrl = ASSISTANT_API_URL,
	token,
	fetch: fetchImpl = globalThis.fetch,
	timeoutMs = ASSISTANT_API_TIMEOUT_MS,
	writeTimeoutMs = ASSISTANT_API_WRITE_TIMEOUT_MS,
	cacheMs = ASSISTANT_API_CACHE_MS,
	now = Date.now,
} = {}) {
	const base = String(baseUrl).replace(/\/+$/, '');
	const cache = new Map();

	async function request(path, init = {}, limitMs = timeoutMs) {
		let response;
		try {
			response = await fetchImpl(`${base}${path}`, {
				...init,
				headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-service-token': token } : {}) },
				signal: AbortSignal.timeout(limitMs),
			});
		} catch (error) {
			const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
			throw new Error(timedOut ? `API не ответил за ${limitMs / 1000} с` : `API недоступен: ${messageOf(error)}`);
		}
		if (!response.ok) throw await failureOf(response);
		return response;
	}

	async function json(path, init, limitMs = timeoutMs) {
		const response = await request(path, init, limitMs);
		try {
			return await response.json();
		} catch {
			throw new Error('API вернул не JSON');
		}
	}

	async function cached(key, load) {
		const hit = cache.get(key);
		if (hit && now() - hit.at < cacheMs) return hit.value;
		const value = await load();
		cache.set(key, { at: now(), value });
		return value;
	}

	return {
		listProjects: ({ archived = false } = {}) =>
			cached(archived ? 'projects:archived' : 'projects', async () => {
				const data = await json(archived ? '/api/projects?archived=1' : '/api/projects');
				if (!Array.isArray(data)) throw new Error('API вернул не список проектов');
				return data;
			}),
		/**
		 * Архив вместо удаления: объект и его сметы остаются, меняется статус.
		 * Кеш сбрасывается, иначе меню покажет старое состояние до 30 с.
		 */
		setObjectArchived: async (id, archived) => {
			const data = await json(
				'/api/object/archive',
				{ method: 'POST', body: JSON.stringify({ id: Number(id), archived: Boolean(archived) }) },
				writeTimeoutMs,
			);
			cache.clear();
			return data;
		},
		getEstimate: (id) =>
			cached(`estimate:${id}`, async () => {
				const data = await json(`/api/estimate?id=${encodeURIComponent(id)}`);
				if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('API не нашёл смету');
				return data;
			}),
		getPdf: async (id) => {
			const response = await request(`/api/pdf?id=${encodeURIComponent(id)}`);
			const buffer = Buffer.from(await response.arrayBuffer());
			// Имя по правилу владельца приходит с сервера; запасное — чтобы файл всё равно был узнаваем.
			const header = response.headers.get('x-filename');
			const filename = header ? decodeURIComponent(header) : `Смета — ПЕРИМЕТР..pdf`;
			return { buffer, filename };
		},
	};
}

/** Ответ API с ошибкой: сервер отдаёт `{error: "…"}`, но может ответить и без тела. */
async function failureOf(response) {
	if (response.status === 403) return new Error('API отклонил доступ — проверьте MINIAPP_SERVICE_TOKEN');
	let detail;
	try {
		detail = (await response.json())?.error;
	} catch {
		// тело не JSON — ниже причина по коду ответа
	}
	return new Error(detail ? String(detail) : `API ответил ${response.status}`);
}

function messageOf(error) {
	return error instanceof Error ? error.message || error.name : String(error);
}
