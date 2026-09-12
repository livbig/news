from pipeline.llm import mock_summary  # R10: mock-сводка без ключа (NFR-05)

from . import db

EMPTY_TEXT = "Новых новостей с прошлой сводки нет."  # D7/D8


def build_delta(conn, chat_id, limit=50):
    """Сводка по дельте чата (FR-11, D26): непотреблённые элементы — те,
    что не входили ни в одну сводку чата. Возвращает (text | None, item_ids);
    None — пустая дельта. LLM-сводка — итерация 5."""
    rows = db.pending_items(conn, chat_id, limit)
    if not rows:
        return None, []
    lines = [f"{row['title']} — {row['url']}" for row in rows]
    return mock_summary("\n".join(lines)), [row["id"] for row in rows]
