# AGENTS.md — news (новостной дайджест в Telegram)

Правила для людей и ИИ-агентов. Родительские правила — `../../AGENTS.md` и `../AGENTS.md`;
при конфликте приоритет у этого файла. Язык документации, комментариев и сообщений — русский.

## 1. Что это и где работает

Личный агрегатор новостей: RSS/TG-каналы/HTML/Reddit → отбор → LLM → сообщение в Telegram.
Один пользователь (`TELEGRAM_CHAT_ID`), гейт fail-closed.

- **Текущий прод — Telegram Serverless (`tgcloud/`)**, приложение `app8766943850`, приём
  апдейтов через вебхук платформы. С 2026-10-19; вебхук восстановлен 2026-10-19 (iter-36).
- **Python-контур (`bot/`, `pipeline/`) — путь отката**, не второй прод. Пока Serverless
  активен, Python-бот не запускать: два потребителя апдейтов конфликтуют.
  Исторические детали (Pi, launchd, mega-дайджест) — [`docs/legacy-python-bot.md`](docs/legacy-python-bot.md).
- Состояние и остаток работ — [`docs/PROJECT-STATE.md`](docs/PROJECT-STATE.md).

## 2. Структура

```
tgcloud/                  ТЕКУЩИЙ прод (JS-модули, без npm в рантайме)
  handlers/message.js     приём сообщений: гейт → интенты → сбор → отбор → LLM → отправка
  handlers/callback_query.js  кнопки
  lib/                    collect, rss, html, digest, llm, prompts, intents, interests,
                          render, store, settings, telegram, text, tgparse
  lib/secrets.js          СГЕНЕРИРОВАНО scripts/build-config.mjs из .env (gitignored)
  schema.js               8 таблиц платформенной SQLite (без FK)
bot/                      Python-бот (откат): aiogram 3.x, long polling, Supabase/sqlite
pipeline/                 старый CLI (откат): run/digest/check/chatid, news.db, feeds.txt
tests/test_iter*.py       Python-регрессия (162 теста по LOG iter-37)
tests/js/*.test.js        JS-тесты текущего прода (102, проверено 20.10.2026)
scripts/build-config.mjs  .env → tgcloud/lib/secrets.js
scripts/migrate_sqlite_to_pg.py  bot.db → Supabase (идемпотентен)
docs/                     требования, план, решения, миграция, ревью, legacy
.kimi-code/plans/         исторические планы агентов (gitignored)
Dockerfile                наследие HF Space, не используется
vpn.conf                  WireGuard для отката на Pi (секрет, gitignored)
```

## 3. Команды

### Serverless (текущий прод)

Перед первым запуском — `npm install`: без локального `@tgcloud/cli` команда `npx tgcloud`
скачает из реестра чужой пакет `tgcloud` и упадёт с `unknown command 'status'`.

```bash
cd ~/Desktop/ai/self/news
npm run config                 # .env → tgcloud/lib/secrets.js (значения не печатает)
npm run status                 # npx tgcloud status: привязка, незадеплоенные модули
npm test                       # node --test 'tests/js/*.test.js' — 102 теста
npm run deploy                 # config + npx tgcloud push
npx tgcloud migrate --safe     # схема БД; сначала --dry-run, если есть сомнения
npm run run                    # npx tgcloud run handlers/message (локальный прогон хендлера)
node scripts/verify-link.mjs   # проверка связки: токен бота, .tgcloud/credentials
```

### Python-контур (откат)

```bash
python3 -m bot                 # прод-бот (без токена — mock-прогон)
python3 -m pipeline run        # собрать новости в news.db
python3 -m pipeline digest     # сводка (без токена — в digests/ и stdout)
python3 -m pipeline check      # здоровье фидов
BOT_TEST_PG_URL= python3 -m unittest discover -s tests -p "test_iter*.py"
```

Локальный `python3` без `requirements.txt` тесты не пройдёт (нет `feedparser` и др.).
Для Python-регрессии нужно окружение с зависимостями (Pi/venv); в этой сессии она
**не прогонялась** — это указано в `PROJECT-STATE.md`.

## 4. Как работает Serverless-версия (границы платформы)

- Один вызов платформы на сообщение. Лимиты: **~30 с wall time, ~3 с CPU**, нет `setTimeout`,
  `setInterval`, `AbortSignal`, `res.body.getReader()`, конструктора `URL`.
- Поэтому: быстрый сбор (rss/twitter) ≤ 16 источников за вызов, дедлайн ~5 с; отбор
  ≤ 25 пунктов / 45k символов, per-source 4, окно 7 дней; LLM с **выключенным thinking**,
  `max_tokens=5000` (iter-38); медленный источник (канал/сайт) — после отправки сводки,
  в остаток бюджета, его пункты попадут в следующую.
- `stop_reason=max_tokens` больше не роняет вызов: обрезанный ответ уходит как сводка с пометкой,
  при пустом тексте — один повтор с половиной пунктов, затем честная ошибка.
