import logging
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env(path=None):
    path = Path(path) if path else ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env()

DB_PATH = str(ROOT / "news.db")
FEEDS_PATH = str(ROOT / "feeds.txt")
LOG_DIR = ROOT / "logs"
DIGEST_DIR = ROOT / "digests"

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.z.ai/api/paas/v4")
LLM_MODEL = os.environ.get("LLM_MODEL", "glm-5.3")
LLM_THINKING = os.environ.get("LLM_THINKING", "")  # сырой JSON поля thinking (пусто → не слать)

MAX_ARTICLES_PER_FEED = 60

DIGEST_TIMES = os.environ.get("DIGEST_TIMES", "09:00,21:00")


def setup_logging():
    LOG_DIR.mkdir(exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[
            logging.FileHandler(LOG_DIR / "run.log", encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )
