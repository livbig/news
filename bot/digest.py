import html
from datetime import datetime

from . import config, db, llm

EMPTY_TEXT = "Новых новостей с прошлой сводки нет."  # D7/D8


def _period_header(period_from: str, period_to: str) -> str:
    """Детерминированный заголовок сводки (iter-17): LLM вольно трактует лид
    (утечка метки «Лид:», пропавший заголовок — фидбек 2026-09-23), а период
    известен точно — пишем сами. Даты локальные (на проде TZ=Europe/Moscow)."""
    def _local(iso: str) -> datetime:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()

    d_from, d_to = _local(period_from), _local(period_to)
    span = (f"{d_from:%d.%m} – {d_to:%d.%m}" if d_from.date() != d_to.date()
            else f"{d_to:%d.%m}")
    return f"<b>🎯 ГЛАВНОЕ ЗА ПЕРИОД ({span})</b>"


def build_delta(conn, chat_id):
    """Сводка по дельте чата (FR-11, D26; iter-11b/D42): непотреблённые
    элементы — те, что не входили ни в одну сводку чата, до per-source
    бюджета и общего капа (db.pending_items). LLM при наличии ключа, иначе
    mock (NFR-05, И5 — только dev-прогон без ключа). iter-16: сбой LLM →
    llm.LLMError с причиной; caller шлёт пользователю сообщение о проблеме
    вместо mock. Возвращает (text | None, item_ids); None — пустая
    дельта. Вход оборачивается в <новости> (контракт промпта §Промпты).
    iter-17: первая строка вывода — детерминированный заголовок
    «ГЛАВНОЕ ЗА ПЕРИОД (…)» с периодом из db.digest_period.

    Внешние строки (title/url/text) экранируются до сборки (FR-16/TC-06): в
    выводе допустимы только теги LLM, вставки заголовков — буквальный текст.
    iter-14 (уровень 1): пункт с сохранённым текстом идёт в вход с выдержкой
    «ТЕКСТ: …» (кап BOT_DIGEST_TEXT_CAP) — LLM пишет вывод по содержимому
    статьи, а не только по заголовку."""
    rows = db.pending_items(conn, chat_id)
    if not rows:
        return None, []
    lines = []
    kept = []
    used = 0
    for row in rows:
        line = (f"{html.escape(row['title'])} — "
                f"{html.escape(row['url'], quote=False)}")
        gist = (row["gist"] or "").strip()
        if gist:  # iter-14c: LLM-выжимка плотнее сырого текста
            line += f"\nВЫЖИМКА: {html.escape(gist, quote=False)}"
        else:
            text = (row["text"] or "").strip()
            if text:
                cap = config.DIGEST_TEXT_CAP
                excerpt = text[:cap] + ("…" if len(text) > cap else "")
                line += f"\nТЕКСТ: {html.escape(excerpt, quote=False)}"
        # iter-21: кап входа по символам (см. config.DIGEST_MAX_CHARS); не
        # вошедшие пункты остаются непотреблёнными и уйдут в следующую сводку.
        if lines and used + len(line) > config.DIGEST_MAX_CHARS:
            break
        used += len(line)
        lines.append(line)
        kept.append(row["id"])
    items_text = "<новости>\n" + "\n\n".join(lines) + "\n</новости>"
    text = llm.summarize(items_text, db.get_interests(conn, chat_id))
    period = db.digest_period(conn, chat_id)
    if period is not None:  # чат знаком — иначе record_digest всё равно откажет
        text = f"{_period_header(*period)}\n\n{text}"  # iter-17
    return text, kept


def degraded_footer(errors) -> str:
    """Футер о несобранных источниках (план §1.5, TC-20): предупреждение
    в самой сводке; подробности — в /sources."""
    listing = ", ".join(url for url, _exc in errors)
    return (f"⚠ Не удалось собрать {len(errors)} источник(ов): {listing}\n"
            "Подробности — /sources.")


def with_footer(text: str, errors) -> str:
    return f"{text}\n\n{degraded_footer(errors)}" if errors else text
