import html

from . import db, llm

EMPTY_TEXT = "Новых новостей с прошлой сводки нет."  # D7/D8


def build_delta(conn, chat_id):
    """Сводка по дельте чата (FR-11, D26; iter-11b/D42): непотреблённые
    элементы — те, что не входили ни в одну сводку чата, до per-source
    бюджета и общего капа (db.pending_items). LLM при наличии ключа, иначе
    mock (NFR-05, И5). Возвращает (text | None, item_ids); None — пустая
    дельта. Вход оборачивается в <новости> (контракт промпта §Промпты).

    Внешние строки (title/url) экранируются до сборки (FR-16/TC-06): в выводе
    допустимы только теги LLM, вставки заголовков — буквальный текст."""
    rows = db.pending_items(conn, chat_id)
    if not rows:
        return None, []
    lines = [
        f"{html.escape(row['title'])} — {html.escape(row['url'], quote=False)}"
        for row in rows
    ]
    items_text = "<новости>\n" + "\n".join(lines) + "\n</новости>"
    text = llm.summarize(items_text, db.get_interests(conn, chat_id))
    return text, [row["id"] for row in rows]


def degraded_footer(errors) -> str:
    """Футер о несобранных источниках (план §1.5, TC-20): предупреждение
    в самой сводке; подробности — в /sources."""
    listing = ", ".join(url for url, _exc in errors)
    return (f"⚠ Не удалось собрать {len(errors)} источник(ов): {listing}\n"
            "Подробности — /sources.")


def with_footer(text: str, errors) -> str:
    return f"{text}\n\n{degraded_footer(errors)}" if errors else text
