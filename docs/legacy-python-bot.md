# Python-бот и Raspberry Pi — исторический контур (откат)

> **Историческое.** Это не текущий прод. С 2026-10-19 прод — Telegram Serverless
> (`tgcloud/`, приложение `app8766943850`), см. `../AGENTS.md` и `../docs/PROJECT-STATE.md`.
> Python-код (`bot/`, `pipeline/`) сохранён как путь отката до приёмки Serverless-версии.

## Что это было

Один долгоживущий процесс `python3 -m bot` (aiogram 3.x, long polling) на Raspberry Pi 4
в домашней сети. Внутри — asyncio-планировщик слотов, непрерывный сбор источников,
LLM-мега-дайджест (DeepSeek `deepseek-flash`, `effort=max`), Supabase Postgres
(`bot.db` — локальный архив), retention, онбординг-интервью.

## Прод-хостинг: Raspberry Pi (2026-09-19 — 2026-10-19)

- Прод: Raspberry Pi 4 в LAN, SSH `minibrick@192.168.88.73` (ключ ed25519 с Mac;
  DHCP может сменить IP — при недоступности пересканировать: ping-свип /24 + `arp -a`,
  фильтр MAC-вендоров `dc:a6:32` и др.). Пользователь ОС — `minibrick`, hostname `minibrick`;
  sudo — NOPASSWD (`/etc/sudoers.d/010_pi-nopasswd`).
- Юниты systemd (Pi): `awg0.service` — AmneziaWG full-tunnel, userspace `awg-go`
  (v3.1.20260828, собран из github.com/amnezia-vpn, бинарник `/usr/local/bin/awg-go`;
  repo.amnezia.org из РФ недоступен), `Restart=always`, конфиг
  `/etc/amnezia/amneziawg/awg0.conf` (секреты! из `vpn.conf` Mac), kill-switch — nft-таблица
  `inet awgks` (`awgks.nft` рядом; endpoint 195.58.46.21:9987 захардкожен в правила — при смене
  endpoint править и конфиг, и nft), скрипты `awg0-configure.sh`/`awg0-deconfigure.sh`;
  и `newsbot.service` — `Requires=awg0.service`, `User=minibrick`,
  `WorkingDirectory=/home/minibrick/news`, venv, `BOT_IP_PIN=0`, `TZ=Europe/Moscow`,
  `Restart=always`.
- Код на Pi: `/home/minibrick/news/` (bot/, pipeline/, tests/, venv/, `.env` — ТОЛЬКО чистые
  `KEY=VALUE`, inline-комментарии load_env не срезает).
- Обновление: с Mac
  `rsync -aL --exclude='__pycache__' -e ssh bot pipeline requirements.txt .env minibrick@192.168.88.73:news/`
  (`-L` обязателен: локальный `.env` — симлинк на `~/.config/ai/env/news.env`; без `-L` на Pi
  уедет битый симлинк. Копия `.env` на Pi — реальный файл с секретами, права 600)
  (при изменении тестов — и `tests`) → `sudo systemctl restart newsbot`.
- Логи: journald (`journalctl -u newsbot -f`, `-u awg0`) + `~/news/logs/run.log`;
  ротация `/etc/logrotate.d/newsbot` (weekly, rotate 4, compress — SD-карта).
- Kill-switch: при поднятом туннеле весь не-LAN/не-tunnel трафик дропается (nft); краш awg-go →
  интерфейс исчезает, правила остаются, трафик НЕ утекает в домашний IP (проверено kill -9:
  блокировка до автоперезапуска ~5 c).
- Регрессия на Pi: `cd ~/news && BOT_TEST_PG_URL= venv/bin/python -m unittest
  discover -s tests -p "test_iter*.py"` → 153/153 (2026-10-01, iter-20; до этого 149/149 на
  iter-19, 138/138 на iter-18); PG-смоук через туннель — OK.
- Откат на Mac (cold standby): plist `com.fifth.newsbot` сохранён, launchd disabled.
  **Перед запуском Python-бота остановить Serverless-вебхук** (иначе два потребителя апдейтов).
  Порядок на Mac: `launchctl enable gui/501/com.fifth.newsbot` →
  `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.fifth.newsbot.plist`.
  Возврат на Pi: `launchctl bootout` + `disable` → `sudo systemctl start newsbot`.
- HF Space: демонтирован 2026-09-19 (workflows `deploy.yml`/`keepalive.yml` удалены,
  `tests.yml` остался). `Dockerfile` в репо — наследие этого хостинга. Историческое.
