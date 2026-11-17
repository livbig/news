// Настройки без секретов (коммитятся). Значения — из .env Python-версии и iter-21.
// Секреты живут в lib/secrets.js (генерится scripts/build-config.mjs, в git не попадает).

export const SETTINGS = {
  // --- LLM (R4: максимальное усилие мышления на сводке) ---
  llm: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash',
    maxTokens: 96000,
    effort: 'max',
    // DeepSeek: thinking включён по умолчанию, budget_tokens игнорируется (iter-19).
    thinking: { type: 'enabled' },
    // Служебные вызовы (выжимка, JSON-подбор, интервью, роутинг) — без мышления:
    // иначе оно съедает малый max_tokens (iter-18/iter-21).
    serviceMaxTokens: 4000,
    attempts: 2,
    retryPauseMs: 30000,
  },

  // --- объём сводки (D42/D43 + iter-21) ---
  digest: {
    perSource: 15,
    maxItems: 800,
    maxChars: 600000,
    textCap: 1200,
    itemTextCap: 4000,
    windowDays: 7, // максимум явного периода («за неделю»)
    defaultWindowDays: 1, // обычная «сводка» — только последние сутки
    firstWindowHours: 24,
    messageLimit: 4000, // критерий 5
  },

  collect: {
    workers: 6,
    pauseMs: 400, // вежливость к t.me между страницами канала
    maxPagesPerChannel: 2, // было 6 (R6): глубина нужна для догоняющих сводок, а inline-вызов ограничен 30 с
    requestTimeoutMs: 45000,
    retries: 3,
  },

  retention: { itemsDays: 10, days: 30 },

  sources: { max: 100 },

  tz: { offsetMin: 180 }, // Europe/Moscow, как TZ на Pi

  // Сводка считается в момент запроса, без внешних исполнителей. Вызов платформы
  // живёт ~30 с (замер iter-25), поэтому бюджет делится явно. Замеры iter-39:
  // 50 пунктов / 8000 токенов — 25.7 с и 12.2k символов; 2×30 пунктов
  // параллельно по 5000 токенов + редактор — ~22 с и 23k символов.
  inline: {
    collectDeadlineMs: 3000, // 16 быстрых источников; остальное время — LLM
    // Сколько источников трогаем за один запрос: остальные — следующим (курсор в БД).
    maxSourcesPerRun: 16,
    attempts: 1, // на повтор нет бюджета: не влезли — честная ошибка, а не зависший статус
    perSource: 8,
    maxItems: 60,
    maxChars: 120000,
    // Thinking внутри 30 с не оставлял места тексту (iter-18). Возврат глубины —
    // отдельным подходом (map-reduce/внешний воркер), не здесь.
    thinking: false,
    // 8000 — потолок одного вызова при <40 пунктах; дальше включается веер.
    maxTokens: 8000,
    // Веер: две части по 30 пунктов/5000 токенов идут параллельно, третья —
    // общий лид/синтез. Это даёт ~23k символов за один тап.
    fanout: { enabled: true, parts: 2, minItems: 40, maxTokensPerPart: 5000, maxTokensEditor: 2500 },
    hardDeadlineMs: 27000, // запас до платформенных 30 с
  },
};
