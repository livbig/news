import hashlib
import sqlite3

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_hash TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT DEFAULT '',
    published TEXT DEFAULT '',
    fetched_at TEXT DEFAULT (datetime('now')),
    in_digest INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channel_subs (
    name TEXT PRIMARY KEY,
    category TEXT NOT NULL DEFAULT 'tech_ai',
    last_post_id INTEGER NOT NULL DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
"""


def connect():
    conn = sqlite3.connect(config.DB_PATH)
    conn.executescript(SCHEMA)
    try:
        conn.execute("ALTER TABLE channel_subs ADD COLUMN last_post_id INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    return conn


def url_hash(url: str, title: str) -> str:
    base_url = url.split("?")[0].rstrip("/")
    norm_title = " ".join(title.lower().split())
    return hashlib.sha256(f"{base_url}|{norm_title}".encode()).hexdigest()


def insert_article(conn, url, title, category, source="", published="") -> bool:
    try:
        conn.execute(
            "INSERT INTO articles (url_hash, url, title, category, source, published)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (url_hash(url, title), url, title, category, source, published),
        )
        return True
    except sqlite3.IntegrityError:
        return False
