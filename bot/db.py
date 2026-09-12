import json
import sqlite3
from datetime import datetime, timedelta, timezone

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
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def minus_iso(now: str, hours: int) -> str:
    """ISO-метка на `hours` часов раньше данной (для периода сводки, D9)."""
    moment = datetime.fromisoformat(now.replace("Z", "+00:00")) - timedelta(hours=hours)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


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


def list_sources(conn, chat_id) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, title, kind, url, origin, enabled, status, status_msg"
        " FROM sources WHERE chat_id=? ORDER BY id",
        (chat_id,),
    ).fetchall()


def add_source(conn, chat_id, kind, url, title, origin="manual", topics=None):
    """Добавить источник (FR-04/FR-05). None — уже есть (UNIQUE chat_id,kind,url)."""
    conn.execute("INSERT OR IGNORE INTO users (chat_id, created_at) VALUES (?, ?)",
                 (chat_id, now_iso()))
    try:
        cur = conn.execute(
            "INSERT INTO sources (chat_id, kind, url, title, topics, origin, added_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (chat_id, kind, url, title, json.dumps(topics or []), origin, now_iso()),
        )
    except sqlite3.IntegrityError:
        return None
    conn.commit()
    return cur.lastrowid


def get_source(conn, source_id) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT id, chat_id, kind, url, title, origin, enabled, status, status_msg"
        " FROM sources WHERE id=?",
        (source_id,),
    ).fetchone()


def set_enabled(conn, source_id, enabled: bool) -> None:
    conn.execute("UPDATE sources SET enabled=? WHERE id=?", (1 if enabled else 0, source_id))
    conn.commit()


def delete_source(conn, source_id) -> None:
    """items удаляются каскадом (ON DELETE CASCADE, TC-23)."""
    conn.execute("DELETE FROM sources WHERE id=?", (source_id,))
    conn.commit()


def enabled_rss_sources(conn, chat_id) -> list[tuple]:
    return conn.execute(
        "SELECT id, url FROM sources WHERE chat_id=? AND enabled=1 AND kind='rss' ORDER BY id",
        (chat_id,),
    ).fetchall()


def set_source_status(conn, source_id, status: str, msg) -> None:
    conn.execute(
        "UPDATE sources SET status=?, status_msg=? WHERE id=?", (status, msg, source_id)
    )
    conn.commit()


def user_settings(conn, chat_id):
    """(row(send_times), источников) или (None, 0), если чат не знаком."""
    row = conn.execute("SELECT send_times FROM users WHERE chat_id=?", (chat_id,)).fetchone()
    if row is None:
        return None, 0
    count = conn.execute(
        "SELECT COUNT(*) FROM sources WHERE chat_id=?", (chat_id,)
    ).fetchone()[0]
    return row, count


# --- И4: окно дельты (D26) и расписание (FR-10..FR-12) ------------------------

def pending_items(conn, chat_id, limit=50) -> list[sqlite3.Row]:
    """Непотреблённые элементы чата: не входившие ни в одну сводку чата
    (digest_items). published не фильтрует окно (даты фидов ненадёжны,
    D26) — только сортировка, свежие первыми."""
    return conn.execute(
        "SELECT i.id, i.title, i.url FROM items i"
        " JOIN sources s ON s.id = i.source_id"
        " WHERE s.chat_id=? AND NOT EXISTS ("
        "   SELECT 1 FROM digest_items di JOIN digests d ON d.id=di.digest_id"
        "   WHERE di.item_id=i.id AND d.chat_id=?)"
        " ORDER BY i.published DESC, i.id DESC LIMIT ?",
        (chat_id, chat_id, limit),
    ).fetchall()


def record_digest(conn, chat_id, message_text, item_ids, now=None) -> int | None:
    """Транзакционная фиксация отправки (план §1.2): digests + digest_items +
    users.last_sent_at одной транзакцией — защита от дублей при catch-up."""
    now = now or now_iso()
    row = conn.execute("SELECT last_sent_at FROM users WHERE chat_id=?", (chat_id,)).fetchone()
    if row is None:
        return None
    period_from = row[0] or minus_iso(now, 24)  # первая сводка — окно 24 ч (D9)
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO digests (chat_id, period_from, period_to, item_count,"
                " message_text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (chat_id, period_from, now, len(item_ids), message_text, now),
            )
            digest_id = cur.lastrowid
            conn.executemany(
                "INSERT INTO digest_items (digest_id, item_id) VALUES (?, ?)",
                [(digest_id, item_id) for item_id in item_ids],
            )
            conn.execute("UPDATE users SET last_sent_at=? WHERE chat_id=?", (now, chat_id))
    except sqlite3.IntegrityError:
        return None
    return digest_id


def set_send_times(conn, chat_id, times) -> None:
    conn.execute(
        "UPDATE users SET send_times=? WHERE chat_id=?", (json.dumps(sorted(times)), chat_id)
    )
    conn.commit()


def scheduled_users(conn) -> list[sqlite3.Row]:
    """Onboarded-чаты для планировщика: расписание, прошлой отправки и
    онбординга (точка отсчёта первой сводки, D9)."""
    return conn.execute(
        "SELECT chat_id, send_times, last_sent_at, onboarded_at"
        " FROM users WHERE onboarded_at IS NOT NULL"
    ).fetchall()
