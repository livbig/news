# News Digest Pipeline

Личный агрегатор новостей: RSS-фиды → Supabase Postgres (М2; bot.db SQLite — архив/откат) → LLM-сводка (Z.ai GLM) → Telegram-бот.

## Команды

- `python3 -m pipeline run` — собрать новости в news.db
- `python3 -m pipeline digest` — сформировать и отправить сводку (без токена TG — сохранить в digests/ и вывести в stdout)
- `python3 -m pipeline check` — проверка здоровья всех фидов
- `python3 -m pipeline chatid` — показать chat_id чатов, писавших боту (нужен доступ к api.telegram.org)
- `BOT_TEST_PG_URL= python3 -m unittest discover -s tests` — регрессия на sqlite; без пустого префикса `:memory:` тестов идёт в PG (docker `news-pg`, порт 54329; в CI — service container)
- `python3 scripts/migrate_sqlite_to_pg.py` — перенос bot.db → Supabase (идемпотентен)

Лог работы: `LOG.md` — обновлять при каждой итерации.

## GitHub / публикация (ВНИМАНИЕ)

- Локальная `main` — полная приватная история (LOG/AGENTS/docs/feeds/TESTPLAN).
  **НЕ пушить её никуда.** Публикация — только через ветку `public` (orphan-снапшот
  безопасных путей: bot/, pipeline/, tests/ без TESTPLAN.md, requirements.txt,
  .github/, .gitignore, .env.example) в https://github.com/livbig/news (ПУБЛИЧНЫЙ;
  у livbig Trade controls запрещает приватные репо).
- Обновить публикацию (ветку public пересобирать ЦЕЛИКОМ через orphan):
  `git checkout --orphan public2` → `git rm -rf --cached . -q` →
  `git add bot pipeline tests requirements.txt .github .gitignore .env.example scripts` →
  `git rm --cached -q tests/TESTPLAN.md` → commit → `git branch -M public` →
  `git push -f origin public:main` → `git checkout -f main`.
  НЕ делать `git checkout public` + add: worktree откатывается к СТАРОМУ
  снапшоту (ошибка migr-2; ловится проверкой `git diff --stat HEAD main` до пуша
  — в безопасных путях должен отличаться только TESTPLAN.md).
- Аккаунт gh: ТОЛЬКО livbig — проект целиком в нём; другие gh-аккаунты вылогинены
  из CLI (требование пользователя 2026-09-13). Git-креденшелы привязаны к
  активному gh-аккаунту (`gh auth setup-git`) — при 403 проверить `gh auth status`.
  Локальная git identity репо — livbig (глобальная ~/.gitconfig не трогается).
- Перед каждым пушем — скан снапшота на идентификаторы (chat_id, @usernames,
  /Users/, токен-паттерны): `git grep -nE "603522950|cumulativenewsbot|/Users/|gho_"`.

## Бот-демон (launchd, автозапуск при входе в систему)

- Агент: `~/Library/LaunchAgents/com.fifth.newsbot.plist`, метка `com.fifth.newsbot`,
  с 2026-09-13 запускает нового бота: `python3 -m bot` (миграция И7, решение D24).
  Один потребитель getUpdates: перед ручным запуском бота останови агент (иначе 409).
- Сводки per-user, двухфазно: подготовка (сбор + LLM) за 10 мин до слота,
  отправка ровно в слот; расписание каждого чата — в `/settings` (bot.db,
  `users.send_times`); после сна Mac — одна догоняющая сводка за всё окно.
- Диалог: свободный текст боту (без команды) — вопрос к LLM с контекстом ленты
  и историей чата (bot.db, chat_history).
- Остановить агента (для отладки): `launchctl bootout gui/501/com.fifth.newsbot`
- Ручной прогон с живым выводом: `python3 -m bot`
- Запустить агент снова: `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.fifth.newsbot.plist`
- Перезапуск после правок кода: `launchctl kickstart -k gui/501/com.fifth.newsbot`
- Статус: `launchctl print gui/501/com.fifth.newsbot | grep state`
- Логи: `logs/run.log` (основной, файловый хендлер бота), `logs/launchd.out`
  (дубль stdout), `logs/launchd.err` (ранние крэши). Код правится прямо в `bot/` —
  агент подхватывает изменения после перезапуска (kickstart).
- Откат на старого бота (rollback И7): в plist `ProgramArguments` вернуть
  `/opt/homebrew/bin/python3`, `-m`, `pipeline`, `bot` → `bootout` + `bootstrap`.
  Код `pipeline/` сохранён (CLI run/digest/check живы); `news.db` и `bot.db`
  раздельны — откат ничего не теряет.
- Ручные CLI-прогоны pipeline (run/digest) — только при остановленном агенте
  (SQLite-блокировки, R5).
- Mini App (М3, FR-17): УДАЛЁН 2026-09-14 (cleanup-A/B/C: `bot/webapp.py`,
  `bot/webauth.py`, `bot/pgstorage.py`, `api/`, `public/`, `vercel.json`).
  Vercel-проект `news` и домен `news-livbig.vercel.app` удалены; web_app
  меню-кнопка прод-бота сброшена на стандартную. Решение — отложить; возврат =
  отдельная фаза 5 (активы: `debug_auth_log` в Supabase с реальным initData;
  полная реализация в git-истории до `658281c`).

## Конфигурация

- `feeds.txt` — строки `URL|категория`. Категории: `metals_fx, usmarket, wsb, ipo_ai_bio, tech_ai, macro, geopolitics, crypto`
- `.env` — ключи (см. `.env.example`): LLM_API_KEY, LLM_MODEL, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID

## Критерии успеха (проверять при каждом изменении)

1. Повторный `python3 -m pipeline run` не создаёт дублей (UNIQUE по url_hash от URL+заголовка).
2. Каждый пункт сводки содержит ссылку на первоисточник; сводка на русском.
3. Падение одного фида не валит прогон: ошибка пишется в logs/run.log с URL фида.
4. Без LLM_API_KEY / TELEGRAM_TOKEN всё работает end-to-end (mock-сводка, вывод в stdout).
5. Одно сообщение Telegram ≤ 4000 символов (разбиение по абзацам).

## Принципы

Следуй karpathy-guidelines.md (в корне репозитория): минимальный diff, никаких
спекулятивных абстракций, каждое изменение сопровождается прогоном критериев выше.

## Приоритеты пользователя (учитывать в промпте LLM)

- Глубоко: драгметаллы (Au, Pt, Pd), USD/RUB, рынок США, инвест-идеи (вкл. wallstreetbets),
  IPO и акции AI/робототехники/биотеха, новые AI-модели, промпт-инжиниринг
- Кратко: геополитика (только направление, «в какую сторону весы»)
- Очень кратко: крипта
