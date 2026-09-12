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
