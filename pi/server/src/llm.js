// Тонкая обёртка над llm-core: транспорт — глобальный fetch Node.
// Логика мышления, ретраев и обрезки осталась в llm-core.js без изменений.

import { loadConfig } from './config.js';
import { askWith, call, summarizeWith } from './llm-core.js';

export { LlmError, LlmTruncatedError, collectSseEvents, reduceSse } from './llm-core.js';

export async function summarize(itemsText, interests, onProgress, options = {}) {
  const config = loadConfig();
  return summarizeWith({ http: fetch, config, itemsText, interests, onProgress, ...options });
}

export async function ask({ question, context, history = [] }) {
  const config = loadConfig();
  return askWith({ http: fetch, config, question, context, history });
}

// Служебный вызов без thinking (FR-5, FR-13): только формулировки терминов, не текст для читателя.
const TERMS_SYSTEM = [
  'Ты помогаешь настроить новостной профиль.',
  'Из сообщения пользователя вычлени темы-интересы: не больше трёх, каждая — короткая именная группа из одного-трёх слов.',
  'Отбрось служебные слова и общие понятия («новости», «технологии», «мир»).',
  'Ответь строго JSON-массивом строк и больше ничего.',
].join(' ');

/** Служебный JSON-вызов без мышления: анализ пунктов, извлечение терминов. */
export async function serviceCall({ system, user, maxTokens = null }) {
  const config = loadConfig();
  if (!config.llm.apiKey) return '';
  return call({
    http: fetch,
    config,
    system,
    messages: [{ role: 'user', content: String(user ?? '') }],
    maxTokens: maxTokens ?? config.llm.serviceMaxTokens,
    thinking: false,
  });
}

export async function extractTerms(text) {
  const config = loadConfig();
  if (!config.llm.apiKey) return '';
  try {
    return await serviceCall({ system: TERMS_SYSTEM, user: text });
  } catch (error) {
    console.warn('интересы: LLM-извлечение не удалось, беру формулировку как есть:', error?.message ?? error);
    return '';
  }
}
