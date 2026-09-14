import os
from pathlib import Path

import pipeline  # noqa: F401 — IP-пиннинг api.telegram.org (решение D23 сверки)
from pipeline.config import load_env

load_env()

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = os.environ.get("BOT_DB_PATH", str(ROOT / "bot.db"))

# dev-токен приоритетнее прод-токена (D24: разработка без 409 с живым агентом)
TOKEN = os.environ.get("TELEGRAM_TOKEN_DEV") or os.environ.get("TELEGRAM_TOKEN", "")
ALLOWED_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

# И1: единственный захардкоженный RSS-источник (переопределяется для тестов)
FEED_URL = os.environ.get("BOT_FEED_URL", "https://www.fxstreet.com/rss/news")

# И6: типы источников (FR-06..FR-09). Шаблоны переопределяются в тестах
# на маршруты fixture-сервера (TESTPLAN §1.3)
TWITTER_BRIDGE_URL_TEMPLATE = os.environ.get("TWITTER_BRIDGE_URL_TEMPLATE", "")
TGWEB_URL_TEMPLATE = os.environ.get("BOT_TGWEB_URL_TEMPLATE", "https://t.me/s/{name}")
REDDIT_RSS_TEMPLATE = os.environ.get(
    "BOT_REDDIT_RSS_TEMPLATE", "https://www.reddit.com/r/{name}/new/.rss"
)

# М2: Supabase Postgres (transaction pooler) — задан → бот работает на PG
# вместо sqlite (BOT_DB_PATH принудительно возвращает sqlite, TC-45).
SUPABASE_DB_URL = os.environ.get("SUPABASE_DB_URL", "")
# М2: PG для тестов ':memory:' (локальный docker / CI service container).
TEST_PG_URL = os.environ.get("BOT_TEST_PG_URL", "")
