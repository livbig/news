import calendar
import logging
from datetime import datetime, timezone

from pipeline.config import MAX_ARTICLES_PER_FEED
from pipeline.fetch import parse_feed  # R3: httpx+feedparser, таймауты, bozo-проверка

from . import db

log = logging.getLogger("bot.collect")


def _iso(entry) -> str:
    st = entry.get("published_parsed") or entry.get("updated_parsed")
    if st:
        ts = calendar.timegm(st)  # published_parsed — UTC
        return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return db.now_iso()  # fallback: fetched_at-семантика (план §1.2)


def collect_source(conn, source_id, feed_url) -> int:
    """Собрать RSS-фид в items. Бросает исключение наверх (изоляция — вызывающий)."""
    parsed = parse_feed(feed_url)
    added = 0
    for entry in parsed.entries[:MAX_ARTICLES_PER_FEED]:
        link = entry.get("link", "")
        title = entry.get("title", "")
        if not link or not title:
            continue
        if db.insert_item(conn, source_id, link, title, _iso(entry)):
            added += 1
    conn.commit()
    log.info("OK %s: +%d новых", feed_url, added)
    return added
