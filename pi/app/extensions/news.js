/**
 * Инструменты новостного агрегатора для pi-агента.
 *
 * Мост Дворецкого даёт чат, голос, файлы и память; этот модуль — руки: собрать новости,
 * сделать сводку, посмотреть источники и интересы. Вся работа с базой идёт через службу
 * newsd (HTTP, 127.0.0.1), чтобы не было двух писателей в один SQLite.
 *
 * Ошибки возвращаются текстом, а не падением: агент должен уметь объяснить, что не так.
 */

const json = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload });
const failure = (error) => ({
  content: [{ type: 'text', text: `Ошибка: ${String(error?.message ?? error)}` }],
  details: { error: String(error?.message ?? error) },
  isError: true,
});
const guard = (run) => async (...args) => {
  try {
    return await run(...args);
  } catch (error) {
    return failure(error);
  }
};

export default function newsExtension(pi) {
  const baseUrl = (process.env.NEWS_API_URL ?? 'http://127.0.0.1:8097').replace(/\/+$/, '');
  const token = process.env.NEWS_API_TOKEN ?? '';
  // У зон без агрегатора (Дворецкий) токена нет: инструменты новостей просто не регистрируем.
  // Раньше здесь была ошибка — и дочерний pi падал на старте во всех зонах, кроме новостной.
  if (!token) return;

  async function api(path, { method = 'GET', body = null } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`служба новостей: ${data.error ?? `HTTP ${response.status}`}`);
    return data;
  }

  const minutes = (iso) => {
    const ms = Date.parse(String(iso ?? ''));
    if (!Number.isFinite(ms)) return '—';
    const diff = Math.round((Date.now() - ms) / 60_000);
    return `${new Date(ms).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (${diff} мин назад)`;
  };

  pi.registerTool({
    name: 'news_status',
    description:
      'Состояние агрегатора: расписание 09:00/21:00, когда был сбор и анализ, сколько новостей и источников. ' +
      'Вызывай, когда спрашивают «как дела», «когда следующая сводка», «всё работает?».',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: guard(async () => {
      const state = await api('/api/state');
      const stats = state.stats ?? {};
      const analysis = state.analysis ?? {};
      return json({
        расписание: state.sendTimes,
        следующая_сводка: state.nextSlot ? new Date(state.nextSlot.ms).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : null,
        последний_сбор: minutes(state.lastCollectAt),
        последний_анализ: minutes(state.lastAnalyzeAt),
        последняя_сводка: minutes(state.lastDigestAt),
        источников: stats.sources,
        новостей: stats.items,
        за_сутки: stats.fresh,
        разобрано: `${analysis.analyzed ?? 0} из ${analysis.total ?? 0}`,
        модель: state.model,
      });
    }),
  });

  pi.registerTool({
    name: 'news_collect',
    description:
      'Собрать новости со всех источников прямо сейчас (обычно сбор идёт сам каждые 20 минут). ' +
      'Вызывай по просьбе «собери новости», «обнови ленту». Может занять минуту-две.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: guard(async () => {
      const result = await api('/api/collect', { method: 'POST', body: {} });
      return json({
        источников: result.sources,
        новых_пунктов: result.added,
        ошибок: result.errors?.length ?? 0,
        разобрано: result.analysis?.analyzed ?? 0,
        примеры_ошибок: (result.errors ?? []).slice(0, 3),
      });
    }),
  });

  pi.registerTool({
    name: 'news_digest',
    description:
      'Сделать сводку и отправить её в этот чат. Без period — за последние сутки. ' +
      'Период можно назвать словами: «за 3 дня», «вчера», «с 1 октября». ' +
      'send=false — только вернуть текст, не отправляя (для правок перед отправкой).',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Период словами; пусто — последние сутки' },
        send: { type: 'boolean', description: 'Отправлять в чат; по умолчанию да' },
        collect: { type: 'boolean', description: 'Сначала собрать свежее (по умолчанию нет)' },
      },
      additionalProperties: false,
    },
    execute: guard(async (_id, params = {}) => {
      const send = params.send !== false;
      if (!send) {
        const digest = await api('/api/digest', { method: 'POST', body: { period: params.period ?? null, send: false, collect: Boolean(params.collect) } });
        return json({ пунктов: digest.items, символов: digest.chars, текст: digest.text });
      }
      const result = await api('/api/digest', { method: 'POST', body: { period: params.period ?? null, send: true, collect: Boolean(params.collect) } });
      return json(result.empty ? { отправлено: false, причина: 'за период новостей нет — в чат ушла честная строка' } : { отправлено: true, сводка: result.digestId, пунктов: result.items, символов: result.chars });
    }),
  });

  pi.registerTool({
    name: 'news_sources',
    description:
      'Источники: список с состоянием, добавить (url или @канал), включить/выключить, удалить. ' +
      'kind определяется автоматически: @канал → tgweb, *.xml/rss → rss, иначе html.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'enable', 'disable', 'remove'], description: 'Что сделать' },
        url: { type: 'string', description: 'Адрес источника для add' },
        title: { type: 'string', description: 'Название для add (необязательно)' },
        id: { type: 'integer', description: 'id источника для enable/disable/remove' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: guard(async (_id, params = {}) => {
      const action = params.action;
      if (action === 'list') {
        const data = await api('/api/sources');
        return json({
          всего: data.sources.length,
          ошибок: data.sources.filter((row) => row.status === 'error').length,
          источники: data.sources.map((row) => ({
            id: row.id,
            title: row.title,
            kind: row.kind,
            enabled: Boolean(row.enabled),
            всего: row.total,
            за_7_дней: row.fresh,
            статус: row.status === 'error' ? `ошибка: ${row.statusMsg ?? ''}` : 'ок',
          })),
        });
      }
      if (action === 'add') {
        if (!params.url) throw new Error('для add нужен url');
        const result = await api('/api/sources', { method: 'POST', body: { url: params.url, title: params.title ?? '' } });
        return json({ добавлен: result.created, id: result.id, тип: result.kind });
      }
      if (!params.id) throw new Error(`для ${action} нужен id источника`);
      if (action === 'remove') {
        const result = await api(`/api/sources/${params.id}`, { method: 'DELETE' });
        return json(result);
      }
      const result = await api(`/api/sources/${params.id}`, { method: 'POST', body: { enabled: action === 'enable' } });
      return json(result);
    }),
  });

  pi.registerTool({
    name: 'news_interests',
    description:
      'Профиль интересов и темы: показать, добавить тему (создаст источник Google News по ней), убрать тему.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'] },
        terms: { type: 'array', items: { type: 'string' }, description: 'Темы для add/remove' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: guard(async (_id, params = {}) => {
      if (params.action === 'list') {
        const data = await api('/api/interests');
        return json({ темы: data.terms, профиль: data.text, источников_по_темам: data.sources });
      }
      const terms = Array.isArray(params.terms) ? params.terms : [];
      if (!terms.length) throw new Error('нужны terms');
      const data = await api('/api/interests', { method: 'POST', body: { action: params.action, terms } });
      return json(data);
    }),
  });

  pi.registerTool({
    name: 'news_search',
    description: 'Поиск по накопленной ленте: заголовок, выжимка, тема. Отвечай со ссылками из результатов.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Слова для поиска' },
        limit: { type: 'integer', description: 'Сколько результатов, по умолчанию 10' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: guard(async (_id, params = {}) => {
      const data = await api(`/api/search?q=${encodeURIComponent(params.query)}&limit=${Number(params.limit) || 10}`);
      return json({ запрос: data.query, найдено: data.results.length, результаты: data.results });
    }),
  });
}
