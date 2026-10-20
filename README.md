# News Digest Bot

Персональный новостной дайджест в Telegram: собирает RSS, Telegram-каналы, HTML-страницы
и Reddit-фиды, отбирает свежее, сжимает через LLM и присылает готовую сводку со ссылками
на первоисточники.

Проект рассчитан на **одного пользователя**: доступ закрыт по `TELEGRAM_CHAT_ID`,
все остальные чаты игнорируются (fail-closed).

## Что умеет

- сводка по запросу и по расписанию;
- период из текста: «за 3 дня», «вчера», «с 12 по 18 октября»;
- темы и интересы: «углубиться в робототехнику», «убери золото»;
- до 100 источников на чат: RSS, Telegram-каналы, HTML, Reddit;
- полные тексты и LLM-выжимки, ссылки на первоисточники;
- анти-дедупликация: один и тот же материал не приходит дважды;
- retention: старые новости и сводки удаляются автоматически;
- статистика источников и ошибок сбора.

## Архитектура

Текущий прод — **Telegram Serverless** (`tgcloud/`): один вызов платформы на сообщение.

```
Telegram
   │ update
   ▼
handlers/message.js
   ├─ гейт единственного пользователя (fail-closed)
   ├─ интенты: сводка / период / интересы / источники / статистика
   ├─ быстрый сбор: RSS, Twitter-мост, ≤ 16 источников, дедлайн ~5 с
   ├─ отбор: ≤ 25 пунктов, ≤ 45k символов, окно 7 дней, анти-дедуп
   ├─ LLM: DeepSeek, thinking off, max_tokens 5000
   ├─ отправка чанками ≤ 4000 символов
   └─ после сводки: один медленный источник в остаток бюджета
```

Ограничения платформы: **~30 с wall time, ~3 с CPU**, нет `setTimeout`, `setInterval`,
`AbortSignal`, потокового чтения `res.body`. Поэтому сбор идёт быстрыми партиями, а не
одним проходом по всем источникам.

`bot/` и `pipeline/` — **Python-контур для отката** (aiogram, long polling, Supabase/SQLite).
Пока Serverless активен, его не запускать: два потребителя апдейтов конфликтуют.

## Структура

```
tgcloud/
  handlers/        message.js, callback_query.js
  lib/             collect, rss, html, digest, llm, prompts, intents,
                   interests, render, store, settings, telegram, text, tgparse
  schema.js        8 таблиц платформенной SQLite
bot/               Python-бот (откат)
pipeline/          старый CLI (откат)
tests/             Python- и JS-тесты
scripts/           build-config.mjs, verify-link.mjs, миграция SQLite → Postgres
docs/              требования, план, миграция, исторические заметки
```

## Быстрый старт

### Serverless-версия

```bash
git clone https://github.com/livbig/news.git
cd news
npm install                 # @tgcloud/cli

cp .env.example .env        # заполнить TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, LLM_API_KEY
npm run config              # .env → tgcloud/lib/secrets.js (в git не попадает)

npm test                    # 102 JS-теста
npm run status              # npx tgcloud status
npm run deploy              # config + npx tgcloud push
```

Первый деплой: `npx tgcloud login` (CLI Access token из BotFather → Serverless),
затем `npx tgcloud migrate --safe`.

### Python-контур (откат)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python3 -m bot
```

## Конфигурация

Все значения — в `.env` (не коммитится). Основные переменные:

| Переменная | Назначение |
|---|---|
| `TELEGRAM_TOKEN` | токен бота от @BotFather |
| `TELEGRAM_CHAT_ID` | единственный разрешённый чат |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | провайдер и модель |
| `LLM_THINKING`, `LLM_EFFORT`, `LLM_MAX_TOKENS` | режим генерации |
| `SUPABASE_DB_URL` | Postgres для Python-контура (пусто → SQLite) |
| `BOT_*` | интервалы, лимиты, retention Python-контура |

Полная схема — в `.env.example`.

## Тесты

```bash
npm test
# Python (нужно окружение с requirements.txt):
BOT_TEST_PG_URL= python3 -m unittest discover -s tests -p "test_iter*.py"
```

JS-тесты покрывают чанки, парсинг каналов, интенты, окно/отбор, дедуп, рендер и гейт.
Python-тесты гоняются на SQLite и Postgres (в CI — service container).

## Безопасность

- секреты — только в `.env` и сгенерированном `tgcloud/lib/secrets.js`, оба в `.gitignore`;
- `.env`, `.secrets/`, `.tgcloud/`, `vpn.conf`, базы и логи в репозиторий не попадают;
- чужой `chat_id` не получает ничего: гейт закрыт по умолчанию;
- бот не предназначен для публичного многопользовательского использования.

## Ограничения

- «полная неделя за один вызов» невозможна: платформа обрывает вызов на ~30 с, окно
  честно усекается с пометкой;
- между сообщениями бот не собирает новости: сбор идёт в момент запроса;
- быстрые источники (RSS/Twitter) обрабатываются в сводке, медленные (каналы/HTML) —
  после её отправки, их пункты попадают в следующую;
- автоматизированного e2e нет: диалоговые сценарии проверяются вручную.

## Документация

Полные требования, решения, схема БД и журнал итераций ведутся в локальной копии проекта
(`docs/`, `LOG.md`). В публичном репозитории — код, тесты и этот README.

## Статус

Работает в проде на Telegram Serverless. 102 JS-теста, Python-контур — 162 теста
(по журналу итераций). Проект личный; лицензия не задана.
