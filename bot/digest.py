import html

from . import db, llm

EMPTY_TEXT = "Новых новостей с прошлой сводки нет."  # D7/D8


def build_delta(conn, chat_id, limit=50):
    """Сводка по дельте чата (FR-11, D26): непотреблённые элементы — те,
    что не входили ни в одну сводку чата. LLM при наличии ключа, иначе
    mock (NFR-05, И5). Возвращает (text | None, item_ids); None — пустая дельта.

    Внешние строки (title/url) экранируются до сборки (FR-16/TC-06): в выводе
    допустимы только теги LLM, вставки заголовков — буквальный текст."""
    rows = db.pending_items(conn, chat_id, limit)
    if not rows:
        return None, []
    lines = [
        f"{html.escape(row['title'])} — {html.escape(row['url'], quote=False)}"
        for row in rows
    ]
    text = llm.summarize("\n".join(lines))
    return text, [row["id"] for row in rows]


def degraded_footer(errors) -> str:
    """Футер о несобранных источниках (план §1.5, TC-20): предупреждение
    в самой сводке; подробности — в /sources."""
    listing = ", ".join(url for url, _exc in errors)
    return (f"⚠ Не удалось собрать {len(errors)} источник(ов): {listing}\n"
            "Подробности — /sources.")


def with_footer(text: str, errors) -> str:
    return f"{text}\n\n{degraded_footer(errors)}" if errors else text
