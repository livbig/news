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
    windowDays: 7, // решение пользователя 2026-10-19: не больше недели
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
  // живёт ~30 с (замер iter-25), поэтому бюджет жёстко делится: сбор ≤14 с,
  // остальное — LLM с меньшим усилием и компактным входом.
  inline: {
    collectDeadlineMs: 5000,
    // Сколько источников трогаем за один запрос: остальные — следующим (курсор в БД).
    maxSourcesPerRun: 16,
    attempts: 1, // на повтор нет бюджета: не влезли — честная ошибка, а не зависший статус
    perSource: 4,
    maxItems: 25,
    maxChars: 45000,
    // Замер 2026-10-19 на живом входе (28 пунктов): thinking+effort=low c maxTokens 3500
    // отдаёт 0 символов (thinking съел весь бюджет, iter-18), thinking выкл. — 17 с и
    // полная сводка на 9.3k символов. Внутри 30-секундного вызова другого варианта нет.
    thinking: false,
    // 3000 токенов модель выбивала на дневной сводке и обрезала ответ; 5000 — потолок,
    // при котором генерация (~19-22 с) ещё влезает в 30-секундный вызов вместе со сбором.
    maxTokens: 5000,
    hardDeadlineMs: 27000, // запас до платформенных 30 с
  },
};