- Ручные CLI-прогоны pipeline (run/digest) — на Mac с остановленным агентом
  (SQLite-блокировки, R5); `news.db` остаётся только на Mac, на Pi не запускать.

## launchd на Mac (историческое, для отката)

- Агент: `~/Library/LaunchAgents/com.fifth.newsbot.plist`, метка `com.fifth.newsbot`,
  с 2026-09-13 запускает `python3 -m bot` (миграция И7, решение D24). С 2026-09-19 выключен;
  plist сохранён для отката. 2026-09-30 абсолютные пути переписаны под перенос
  (`…/ai/news` → `…/ai/self/news`), состояние `disabled` сохранено.
- Остановить: `launchctl bootout gui/501/com.fifth.newsbot`
- Запустить: `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.fifth.newsbot.plist`
- Перезапуск после правок: `launchctl kickstart -k gui/501/com.fifth.newsbot`
- Статус: `launchctl print gui/501/com.fifth.newsbot | grep state`
- Логи: `logs/run.log` (основной), `logs/launchd.out`, `logs/launchd.err`.
- Сводки per-user, двухфазно: подготовка за 10 мин до слота, отправка ровно в слот;
  расписание каждого чата — в `/settings` (bot.db, `users.send_times`); после сна Mac —
  одна догоняющая сводка за всё окно.
- Диалог: свободный текст боту — вопрос к LLM с контекстом ленты и историей чата.
- Откат на старого бота (rollback И7): в plist `ProgramArguments` вернуть
  `/opt/homebrew/bin/python3`, `-m`, `pipeline`, `bot` → `bootout` + `bootstrap`.
  Код `pipeline/` сохранён (CLI run/digest/check живы); `news.db` и `bot.db` раздельны.

## Mega-дайджест Python-версии (iter-11…21, 2026-09-15…10-01)

- Непрерывный сбор (D44): `collect_loop` каждые `BOT_COLLECT_INTERVAL=1800` c собирает все
  источники (rss/html/twitter — пул 6 воркеров, tgweb последовательно); prep перед слотом —
  только LLM.
- Один mega-вызов на сводку (D42): DeepSeek `deepseek-flash`, anthropic-эндпоинт
  `api.deepseek.com/anthropic`, `LLM_EFFORT=max`, `LLM_MAX_TOKENS=96000`, системный промпт
  согласован дословно (`bot/llm.py`, не редактировать без пользователя).
- Вход: per-source `BOT_DIGEST_PER_SOURCE=15`, кап `BOT_DIGEST_MAX_ITEMS=800`,
  `BOT_DIGEST_MAX_CHARS=600000`; пункт — «ВЫЖИМКА:» (LLM-выжимка из gist) или «ТЕКСТ:»
  (выдержка ≤ `BOT_DIGEST_TEXT_CAP`).
- Ретрай-лестница: после `LLMTruncatedError` вторая попытка с `effort=high`; `stop_reason=max_tokens`
  = сбой, не сводка; при сбое LLM mock не доставляется — пользователь получает «⚠️ …».
- Первая строка дайджеста — детерминированный заголовок «🎯 ГЛАВНОЕ ЗА ПЕРИОД» от кода
  (`bot/digest.py::_period_header`).
- Полные тексты: TG-посты и content фидов в `items.text` (кап 4000); недостающее докачивается
  `bot/enrich.py` (trafilatura) и сжимается map-стадией в `items.gist`.
- Онбординг = LLM-интервью (D45), 5–8 раундов, профиль в `users.interests_text`.
- Retention (D47): items 10 дней → надгробия `seen_hashes` и DELETE; digests/chat_history/
  seen_hashes — 30 дней; проход каждые 6 ч + на старте.
- Лимит источников `BOT_MAX_SOURCES=100` (D46).
- Анти-дедуп прямых повторов: `db.consumed_keys` + фильтр в `db.pending_items` (iter-19).

## Что удалено и не возвращается без решения

- **Mini App (М3, FR-17)** удалён 2026-09-14 (`bot/webapp.py`, `bot/webauth.py`,
  `bot/pgstorage.py`, `api/`, `public/`, `vercel.json`); Vercel-проект `news` и домен
  `news-livbig.vercel.app` удалены. Возврат = отдельная фаза 5 (активы в git-истории до `658281c`).
- **GitHub-воркер и поллер** (2026-10-19): `scripts/worker.mjs`, `scripts/poll.mjs`,
  `.github/workflows/{digest,poll}.yml`, `endpoints/{select,ingest,jobState,pollState}` удалены.
  Апдейты приходят только через вебхук платформы.
