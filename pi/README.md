# Новостной агрегатор на Raspberry Pi

Личный агрегатор новостей одного читателя: собирает RSS и Telegram-каналы, разбирает каждый
пункт (выжимка, важность, темы), дважды в день присылает мега-сводку (09:00 и 21:00), а в
остальное время отвечает в чате как обычный ассистент — с памятью, голосом, файлами и правом
чинить себя.

Прод — **этот каталог** (`pi/`), Mac — источник правды для кода. Прежний контур на Telegram
Serverless (`../tgcloud/`) остановлен 2026-11-11: вебхук снят, апдейты забирает мост.

## Что работает

| Что | Где | Чем подтверждено |
|---|---|---|
| служба: сбор каждые 20 мин, анализ каждые 5 мин, сводки 09:00/21:00 | `newsd.service` | `journalctl -u newsd`, `/api/state` |
| живой чат: вопрос → pi-агент с инструментами `news_*` | `news-bridge.service` | прогон `pi -p` в зоне (2026-11-11) |
| фронтенд: сводки, источники, интересы, поиск | `http://<pi>:8097/?token=…` | curl: 200 на index/app.js/style.css, API под токеном |
| бэкап 03:55, уборка 04:20, сторож каждые 10 мин | `news-*.timer` | `systemctl start news-*.service` → журнал |
| тесты | `server` 171, `app` 21, `bridge` 222 | `npm test` на Pi, 2026-11-11 |

## Как это устроено

```
Telegram ←→ news-bridge (мост Дворецкого, зона nw-livbig)
                │  инструменты news_* по HTTP
                ▼
           newsd (User=newsd)  ──►  /srv/news/data/news.db (node:sqlite)
             ├─ сбор: rss / tgweb / html, 52 рабочих источника
             ├─ анализ: выжимка + важность 1–5 + темы для каждого пункта
             ├─ сводки: 09:00 и 21:00 (12 часов от прошлой), отправка чанками ≤4000
             └─ API + фронтенд на :8097 (токен в заголовке или ?token=)
```

Один писатель в базу — служба. Агент и фронтенд ходят только через API: нет двух процессов,
которые портят один SQLite.

## Команды

```bash
# деплой с Mac (идемпотентен, базу и правила зоны не перезаписывает)
bash pi/deploy/deploy.sh

# тесты (Mac)
npm --prefix pi/server test && npm --prefix pi/app test

# состояние и ручные действия на Pi
ssh pi 'sudo journalctl -u newsd -n 30 --no-pager'
ssh pi 'sudo systemctl start news-task@collect-now.service'      # разовый сбор
ssh pi 'sudo systemctl start news-task@digest-now.service'       # разовая сводка
ssh pi 'sudo systemctl start news-task@sources-status.service'   # здоровье источников
ssh pi 'sudo systemctl restart newsd news-bridge'
```

Токен API — `/etc/news/news.env` на Pi (`NEWS_API_TOKEN`), он же в `~/.config/ai/env/news.env`
на Mac. Секреты в git и в чат не попадают.

## Где что лежит

| Путь | Что |
|---|---|
| `server/` | служба: сбор, анализ, сводки, API, фронтенд, тесты |
| `bridge/` | форк моста Дворецкого (чат, голос, файлы, память) |
| `app/` | расширения pi: память зоны + инструменты `news_*`, скрипты бэкапа/сторожа/уборки |
| `users/livbig-agents.md` | правила агента-агрегатора (живут в зоне, агент их дописывает) |
| `deploy/` | юниты systemd, sudoers, скрипт деплоя |

Подробности — `AGENTS.md` (правила) и `docs/PROJECT-STATE.md` (состояние и следующий шаг).
