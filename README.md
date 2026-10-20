# News Digest Bot

Персональный агрегатор новостей в Telegram: RSS/TG-каналы/HTML → отбор → LLM-сводка →
сообщение по запросу или расписанию. Один пользователь.

## Где работает

- **Прод — Telegram Serverless (`tgcloud/`)**, приложение `app8766943850`, вебхук платформы.
  Один вызов платформы на сообщение (лимиты ~30 с / ~3 с CPU), поэтому сбор — быстрыми
  партиями, LLM — с выключенным thinking, `max_tokens=5000` (iter-38).
- **Python-бот (`bot/`, `pipeline/`) — путь отката** (Pi/Supabase/aiogram). Пока Serverless
  активен, его не запускать: два потребителя апдейтов конфликтуют.
  Исторические детали — [`docs/legacy-python-bot.md`](docs/legacy-python-bot.md).

## Документы

| Файл | Что внутри |
|---|---|
| [`AGENTS.md`](AGENTS.md) | правила работы: границы, команды, секреты, публикация |
| [`docs/PROJECT-STATE.md`](docs/PROJECT-STATE.md) | состояние на сейчас, что не проверено, следующий шаг |
| [`docs/tgcloud-migration.md`](docs/tgcloud-migration.md) | миграция на Serverless: замеры, решения, токены |
| [`docs/requirements.md`](docs/requirements.md) | FR/NFR, критерии приёмки |
| [`docs/plan.md`](docs/plan.md) | решения D1…D55, схема БД, FSM |
| [`docs/reconciliation.md`](docs/reconciliation.md) | сверка требований и реализации |
| [`docs/legacy-python-bot.md`](docs/legacy-python-bot.md) | исторический Python/Pi-контур и откат |
| [`LOG.md`](LOG.md) | журнал итераций (новое сверху) |

## Быстрый старт (Serverless)

```bash
cd ~/Desktop/ai/self/news
npm install                       # @tgcloud/cli
npm run config                    # .env → tgcloud/lib/secrets.js
npm test                          # 102 JS-теста
npm run status                    # npx tgcloud status
npm run deploy                    # config + npx tgcloud push
```

`.env` — симлинк на `~/.config/ai/env/news.env`; `.tgcloud/credentials` — на
`~/.config/ai/tgcloud/news-credentials.json`. Карта секретов — `../../docs/ENVIRONMENT.md`.

## Python-контур (откат)

```bash
python3 -m bot
BOT_TEST_PG_URL= python3 -m unittest discover -s tests -p "test_iter*.py"
```

Требуется окружение с `requirements.txt` (aiogram, httpx, feedparser, bs4, psycopg,
trafilatura). Локальный системный Python этих пакетов не имеет.

## Конфигурация

Переменные окружения — в `.env` (см. `.env.example`): `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`,
`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `SUPABASE_DB_URL`; опционально `BOT_*`
(Python-контур), `LLM_*` (thinking/effort/tokens). Секреты не коммитятся.
