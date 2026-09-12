from pipeline.llm import mock_summary  # R10: mock-сводка без ключа (NFR-05)


def build_mock(conn, chat_id, limit=50) -> str | None:
    """Mock-сводка «заголовок — ссылка» по всем источникам чата (NFR-05).
    LLM-промпт — итерация 5."""
    rows = conn.execute(
        "SELECT i.title, i.url FROM items i JOIN sources s ON s.id = i.source_id"
        " WHERE s.chat_id=? ORDER BY i.id DESC LIMIT ?",
        (chat_id, limit),
    ).fetchall()
    if not rows:
        return None
    lines = [f"{title} — {url}" for title, url in rows]
    return mock_summary("\n".join(lines))
