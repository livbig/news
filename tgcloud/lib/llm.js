// Тонкая обёртка: платформа даёт fetch только через sdk, поэтому транспорт
// подставляется здесь. Та же логика живёт в llm-core.js и используется воркером.

import { fetch } from 'sdk';
import { loadConfig } from './config.js';
import { askWith, call, summarizeWith } from './llm-core.js';

export { LlmError, LlmTruncatedError, collectSseEvents, reduceSse } from './llm-core.js';

export async function summarize(itemsText, interests, onProgress, options = {}) {
  const config = await loadConfig();
  return summarizeWith({ http: fetch, config, itemsText, interests, onProgress, ...options });
}

export async function ask({ question, context, history = [] }) {
  const config = await loadConfig();
  return askWith({ http: fetch, config, question, context, history });
}

// Служебный вызов без thinking (FR-5, FR-13): только формулировки терминов, не текст для читателя.
const TERMS_SYSTEM = [
  'Ты помогаешь настроить новостной профиль.',
  'Из сообщения пользователя вычлени темы-интересы: не больше трёх, каждая — короткая именная группа из одного-трёх слов.',
  'Отбрось служебные слова и общие понятия («новости», «технологии», «мир»).',
  'Ответь строго JSON-массивом строк и больше ничего.',
].join(' ');

/**
 * Извлечение терминов интереса. Возвращает сырой ответ (разбор — interests.parseTermList).
 * Пустая строка = LLM недоступна: вызывающий берёт детерминированный фолбэк (FR-5).
 */
export async function extractTerms(text) {
  const config = await loadConfig();
  if (!config.llm.apiKey) return '';
  try {
    return await call({
      http: fetch,
      config,
      system: TERMS_SYSTEM,
      messages: [{ role: 'user', content: String(text ?? '') }],
      maxTokens: config.llm.serviceMaxTokens,
      thinking: false,
    });
  } catch (error) {
    console.warn('интересы: LLM-извлечение не удалось, беру формулировку как есть:', error?.message ?? error);
    return '';
  }
}
