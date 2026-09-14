---
title: News Digest Bot
emoji: 📰
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# News Digest Bot

Telegram-бот персональных новостных сводок: RSS/TG-каналы/Reddit → дельта
потребления → LLM-сводка (Z.ai GLM) → сообщение по расписанию пользователя.
Состояние — в Supabase Postgres; процесс — long polling + внутрипроцессный
двухфазный планировщик (подготовка за 10 мин до слота, догоняющая сводка
после простоя).

Запуск: `python3 -m bot` (см. `bot/README`-строку в `bot/__main__.py`).
Конфигурация — переменные окружения (см. `.env.example`):
`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `LLM_API_KEY`, `LLM_BASE_URL`,
`LLM_MODEL`, `SUPABASE_DB_URL`, `TZ`, `BOT_HEALTH_PORT`, `BOT_IP_PIN=0`
(облако), `BOT_HEALTH_PORT=7860`.
