from pipeline.llm import mock_summary  # R10: mock-сводка без ключа (NFR-05)


def build_mock(conn, source_id, limit=50) -> str | None:
    """И1: mock-сводка «заголовок — ссылка». LLM-промпт — итерация 5."""
    rows = conn.execute(
        "SELECT title, url FROM items WHERE source_id=? ORDER BY id LIMIT ?", (source_id, limit)
    ).fetchall()
    if not rows:
        return None
    lines = [f"{title} — {url}" for title, url in rows]
    return mock_summary("\n".join(lines))
