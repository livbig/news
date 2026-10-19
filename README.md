# News Digest Bot

Telegram-бот персональных новостных сводок: RSS/TG-каналы/Reddit → дельта
потребления → LLM-сводка (Z.ai GLM) → сообщение по расписанию пользователя.
Состояние — в Supabase Postgres; процесс — long polling + внутрипроцессный
двухфазный планировщик (подготовка за 10 мин до слота, догоняющая сводка
после простоя).

Прод: Raspberry Pi OS (aarch64), systemd-юниты `awg0.service` (AmneziaWG
full-tunnel + kill-switch) и `newsbot.service` (`Restart=always`, пользователю
Raspberry Pi в локальной сети (код обновляется rsync-ом в каталог `news/`, `.env` живёт только на устройстве).

Конфигурация — переменные окружения (`.env` в корне кода, читается автоматически;
см. `.env.example`): `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `LLM_API_KEY`,
`LLM_BASE_URL`, `LLM_MODEL`, `SUPABASE_DB_URL`; опционально `BOT_IP_PIN=0`
(на Pi включено через юнит), `BOT_HEALTH_PORT` (не задаётся — health-порт не нужен).
