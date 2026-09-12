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
    rows = [[InlineKeyboardButton(text="Источники", callback_data="menu:list")]]
    if onboarded:
        rows[0].append(
            InlineKeyboardButton(text="Пройти опрос заново", callback_data="menu:resurvey")
        )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def sources_list_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Пройти опрос заново", callback_data="menu:resurvey")],
            [InlineKeyboardButton(text="В меню", callback_data="menu:main")],
        ]
    )
