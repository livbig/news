"""Inline-клавиатуры бота. Отметка выбора — префикс «✓ » в тексте кнопки."""
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from . import catalog
from .catalog import TOPIC_LABELS

TIME_PRESETS = ["09:00", "21:00", "12:00", "18:00"]


def _grid(buttons, columns=2):
    return [buttons[i : i + columns] for i in range(0, len(buttons), columns)]


def topics_kb(selected) -> InlineKeyboardMarkup:
    buttons = [
        InlineKeyboardButton(
            text=("✓ " if topic in selected else "") + TOPIC_LABELS[topic],
            callback_data=f"t:{topic}",
        )
        for topic in catalog.TOPIC_PRIORITY
    ]
    rows = _grid(buttons)
    rows.append([InlineKeyboardButton(text="Далее", callback_data="t:next")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def sources_kb(pool, excluded) -> InlineKeyboardMarkup:
    rows = [
        [
            InlineKeyboardButton(
                text=("" if i in excluded else "✓ ") + e["title"],
                callback_data=f"s:{i}",
            )
        ]
        for i, e in enumerate(pool)
    ]
    rows.append([InlineKeyboardButton(text="Далее", callback_data="s:next")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


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


def sources_manage_kb(rows) -> InlineKeyboardMarkup:
    """CRUD-список: строки list_sources (id, title, kind, url, origin, enabled,
    status, status_msg) → вкл/выкл + удаление каждого + навигация (FR-04)."""
    kb = []
    for sid, title, kind, url, origin, enabled, status, status_msg in rows:
        kb.append([
            InlineKeyboardButton(
                text=("⏸ " if enabled else "▶ ") + title[:24], callback_data=f"src:t:{sid}"
            ),
            InlineKeyboardButton(text="✕", callback_data=f"src:d:{sid}"),
        ])
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
