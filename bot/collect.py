import calendar
import logging
from datetime import datetime, timezone

import feedparser

from pipeline.config import MAX_ARTICLES_PER_FEED

from . import db
from .collectors.http import http_get

log = logging.getLogger("bot.collect")


def _iso(entry) -> str:
    st = entry.get("published_parsed") or entry.get("updated_parsed")
    if st:
        ts = calendar.timegm(st)  # published_parsed — UTC
        return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return db.now_iso()  # fallback: fetched_at-семантика (план §1.2)


def fetch_feed(url: str):
    """Скачать и распарсить RSS/Atom через retry-обёртку (NFR-04).
    Возвращает (title, entries); bozo-проверка как в R3; HTML-мусор без
    элементов — ошибка (TC-12)."""
    response = http_get(url)
    parsed = feedparser.parse(response.content)
    if parsed.bozo and not parsed.entries:
        raise RuntimeError(f"некорректный фид: {parsed.bozo_exception}")
    if not parsed.entries:
        raise RuntimeError("в ленте нет элементов — это точно RSS/Atom-фид?")
    return parsed.feed.get("title") or url, parsed.entries


def collect_source(conn, source_id, feed_url) -> int:
    """Собрать фид в items. Статус источника обновляется; ошибки — наверх
    (изоляция на вызывающем)."""
    _, entries = fetch_feed(feed_url)
    added = 0
    for entry in entries[:MAX_ARTICLES_PER_FEED]:
        link = entry.get("link", "")
        title = entry.get("title", "")
        if not link or not title:
            continue
        if db.insert_item(conn, source_id, link, title, _iso(entry)):
            added += 1
    db.set_source_status(conn, source_id, "ok", None)
    log.info("OK %s: +%d новых", feed_url, added)
    return added


def collect_enabled(conn, chat_id):
    """Собрать все включённые RSS-источники чата. Отказ одного не валит прогон
    (NFR-02): ошибка — в лог с URL, источник в error, остальные собираются."""
    total = 0
    errors = []
    for source_id, url in db.enabled_rss_sources(conn, chat_id):
        try:
            total += collect_source(conn, source_id, url)
        except Exception as exc:
            log.error("FAIL %s: %s", url, exc)
            db.set_source_status(conn, source_id, "error", str(exc)[:200])
            errors.append((url, exc))
    return total, errors
