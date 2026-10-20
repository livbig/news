"""М2: одноразовый перенос bot.db (sqlite) → Supabase Postgres.

Идемпотентен: повторный прогон не создаёт дублей (ON CONFLICT DO NOTHING),
после вставки явных id последовательности выставляются на MAX(id).

Использование:
  python3 scripts/migrate_sqlite_to_pg.py [--db bot.db] [--url postgresql://...]
По умолчанию: BOT_DB_PATH (или ./bot.db) → SUPABASE_DB_URL из .env.
"""

import argparse
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bot import config, db  # noqa: E402 (load_env внутри bot.config)

# порядок = порядок внешних ключей
TABLES = [
    # (таблица, конфликт-цель, колонки)
    ("users", "chat_id",
     "chat_id, tz_offset_min, send_times, last_sent_at, created_at, onboarded_at"),
    ("sources", "id",
     "id, chat_id, kind, url, title, topics, origin, enabled, status, status_msg,"
     " last_post_id, added_at"),
    ("items", "id",
     "id, source_id, url, title, published, fetched_at, url_hash"),
    ("digests", "id",
     "id, chat_id, period_from, period_to, item_count, message_text, created_at"),
    ("digest_items", "digest_id, item_id", "digest_id, item_id"),
    ("chat_history", "id",
     "id, chat_id, role, text, created_at"),
]
SEQUENCES = ["sources", "items", "digests", "chat_history"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("BOT_DB_PATH", str(ROOT / "bot.db")))
    ap.add_argument("--url", default=config.SUPABASE_DB_URL)
    args = ap.parse_args()
    if not args.url:
        print("нет SUPABASE_DB_URL (.env) и не передан --url", file=sys.stderr)
        return 2
    if not Path(args.db).exists():
        print(f"нет исходника: {args.db}", file=sys.stderr)
        return 2

    src = sqlite3.connect(args.db)
    dst = db._pg_connect(args.url)
    db._run_schema(dst, db.SCHEMA_PG)

    for table, conflict, cols in TABLES:
        rows = src.execute(f"SELECT {cols} FROM {table}").fetchall()
        if not rows:
            print(f"{table}: 0 (пусто)")
            continue
        ph = ", ".join(["%s"] * len(cols.split(",")))
        db.executemany(
            dst,
            f"INSERT INTO {table} ({cols}) VALUES ({ph})"
            f" ON CONFLICT ({conflict}) DO NOTHING",
            rows,
        )
        print(f"{table}: {len(rows)}")

    for table in SEQUENCES:
        row = dst.execute(f"SELECT COALESCE(MAX(id), 0) FROM {table}").fetchone()
        if row[0]:
            dst.execute(
                "SELECT setval(pg_get_serial_sequence(%s, 'id'), %s)", (table, row[0])
            )
        else:
            dst.execute(
                "SELECT setval(pg_get_serial_sequence(%s, 'id'), 1, false)", (table,)
            )
    dst.close()
    src.close()
    print("готово: повторный прогон безопасен (ON CONFLICT DO NOTHING)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
