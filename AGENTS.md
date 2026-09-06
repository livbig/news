# News Digest Pipeline

Личный агрегатор новостей: RSS-фиды → SQLite → LLM-сводка (Z.ai GLM) → Telegram-бот.

## Команды

- `python3 -m pipeline run` — собрать новости в news.db
- `python3 -m pipeline digest` — сформировать и отправить сводку (без токена TG — сохранить в digests/ и вывести в stdout)
- `python3 -m pipeline check` — проверка здоровья всех фидов

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
