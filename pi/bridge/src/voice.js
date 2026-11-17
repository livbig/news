/**
 * Голосовые: лимиты, сборка запроса OpenRouter STT и разбор ответа.
 * Сеть — встроенный fetch, ключ уходит только в заголовок Authorization и не попадает в ошибки.
 */

export const VOICE_MAX_SECONDS = 10 * 60;
// Потолок не наш, а Телеграма: getFile не отдаёт файлы больше 20 МБ.
export const VOICE_MAX_BYTES = 20 * 1024 * 1024;

export function formatVoiceDuration(seconds) {
	const total = Math.max(0, Math.round(Number(seconds ?? 0)));
	const minutes = Math.floor(total / 60);
	return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/** Текст отказа по лимитам Telegram/STT или undefined, если запись помещается. */
export function voiceLimitProblem({ duration, fileSize } = {}) {
	if (Number(duration ?? 0) > VOICE_MAX_SECONDS) {
		return `Голосовое длиннее 10 минут (${formatVoiceDuration(duration)}) — не принимаю. Пришлите короче или текстом.`;
	}
	if (Number(fileSize ?? 0) > VOICE_MAX_BYTES) {
		return 'Файл больше 20 МБ — не принимаю. Пришлите короче или текстом.';
	}
	return undefined;
}

const MIME_FORMATS = {
	'audio/ogg': 'ogg',
	'audio/opus': 'ogg',
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/flac': 'flac',
	'audio/webm': 'webm',
};

/** Голосовое Telegram — всегда ogg/opus; у аудио берём формат из mime_type. */
export function audioFormat(message) {
	if (message?.voice) return 'ogg';
	return MIME_FORMATS[String(message?.audio?.mime_type ?? '').toLowerCase()] ?? 'ogg';
}

export function buildTranscriptionRequest({ data, format = 'ogg', language = 'ru', model, baseUrl, apiKey }) {
	return {
		url: `${String(baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/audio/transcriptions`,
		init: {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				input_audio: { data: Buffer.from(data).toString('base64'), format },
				language,
				model,
			}),
		},
	};
}

export function parseTranscription(payload) {
	const text = payload?.text ?? payload?.transcription;
	if (typeof text !== 'string' || !text.trim()) throw new Error('STT: пустой транскрипт');
	return text.trim();
}

export async function transcribeAudio({
	data,
	format = 'ogg',
	language = 'ru',
	model,
	baseUrl,
	apiKey,
	fetchImpl = globalThis.fetch,
} = {}) {
	if (!apiKey) throw new Error('OPENROUTER_API_KEY не задан');
	const { url, init } = buildTranscriptionRequest({ data, format, language, model, baseUrl, apiKey });
	let response;
	try {
		response = await fetchImpl(url, init);
	} catch (error) {
		throw new Error(`STT: сеть недоступна (${error?.message ?? error})`);
	}
	if (!response.ok) {
		let detail = '';
		try {
			detail = await response.text?.();
		} catch {
			// тело ошибки не прочиталось — покажем хотя бы статус
		}
		const tail = String(detail ?? '').trim().slice(0, 200);
		throw new Error(`STT ${response.status}: ${tail || 'пустой ответ'}`);
	}
	let payload;
	try {
		payload = await response.json();
	} catch {
		throw new Error('STT: ответ не JSON');
	}
	return parseTranscription(payload);
}
