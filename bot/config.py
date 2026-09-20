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

# iter-11b (D42/D43): объём входа дайджеста — per-source бюджет + общий кап
DIGEST_PER_SOURCE = int(os.environ.get("BOT_DIGEST_PER_SOURCE", "15"))
DIGEST_MAX_ITEMS = int(os.environ.get("BOT_DIGEST_MAX_ITEMS", "800"))

# iter-14 (уровень 1): полные тексты пунктов — кап хранения и кап выдержки в промпте
ITEM_TEXT_CAP = int(os.environ.get("BOT_ITEM_TEXT_CAP", "4000"))
DIGEST_TEXT_CAP = int(os.environ.get("BOT_DIGEST_TEXT_CAP", "1200"))

# iter-14b (уровень 2): фоновая докачка статей — квоты и вежливость
ENRICH_MAX_PER_RUN = int(os.environ.get("BOT_ENRICH_MAX_PER_RUN", "60"))
ENRICH_MIN_CHARS = int(os.environ.get("BOT_ENRICH_MIN_CHARS", "200"))
ENRICH_PAUSE = float(os.environ.get("BOT_ENRICH_PAUSE", "1.5"))

# iter-14c (уровень 3): map-стадия — LLM-выжимки статей в фоне днём
MAP_MAX_PER_RUN = int(os.environ.get("BOT_MAP_MAX_PER_RUN", "25"))
MAP_WORKERS = int(os.environ.get("BOT_MAP_WORKERS", "4"))

# iter-11c (D44): непрерывный фоновый сбор — интервал и пул воркеров
COLLECT_INTERVAL = int(os.environ.get("BOT_COLLECT_INTERVAL", "1800"))
COLLECT_WORKERS = int(os.environ.get("BOT_COLLECT_WORKERS", "6"))

# iter-11d (D46): лимит источников на чат снят до 100
MAX_SOURCES = int(os.environ.get("BOT_MAX_SOURCES", "100"))

# iter-11e (D47): retention — окна хранения
RETENTION_ITEMS_DAYS = int(os.environ.get("BOT_RETENTION_ITEMS_DAYS", "10"))
RETENTION_DAYS = int(os.environ.get("BOT_RETENTION_DAYS", "30"))
