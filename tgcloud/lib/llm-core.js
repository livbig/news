// LLM-клиент (R4): anthropic-messages через sdk/fetch, стриминг.
// Контракт прод-версии (pipeline/llm.py::_call, iter-19/20):
//   thinking включён по умолчанию; усилие — output_config.effort (low/high/max),
//   budget_tokens DeepSeek игнорирует; stop_reason=max_tokens = сбой, а не «короткая сводка».
// Ретрай-лестница max→high: повтор с тем же усилием после обрезки бессмыслен (iter-20).

import { CHAT_SYSTEM_PROMPT, MOCK_NOTE, digestPrompt } from './prompts.js';
import { normalizeLlmText } from './text.js';

export class LlmError extends Error {}
export class LlmTruncatedError extends LlmError {}

function maskSecrets(text) {
  return String(text ?? '')
    .replace(/\b(sk|key)[-_A-Za-z0-9]{8,}/gi, '[ключ]')
    .replace(/\bapp\d+:[A-Za-z0-9_-]+/g, '[токен платформы]')
    .replace(/\b\d{8,}:[A-Za-z0-9_-]{30,}/g, '[токен бота]')
    .slice(0, 300);
}

/** Разбор SSE-потока anthropic-messages. Вынесен отдельно: гоняется в тестах без сети. */
export function collectSseEvents(raw) {
  const events = [];
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // битая строка SSE — пропускаем: остальной поток валиден (iter-21: не роняем сводку)
    }
  }
  return events;
}

/** Свести события в текст + причину остановки + расход. Чистая функция. */
export function reduceSse(events) {
  let text = '';
  let stopReason = null;
  let usage = null;
  for (const event of events) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      text += event.delta.text ?? '';
    } else if (event.type === 'message_delta') {
      stopReason = event.delta?.stop_reason ?? stopReason;
      usage = event.usage ?? usage;
    } else if (event.type === 'error') {
      throw new LlmError(`LLM stream error: ${JSON.stringify(event.error ?? {})}`);
    }
  }
  return { text, stopReason, usage };
}

async function readStream(response, onProgress) {
  const started = Date.now();
  // Замер 2026-10-19: в изоляте res.body.getReader отсутствует (TypeError), поэтому
  // основной путь — текст целиком. Ветка со стримом оставлена на случай, если
  // платформа включит потоковое чтение: тогда прогресс «думаю…» станет живым.
  const stream = response.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let stopReason = null;
    let usage = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const cut = buffer.lastIndexOf('\n');
      if (cut < 0) continue;
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      const before = text.length;
      const reduced = reduceSse(collectSseEvents(chunk));
      text += reduced.text;
      if (reduced.stopReason) stopReason = reduced.stopReason;
      if (reduced.usage) usage = reduced.usage;
      if (text.length !== before) onProgress?.({ chars: text.length, elapsedMs: Date.now() - started });
    }
    const tail = reduceSse(collectSseEvents(buffer));
    text += tail.text;
    stopReason = tail.stopReason ?? stopReason;
    usage = tail.usage ?? usage;
    return { text, stopReason, usage };
  }
  const raw = await response.text();
  const { text, stopReason, usage } = reduceSse(collectSseEvents(raw));
  onProgress?.({ chars: text.length, elapsedMs: Date.now() - started });
  return { text, stopReason, usage };
}

async function call({ http, config, system, messages, maxTokens, thinking = true, effort = null, onProgress }) {
  const payload = {
    model: config.llm.model,
    max_tokens: maxTokens,
    system,
    messages,
    stream: true,
  };
  if (thinking) {
    payload.thinking = config.llm.thinking;
    if (effort ?? config.llm.effort) payload.output_config = { effort: effort ?? config.llm.effort };
  } else {
    // Явное отключение: у DeepSeek thinking включён по умолчанию (iter-19).
    payload.thinking = { type: 'disabled' };
  }

  let response;
  try {
    response = await http(`${String(config.llm.baseUrl).replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.llm.apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new LlmError(`LLM недоступна (сеть): ${maskSecrets(error?.message ?? error)}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`LLM ${response.status}: ${maskSecrets(body)}`);
    throw new LlmError(`LLM API ошибка ${response.status}: ${maskSecrets(body)}`);
  }

  const result = await readStream(response, onProgress);
  // Обрыв тела ответа (нет message_delta/message_stop) = недописанная сводка.
  // Раньше такой текст уходил как полный и помечал пункты прочитанными (ревью 2026-10-19).
  if (!result.stopReason) throw new LlmError('поток LLM оборван: нет stop_reason (сеть/таймаут)');
  if (result.stopReason === 'max_tokens') {
    const error = new LlmTruncatedError(
      `ответ обрезан по max_tokens=${maxTokens} (выход ${result.usage?.output_tokens ?? '?'} токенов)`,
    );
    // Обрезанный текст — всё ещё сводка: отдаём его наверх, чтобы вызов не пропадал.
    error.partial = result.text;
    throw error;
  }
  return result.text;
}

