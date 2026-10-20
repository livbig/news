"""Inline-клавиатуры бота. Отметка выбора — префикс «✓ » в тексте кнопки.
Пагинация (11d/D46): пулы >30 — страницы по 30 (лимит Telegram ~100 кнопок)."""
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

TIME_PRESETS = ["09:00", "21:00", "12:00", "18:00"]

PAGE_SIZE = 30


def _grid(buttons, columns=2):
    return [buttons[i : i + columns] for i in range(0, len(buttons), columns)]


def sources_kb(pool, excluded, page=0) -> InlineKeyboardMarkup:
    """Мультивыбор источников онбординга; page — глобальные индексы пула."""
    chunk = pool[page * PAGE_SIZE : (page + 1) * PAGE_SIZE]
    rows = [
        [
            InlineKeyboardButton(
                text=("" if page * PAGE_SIZE + j in excluded else "✓ ") + e["title"][:60],
                callback_data=f"s:{page * PAGE_SIZE + j}",
            )
        ]
        for j, e in enumerate(chunk)
    ]
    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton(text="‹ Назад", callback_data=f"s:p:{page - 1}"))
    if (page + 1) * PAGE_SIZE < len(pool):
        nav.append(InlineKeyboardButton(
            text=f"Ещё › ({len(pool) - (page + 1) * PAGE_SIZE})",
            callback_data=f"s:p:{page + 1}"))
    if nav:
        rows.append(nav)
    rows.append([InlineKeyboardButton(text="Далее", callback_data="s:next")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def interview_kb() -> InlineKeyboardMarkup:
    """Кнопки у каждого вопроса интервью (11d/D45)."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="Достаточно", callback_data="i:done"),
                InlineKeyboardButton(text="Пропустить вопрос", callback_data="i:skip"),
            ]
        ]
    )


def profile_kb() -> InlineKeyboardMarkup:
    """Черновик профиля интересов: подправить или принять (11d/D45)."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="Верно", callback_data="i:ok"),
                InlineKeyboardButton(text="Подправить", callback_data="i:fix"),
            ]
        ]
    )


def freq_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="1 раз в день", callback_data="f:1"),
                InlineKeyboardButton(text="2 раза в день", callback_data="f:2"),
            ]
        ]
    )


def times_kb(selected) -> InlineKeyboardMarkup:
    buttons = [
        InlineKeyboardButton(
            text=("✓ " if t in selected else "") + t, callback_data=f"m:{t}"
        )
        for t in TIME_PRESETS
    ]
    rows = _grid(buttons)
    rows.append([InlineKeyboardButton(text="Ввести своё время", callback_data="m:custom")])
    rows.append([InlineKeyboardButton(text="Далее", callback_data="m:next")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def confirm_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="Сохранить", callback_data="c:save"),
                InlineKeyboardButton(text="Пройти заново", callback_data="c:restart"),
            ]
        ]
    )


def rs_mode_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Заменить", callback_data="r:replace")],
            [InlineKeyboardButton(text="Добавить поверх", callback_data="r:add")],
            [InlineKeyboardButton(text="Отмена", callback_data="c:cancel")],
        ]
    )


def menu_kb(onboarded: bool) -> InlineKeyboardMarkup:
    rows = [[
        InlineKeyboardButton(text="Источники", callback_data="menu:list"),
        InlineKeyboardButton(text="Сводка сейчас", callback_data="menu:digest"),
    ]]
    if onboarded:
        rows.append(
            [InlineKeyboardButton(text="Пройти опрос заново", callback_data="menu:resurvey")]
        )
    return InlineKeyboardMarkup(inline_keyboard=rows)


# типы мастера (план §1.3); все активны с И6
KIND_LABELS = [
    ("rss", "RSS-фид"),
    ("html", "Сайт"),
    ("tgweb", "TG-канал"),
    ("reddit", "Subreddit"),
    ("twitter", "X-аккаунт"),
]


def kind_kb() -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(text=label, callback_data=f"a:k:{kind}")]
        for kind, label in KIND_LABELS
    ]
    rows.append([InlineKeyboardButton(text="Отмена", callback_data="a:cancel")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def sources_manage_kb(rows, page=0) -> InlineKeyboardMarkup:
    """CRUD-список: строки list_sources (id, title, kind, url, origin, enabled,
    status, status_msg) → вкл/выкл + удаление каждого + навигация (FR-04);
    50+ источников — пагинация по PAGE_SIZE (11d/D46)."""
    chunk = rows[page * PAGE_SIZE : (page + 1) * PAGE_SIZE]
    kb = []
    for sid, title, kind, url, origin, enabled, status, status_msg in chunk:
        kb.append([
            InlineKeyboardButton(
                text=("⏸ " if enabled else "▶ ") + title[:24], callback_data=f"src:t:{sid}"
            ),
            InlineKeyboardButton(text="✕", callback_data=f"src:d:{sid}"),
        ])
    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton(text="‹ Назад", callback_data=f"src:pg:{page - 1}"))
    if (page + 1) * PAGE_SIZE < len(rows):
        nav.append(InlineKeyboardButton(
            text=f"Ещё › ({len(rows) - (page + 1) * PAGE_SIZE})",
            callback_data=f"src:pg:{page + 1}"))
    if nav:
        kb.append(nav)
    kb.append([InlineKeyboardButton(text="➕ Добавить источник", callback_data="add:start")])
    kb.append([InlineKeyboardButton(text="Пройти опрос заново", callback_data="menu:resurvey")])
    kb.append([InlineKeyboardButton(text="В меню", callback_data="menu:main")])
    return InlineKeyboardMarkup(inline_keyboard=kb)


def preview_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Подтвердить", callback_data="a:confirm")],
            [InlineKeyboardButton(text="Отмена", callback_data="a:cancel")],
        ]
    )


def delete_confirm_kb(sid: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Да, удалить", callback_data=f"src:dy:{sid}")],
            [InlineKeyboardButton(text="Отмена", callback_data="menu:list")],
        ]
    )