- Таймеров нет: «прогресс» — сообщение-статус между шагами, не стрим токенов.
- Данные: платформенная SQLite (8 таблиц). Перенесены источники и профиль; история `items`
  из Supabase **ещё не перенесена** (`docs/tgcloud-migration.md` §13).
- HTML-источники: свой разбор (`lib/html.js`), без DOM/bs4; `URL` недоступен — ссылки
  разбираются вручную.

Полная история решений и замеров — `docs/tgcloud-migration.md`; хронология — `LOG.md`.

## 5. Секреты и токены

Канонические файлы — вне репозитория (см. `../../docs/ENVIRONMENT.md`):

| Что | Где | Зачем |
|---|---|---|
| `news.env` | `~/.config/ai/env/news.env` (в проекте симлинк `.env`) | LLM, Telegram, Supabase |
| CLI Access token | `~/.config/ai/tgcloud/news-credentials.json` (симлинк `.tgcloud/credentials`) | `tgcloud push/migrate/run` |
| Копия токена бота | `~/.config/ai/tgcloud/news-bot-token.txt` (симлинк `.secrets/bot-token.txt`) | `verify-link.mjs`, ручной вебхук, откат |
| `vpn.conf` | в проекте, gitignored | откат Python-бота на Pi |

- Токен бота (`12345:AA…`) и CLI-токен (`app<id>:<secret>`) — **разные**, не взаимозаменяемы.
- При смене токена бота обновить и `news.env`, и `news-bot-token.txt`.
- Секреты не печатать, не коммитить, не передавать в чат. Проверка — `bash ../../scripts/env.sh check`.
- `GITHUB_*` в `news.env` — наследие удалённого воркера; текущий Serverless их не использует.

## 6. Тестирование

- JS: `npm test` — 102 теста, зелёные (20.10.2026). Покрывают чанки, парсинг каналов,
  интенты, окно/отбор, дедуп, рендер, гейт.
- Python: `tests/test_iter*.py`, 162 по LOG iter-37. Требуют `requirements.txt`; в CI —
  sqlite + PG service container. Не прогонять в одном процессе с ботом на той же БД.
- Ручная приёмка диалогов — в чате с ботом; автоматизированного e2e нет.
- Критерии успеха — старый список в `docs/requirements.md` и `docs/PROJECT-STATE.md`;
  для Serverless добавились: один вызов ≤ 30 с, сводка не врёт про период, чужие chat_id
  молчат (fail-closed), обрезка не убивает вызов.

## 7. Публикация и git

- Локальная `main` — полная приватная история (`LOG/AGENTS/docs/feeds/TESTPLAN`).
  **Не пушить `main` никуда.**
- Публикация — только ветка `public` (orphan-снапшот безопасных путей: `tgcloud/`, `bot/`,
  `pipeline/`, `tests/` без `TESTPLAN.md`, `requirements.txt`, `package.json`, `.github/`,
  `.gitignore`, `.env.example`) в `https://github.com/livbig/news` (ПУБЛИЧНЫЙ).
- Пересборка `public` — целиком через orphan; проверка перед пушем:
  `git diff --stat HEAD main` (в безопасных путях должен отличаться только `TESTPLAN.md`)
  и скан на идентификаторы: `git grep -nE "603522950|cumulativenewsbot|/Users/|gho_"`.
- Перед каждым пушем — скан снапшота на секреты и личные пути.
- Аккаунт gh — только `livbig`; при 403 проверить `gh auth status`.

## 8. Красные линии

1. **Один потребитель апдейтов.** Не запускать Python-бот, пока активен вебхук Serverless,
   и наоборот. Перед переключением — остановить второй контур.
2. **Не пушить `main`.** Публикация — только `public`-снапшот.
3. **Не коммитить** `.env`, `.secrets/`, `.tgcloud/`, `vpn.conf`, `*.db`, `logs/`, `digests/`,
   `tgcloud/lib/secrets.js`, `node_modules/`.
4. **Не менять системный промпт** без пользователя: `tgcloud/lib/prompts.js` и
   `bot/llm.py::SYSTEM_PROMPT` согласованы дословно.
5. **Не экономить на качестве сводки** без решения пользователя: `effort`/`max_tokens`
   меняются осознанно, с замером.
6. **Чужой chat_id не получает ничего** (fail-closed). Не ослаблять гейт.
7. **Секреты** — только через канонические файлы; в логи и ответы не печатать.

## 9. Документация

- Изменилось поведение → обновить `docs/PROJECT-STATE.md` и `LOG.md` (новое сверху).
- Новое решение → `docs/plan.md` (D-номера) или `docs/tgcloud-migration.md`.
- Историю не выбрасывать: устаревшее переносится в `docs/legacy-*.md` с пометкой.
- Ссылки на прод, тесты и лимиты проверять командой, а не по памяти.
