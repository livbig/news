import json
import sqlite3
from datetime import datetime, timezone

from pipeline.db import url_hash  # R5: боевая формула дедупа (D19)

from . import config

# Схема — docs/plan.md §1.2 + П.2 (правки после сверки)
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  chat_id      INTEGER PRIMARY KEY,
  tz_offset_min INTEGER NOT NULL DEFAULT 180,
  send_times   TEXT NOT NULL DEFAULT '["09:00"]',
  last_sent_at TEXT,
  created_at   TEXT NOT NULL,
  onboarded_at TEXT
);
CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('rss','html','tgweb','reddit','twitter')),
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  topics     TEXT NOT NULL DEFAULT '[]',
  origin     TEXT NOT NULL DEFAULT 'survey' CHECK (origin IN ('survey','manual')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','degraded','error')),
  status_msg TEXT,
  last_post_id INTEGER NOT NULL DEFAULT 0,
  added_at   TEXT NOT NULL,
  UNIQUE (chat_id, kind, url)
);
CREATE INDEX IF NOT EXISTS idx_sources_chat ON sources (chat_id, enabled);
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  published    TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  url_hash     TEXT NOT NULL,
  UNIQUE (source_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_items_published ON items (published);
CREATE TABLE IF NOT EXISTS digests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  period_from  TEXT NOT NULL,
  period_to    TEXT NOT NULL,
  item_count   INTEGER NOT NULL,
  message_text TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digests_chat ON digests (chat_id, created_at);
CREATE TABLE IF NOT EXISTS digest_items (
  digest_id INTEGER NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (digest_id, item_id)
);
CREATE TABLE IF NOT EXISTS chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def connect(path=None):
    # check_same_thread=False: хендлеры зовут БД через asyncio.to_thread (последовательно)
    conn = sqlite3.connect(path or config.DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def insert_item(conn, source_id, url, title, published) -> bool:
    try:
        conn.execute(
            "INSERT INTO items (source_id, url, title, published, fetched_at, url_hash)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (source_id, url, title, published or now_iso(), now_iso(), url_hash(url, title)),
        )
        return True
    except sqlite3.IntegrityError:
        return False


def ensure_bootstrap(conn, feed_url) -> int:
    """И1: служебный пользователь chat_id=0 и один захардкоженный RSS-источник."""
    conn.execute("INSERT OR IGNORE INTO users (chat_id, created_at) VALUES (0, ?)", (now_iso(),))
    conn.execute(
        "INSERT OR IGNORE INTO sources (chat_id, kind, url, title, origin, added_at)"
        " VALUES (0, 'rss', ?, 'Bootstrap feed', 'manual', ?)",
        (feed_url, now_iso()),
    )
    conn.commit()
    row = conn.execute(
        "SELECT id FROM sources WHERE chat_id=0 AND kind='rss' AND url=?", (feed_url,)
    ).fetchone()
    return row[0]


def ensure_user(conn, chat_id) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO users (chat_id, created_at) VALUES (?, ?)", (chat_id, now_iso())
    )
    conn.commit()


def is_onboarded(conn, chat_id) -> bool:
    row = conn.execute("SELECT onboarded_at FROM users WHERE chat_id=?", (chat_id,)).fetchone()
    return bool(row and row[0])


def finalize_survey(conn, chat_id, entries, times, mode) -> None:
    """Финализация опроса (D22). replace — удалить прошлые survey-источники;
    add — объединение без дублей по UNIQUE(chat_id, kind, url).
    last_sent_at не трогаем (окно не сбрасывается, сценарии 6.2/6.3)."""
    now = now_iso()
    conn.execute("INSERT OR IGNORE INTO users (chat_id, created_at) VALUES (?, ?)", (chat_id, now))
    if mode == "replace":
        conn.execute("DELETE FROM sources WHERE chat_id=? AND origin='survey'", (chat_id,))
    conn.executemany(
        "INSERT OR IGNORE INTO sources (chat_id, kind, url, title, topics, origin, added_at)"
        " VALUES (?, 'rss', ?, ?, ?, 'survey', ?)",
        [(chat_id, e["url"], e["title"], json.dumps(e.get("topics", [])), now) for e in entries],
    )
    conn.execute(
        "UPDATE users SET send_times=?, onboarded_at=COALESCE(onboarded_at, ?) WHERE chat_id=?",
        (json.dumps(times), now, chat_id),
    )
    conn.commit()


def list_sources(conn, chat_id) -> list[tuple]:
    return conn.execute(
        "SELECT title, kind, url, origin, enabled FROM sources WHERE chat_id=? ORDER BY id",
        (chat_id,),
    ).fetchall()