/**
 * Сводка одним mega-вызовом (D42). Без ключа — mock-заглушка (NFR-05).
 * @param {string} itemsText вход в блоке <новости>
 * @param {string|null} interests профиль читателя (users.interests_text)
 * @param {(p:{chars:number,elapsedMs:number})=>void} [onProgress] живость «думаю…»
 */
const EFFORT_LADDER = ['max', 'high', 'medium', 'low'];
function lowerEffort(effort) {
  const index = EFFORT_LADDER.indexOf(effort);
  return EFFORT_LADDER[Math.min(index + 1, EFFORT_LADDER.length - 1)] ?? 'low';
}

async function summarizeWith({ http, config, itemsText, interests, onProgress, effort: forcedEffort = null, maxTokens = null, thinking = null, attempts = null }) {
  if (!config.llm.apiKey) {
    console.warn('LLM_API_KEY не задан — mock-сводка (dev)');
    return `${MOCK_NOTE}\n\n${itemsText.slice(0, 1500)}`;
  }
  const messages = [{ role: 'user', content: itemsText }];
  let lastError = null;
  const maxAttempts = Math.max(1, attempts ?? config.llm.attempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Обрезка по max_tokens: повтор с тем же усилием бесполезен (iter-20) — снижаем на шаг.
    const effort = lastError instanceof LlmTruncatedError ? lowerEffort(forcedEffort ?? config.llm.effort) : forcedEffort;
    try {
      if (effort) console.warn(`LLM: повтор с effort=${effort} после обрезки`);
      const text = await call({
        http,
        config,
        system: digestPrompt(interests),
        messages,
        maxTokens: maxTokens ?? config.llm.maxTokens,
        thinking: thinking ?? true,
        effort,
        onProgress,
      });
      if (text.trim()) return normalizeLlmText(text);
      lastError = new LlmError('пустой ответ (только thinking-блоки?)');
    } catch (error) {
      if (error instanceof LlmError && /LLM API ошибка 4\d\d/.test(error.message)) throw error;
      lastError = error;
    }
    console.error(`LLM попытка ${attempt}/${maxAttempts} не удалась: ${lastError?.message}`);
    if (attempt < maxAttempts) await sleep(config.llm.retryPauseMs);
  }
  throw new LlmError(`LLM недоступна после ${maxAttempts} попыток: ${lastError?.message ?? '?'}`);
}

/** Диалог и уточнения по темам (R3): без мышления — малый бюджет, как в проде. */
/**
 * История чата → сообщения anthropic. В БД строки {role, text}; модель ждёт {role, content}
 * и чередование ролей. Ошибку поймал живой вызов 2026-10-19 («missing field content»).
 */
export function toMessages(history, question) {
  const cleaned = [];
  for (const row of history ?? []) {
    const content = String(row?.content ?? row?.text ?? '').trim();
    if (!content) continue;
    const role = row?.role === 'assistant' ? 'assistant' : 'user';
    if (cleaned.length && cleaned[cleaned.length - 1].role === role) {
      cleaned[cleaned.length - 1].content += `\n${content}`;
    } else {
      cleaned.push({ role, content });
    }
  }
  while (cleaned.length && cleaned[0].role === 'assistant') cleaned.shift();
  cleaned.push({ role: 'user', content: String(question ?? '').trim() });
  return cleaned;
}

async function askWith({ http, config, question, context, history = [] }) {
  if (!config.llm.apiKey) return `${MOCK_NOTE}\n\n(контекст: ${context.slice(0, 500)})`;
  const system = `${CHAT_SYSTEM_PROMPT}\n\nКонтекст последних статей ленты:\n${context}`;
  const messages = toMessages(history, question);
  const text = await call({
    http,
    config,
    system,
    messages,
    maxTokens: config.llm.serviceMaxTokens,
    thinking: false,
  });
  return normalizeLlmText(text);
}

/** Пауза между попытками. Замер 2026-10-19: setTimeout в изоляте отсутствует,
 * поэтому пауза вырождается в ноль — повторы идут сразу (это лучше, чем висеть:
 * бюджет вызова ~30 с, тратить его на сон нельзя). */
function sleep(ms) {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, ms);
    else resolve();
  });
}

export { call, summarizeWith, askWith };
