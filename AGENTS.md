# News Digest Pipeline

Личный агрегатор новостей: источники (RSS/TG-каналы/HTML/X-мост) → Supabase
Postgres (М2; bot.db SQLite — архив/откат) → LLM-мега-дайджест (Z.ai GLM-5.3,
флагман D41) → Telegram-бот. ОДИН пользователь (D40): гейт `allowed()` на
TELEGRAM_CHAT_ID; мультипользовательность отклонена.

## Режим «мега-дайджест» (iter-11, 2026-09-15; план .kilo/plans/mega-digest)

- **Непрерывный сбор** (D44): фоновый `collect_loop` каждые
  BOT_COLLECT_INTERVAL=1800 c собирает все источники (rss/html/twitter — пул
  6 воркеров, tgweb строго последовательно с паузами); prep перед слотом —
  только LLM. `/digest` и «сводка сейчас» собирают по-прежнему.
- **Дайджест**: один mega-вызов GLM-5.3 (D42), системный промпт согласован
  дословно (bot/llm.py, не редактировать без пользователя), формат 3-4
  сообщения, у каждого пункта эмодзи-ссылка на первоисточник (D43);
  вход — per-source бюджет BOT_DIGEST_PER_SOURCE=15, кап
  BOT_DIGEST_MAX_ITEMS=800 (window ROW_NUMBER), без урезания контекста.
- **Онбординг = LLM-интервью** (D45): 5-8 раундов (bot/interview.py,
  кнопки «Достаточно»/«Пропустить»), итог — профиль в `users.interests_text`
  (читается промптом дайджеста), затем `llm.suggest_sources` → валидация
  make_preview (rss/html параллельно, tgweb последовательно) → мультивыбор
  40-60 источников с пагинацией. Fallback при недоступной LLM — дефолт-профиль
  + весь bot/catalog_data.json (каталог больше не кнопочные темы).
- **Добавление TG-каналов** (D48): @имя, t.me|telegram.me|dog, t.me/s/имя,
  ссылка на пост; реплай-ссылки (t.me/+…) — отдельная ошибка; можно
  переслать пост канала (форс tgweb).
- **Retention** (D47): items через BOT_RETENTION_ITEMS_DAYS=10 дней →
  надгробия `seen_hashes` (повторная вставка отбивается) и DELETE;
  digests/chat_history/seen_hashes — BOT_RETENTION_DAYS=30 дней; проход
  каждые 6 ч + на старте (`scheduler.retention_loop`).
- **Лимит источников**: BOT_MAX_SOURCES=100 на чат (D46).
- Следующая фаза (вне iter-11): миграция хостинга на Raspberry Pi —
  отдельный план (VPN full-tunnel, `BOT_IP_PIN=0`, systemd).

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

## Прод-хостинг: HF Space (с 2026-09-14/15; Mac — откат)

- Прод: Hugging Face Space `<user>/news` (приватный, sdk: docker, app_port
  7860). Процесс тот же: `python3 -m bot` (Dockerfile, TZ=Europe/Moscow).
  Состояние — только Supabase; локальные файлы контейнера эфемерны.
- Автодеплой: push в origin main (публичный снапшот) → GH Action `deploy`
  → upload_folder в Space → пересборка. Логи: Space → Logs (только владелец).
- Секреты/vars Space: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, LLM_API_KEY,
  LLM_BASE_URL, LLM_MODEL, SUPABASE_DB_URL, TZ=Europe/Moscow,
  BOT_HEALTH_PORT=7860, BOT_IP_PIN=0 (облаку пиннинг не нужен; по умолчанию
  на Mac включён). GH secrets: HF_TOKEN; GH vars: HF_REPO_ID, HF_SPACE_HOST.
- Keep-alive: GH Action `keepalive` (cron */20) пингует /health с HF_TOKEN —
  приватный Space на free засыпает через 48 ч без HTTP-входящего. /health —
  тред в bot/__main__ (BOT_HEALTH_PORT); без живого порта Space рестартует
  контейнер по кругу.
- Рестарт Space: Settings → Factory reboot (или pause/resume). Рестарты
  безопасны: catch-up дошлёт пропущенную сводку (FR-12), FSM-диалоги
  сбросятся (как и на Mac).
- Откат на Mac (cold standby): plist сохранён. Порядок: Space → Settings →
  Pause Space (ЕДИНСТВЕННЫЙ getUpdates, иначе 409) →
  `launchctl enable gui/501/com.fifth.newsbot` (если был disabled) →
  `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.fifth.newsbot.plist`.
  Возврат на Space: `launchctl bootout gui/501/com.fifth.newsbot` +
  `launchctl disable gui/501/com.fifth.newsbot` → Resume Space.
- Ручные CLI-прогоны pipeline (run/digest) — на Mac с остановленным агентом
  (SQLite-блокировки, R5); news.db остаётся только на Mac.

## Откат-наследие: launchd (историческое, для отката)

- Агент: `~/Library/LaunchAgents/com.fifth.newsbot.plist`, метка `com.fifth.newsbot`,
  с 2026-09-13 запускает нового бота: `python3 -m bot` (миграция И7, решение D24).
  С 2026-09-15 ОТКЛЮЧЁН (прод переехал на HF Space): `launchctl disable` +
  bootout; plist сохранён для отката (см. раздел выше).
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
2. Каждый пункт сводки содержит ссылку на первоисточник (эмодзи-ссылка, D43); сводка на русском.
3. Падение одного фида не валит прогон: ошибка пишется в logs/run.log с URL фида.
4. Без LLM_API_KEY / TELEGRAM_TOKEN всё работает end-to-end (mock-сводка, вывод в stdout).
5. Одно сообщение Telegram ≤ 4000 символов (разбиение по абзацам).
6. Дайджест — один mega-вызов (D42); деградация LLM → 2 попытки → mock с пометкой.
7. Онбординг-интервью при недоступной LLM даёт fallback (дефолт-профиль + каталог).
8. Retention: items >10 дней исчезают и не возвращаются (seen_hashes); старые digests/chat_history чистятся.
9. `BOT_TEST_PG_URL= python3 -m unittest discover -s tests` зелёный на sqlite и на PG.

## Принципы

Следуй karpathy-guidelines.md (в корне репозитория): минимальный diff, никаких
спекулятивных абстракций, каждое изменение сопровождается прогоном критериев выше.

## Приоритеты пользователя (дефолт-профиль, до LLM-интервью онбординга)

- Глубоко: драгметаллы (Au, Pt, Pd), USD/RUB, рынок США, инвест-идеи (вкл. wallstreetbets),
  IPO и акции AI/робототехники/биотеха, новые AI-модели, промпт-инжиниринг
- Кратко: геополитика (только направление, «в какую сторону весы»)
- Очень кратко: крипта

После интервью профиль живёт в `users.interests_text` и подставляется в
промпт дайджеста вместо дефолта (`bot/llm.py::DEFAULT_INTERESTS`).
