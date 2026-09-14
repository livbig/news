import logging

import feedparser
import httpx

from . import config, db

log = logging.getLogger("fetch")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}


def parse_feed(url: str) -> feedparser.FeedParserDict:
    response = httpx.get(url, headers=HEADERS, timeout=20, follow_redirects=True)
    response.raise_for_status()
    parsed = feedparser.parse(response.content)
    if parsed.bozo and not parsed.entries:
        raise RuntimeError(f"некорректный фид: {parsed.bozo_exception}")
    return parsed


def load_feeds():
    feeds = []
    for line in open(config.FEEDS_PATH, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 2:
            log.warning("Некорректная строка feeds.txt (нужно URL|категория): %s", line)
            continue
        feeds.append(tuple(parts))
    return feeds


def fetch_all(conn):
    total_new = 0
    for url, category in load_feeds():
        try:
            parsed = parse_feed(url)
            added = 0
            for entry in parsed.entries[: config.MAX_ARTICLES_PER_FEED]:
                link = entry.get("link", "")
                title = entry.get("title", "")
                if not link or not title:
                    continue
                if db.insert_article(conn, link, title, category, source=url, published=entry.get("published", "")):
                    added += 1
            total_new += added
            log.info("OK %s [%s]: +%d новых", url, category, added)
        except Exception as exc:
            log.error("FAIL %s [%s]: %s", url, category, exc)
    conn.commit()
    return total_new
