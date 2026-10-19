// Тонкая обёртка: платформа даёт fetch только через sdk, поэтому транспорт
// подставляется здесь. Та же логика живёт в llm-core.js и используется воркером.

import { fetch } from 'sdk';
import { loadConfig } from './config.js';
import { askWith, summarizeWith } from './llm-core.js';

export { LlmError, LlmTruncatedError, collectSseEvents, reduceSse } from './llm-core.js';

export async function summarize(itemsText, interests, onProgress) {
  const config = await loadConfig();
  return summarizeWith({ http: fetch, config, itemsText, interests, onProgress });
}

export async function ask({ question, context, history = [] }) {
  const config = await loadConfig();
  return askWith({ http: fetch, config, question, context, history });
}
