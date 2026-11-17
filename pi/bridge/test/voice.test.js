import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	VOICE_MAX_BYTES,
	audioFormat,
	buildTranscriptionRequest,
	formatVoiceDuration,
	parseTranscription,
	transcribeAudio,
	voiceLimitProblem,
} from '../src/voice.js';

const AUDIO = Buffer.from([1, 2, 3]);

test('длительность голосового — как в плеере', () => {
	assert.equal(formatVoiceDuration(222), '3:42');
	assert.equal(formatVoiceDuration(59), '0:59');
	assert.equal(formatVoiceDuration(undefined), '0:00');
});

test('лимиты голоса: 10 минут и 20 МБ, ровно на границе — можно', () => {
	assert.equal(voiceLimitProblem({ duration: 600, fileSize: VOICE_MAX_BYTES }), undefined);
	assert.match(voiceLimitProblem({ duration: 601 }), /10 минут/);
	assert.match(voiceLimitProblem({ fileSize: VOICE_MAX_BYTES + 1 }), /20 МБ/);
});

test('формат аудио: голосовое — ogg, у файла — из mime_type', () => {
	assert.equal(audioFormat({ voice: { duration: 1 } }), 'ogg');
	assert.equal(audioFormat({ audio: { mime_type: 'audio/mpeg' } }), 'mp3');
	assert.equal(audioFormat({ audio: { mime_type: 'audio/x-m4a' } }), 'm4a');
	assert.equal(audioFormat({ audio: {} }), 'ogg');
});

test('запрос STT: OpenRouter /audio/transcriptions с base64 и моделью', () => {
	const { url, init } = buildTranscriptionRequest({
		data: AUDIO,
		format: 'ogg',
		language: 'ru',
		model: 'openai/whisper-large-v3',
		baseUrl: 'https://openrouter.ai/api/v1/',
		apiKey: 'test-key',
	});
	assert.equal(url, 'https://openrouter.ai/api/v1/audio/transcriptions');
	assert.equal(init.method, 'POST');
	assert.equal(init.headers.Authorization, 'Bearer test-key');
	assert.equal(init.headers['Content-Type'], 'application/json');
	assert.deepEqual(JSON.parse(init.body), {
		input_audio: { data: 'AQID', format: 'ogg' },
		language: 'ru',
		model: 'openai/whisper-large-v3',
	});
});

test('разбор ответа STT: text (и transcription как запасной вариант), пустой — ошибка', () => {
	assert.equal(parseTranscription({ text: ' привет ' }), 'привет');
	assert.equal(parseTranscription({ transcription: 'привет' }), 'привет');
	assert.throws(() => parseTranscription({ text: '  ' }), /пустой транскрипт/);
	assert.throws(() => parseTranscription({}), /пустой транскрипт/);
});

test('transcribeAudio: мок fetch получает запрос и возвращает текст', async () => {
	const calls = [];
	const result = await transcribeAudio({
		data: AUDIO,
		format: 'ogg',
		language: 'ru',
		model: 'openai/whisper-large-v3',
		baseUrl: 'https://openrouter.ai/api/v1',
		apiKey: 'test-key',
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return { ok: true, status: 200, json: async () => ({ text: 'привет из голоса' }) };
		},
	});
	assert.equal(result, 'привет из голоса');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/audio/transcriptions');
	assert.equal(JSON.parse(calls[0].init.body).input_audio.format, 'ogg');
	assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
});

test('transcribeAudio: ошибка HTTP и без ключа — текстом, а не тишиной', async () => {
	await assert.rejects(
		() =>
			transcribeAudio({
				data: AUDIO,
				model: 'm',
				baseUrl: 'https://example.test',
				apiKey: 'test-key',
				fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'плохой шлюз' }),
			}),
		/STT 502: плохой шлюз/,
	);
	await assert.rejects(() => transcribeAudio({ data: AUDIO, model: 'm' }), /OPENROUTER_API_KEY/);
});
