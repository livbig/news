"""CRUD источников (FR-04) и мастер добавления своих RSS (FR-05, план §1.3)."""
import asyncio
import logging
from urllib.parse import urlsplit

from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import collect, db, keyboards
from ..states import AddSource
from . import onboarding
from .onboarding import _drop, _touch, allowed

log = logging.getLogger("bot.sources")

router = Router()

PREVIEW_TITLES = 3


def _list_text(rows) -> str:
    lines = []
    for _id, title, kind, url, origin, enabled, status, status_msg in rows:
        mark = "" if enabled else " (выключен)"
        tag = "опрос" if origin == "survey" else "свой"
        warn = f"\n  ⚠ {status_msg}" if status == "error" and status_msg else ""
        lines.append(f"• {title} — {kind}, {tag}{mark}{warn}")
    if not rows:
        return "Источников пока нет — добавьте свой или пройдите опрос: /start"
    return f"Источники ({len(rows)}):\n\n" + "\n".join(lines)


def _validate_url(value: str) -> str | None:
    """TC-12: 'htp:/bad-url', 'not-a-url' — None; валидный http(s) — сам URL."""
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    if "." not in parts.netloc and parts.netloc != "localhost":
        return None
    return value


async def _owned_source(cb: CallbackQuery, source_id: int):
    row = await asyncio.to_thread(db.get_source, onboarding.conn, source_id)
    if not row or row["chat_id"] != cb.message.chat.id:
        await cb.answer("Кнопка устарела — откройте /sources заново")
        return None
    return row


# --- список и команды ---------------------------------------------------------

@router.message(Command("sources"))
async def cmd_sources(message: Message, state: FSMContext):
    await _drop(state)
    if not allowed(message.chat.id):
        return
    rows = await asyncio.to_thread(db.list_sources, onboarding.conn, message.chat.id)
    await message.answer(_list_text(rows), reply_markup=keyboards.sources_manage_kb(rows))


@router.callback_query(F.data == "menu:list")
async def cq_menu_list(cb: CallbackQuery):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    rows = await asyncio.to_thread(db.list_sources, onboarding.conn, cb.message.chat.id)
    await cb.message.edit_text(_list_text(rows), reply_markup=keyboards.sources_manage_kb(rows))
    await cb.answer()


# --- вкл/выкл (FR-04, TC-22) ---------------------------------------------------

@router.callback_query(F.data.startswith("src:t:"))
async def cq_toggle(cb: CallbackQuery):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    row = await _owned_source(cb, int(cb.data.split(":", 2)[2]))
    if row is None:
        return
    await asyncio.to_thread(db.set_enabled, onboarding.conn, row["id"], not row["enabled"])
    log.info("Источник %s «%s»: enabled=%s", row["id"], row["title"], not row["enabled"])
    await cq_menu_list(cb)


# --- удаление (FR-04, TC-23) ---------------------------------------------------

@router.callback_query(F.data.startswith("src:d:"))
async def cq_delete_ask(cb: CallbackQuery):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    row = await _owned_source(cb, int(cb.data.split(":", 2)[2]))
    if row is None:
        return
    await cb.message.edit_text(
        f"Удалить «{row['title']}»? Его собранные новости тоже исчезнут.",
        reply_markup=keyboards.delete_confirm_kb(row["id"]),
    )
    await cb.answer()


@router.callback_query(F.data.startswith("src:dy:"))
async def cq_delete_yes(cb: CallbackQuery):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    row = await _owned_source(cb, int(cb.data.split(":", 2)[2]))
    if row is None:
        return
    await asyncio.to_thread(db.delete_source, onboarding.conn, row["id"])
    log.info("Удалён источник %s «%s»", row["id"], row["title"])
    rows = await asyncio.to_thread(db.list_sources, onboarding.conn, cb.message.chat.id)
    await cb.message.edit_text(
        f"Удалено: «{row['title']}».\n\n" + _list_text(rows),
        reply_markup=keyboards.sources_manage_kb(rows),
    )
    await cb.answer()


# --- мастер добавления (FR-04/FR-05, TC-12) ------------------------------------

@router.callback_query(F.data == "add:start")
async def cq_add_start(cb: CallbackQuery, state: FSMContext):
    if not allowed(cb.message.chat.id):
        return await cb.answer()
    await state.clear()
    await state.set_state(AddSource.kind)
    _touch(cb.message.chat.id, cb.from_user.id)
    await cb.message.edit_text("Какой тип источника добавляем?", reply_markup=keyboards.kind_kb())
    await cb.answer()


@router.callback_query(StateFilter(AddSource.kind), F.data.startswith("a:k:"))
async def cq_kind(cb: CallbackQuery, state: FSMContext):
    kind = cb.data.split(":", 2)[2]
    if kind != "rss":
        return await cb.answer(
            "Пока поддерживается только RSS — остальные типы в разработке", show_alert=True
        )
    _touch(cb.message.chat.id, cb.from_user.id)
    await state.update_data(kind="rss")
    await state.set_state(AddSource.url)
    await cb.message.edit_text(
        "Отправьте ссылку на RSS/Atom-фид, например https://site.com/rss\n"
        "Отмена — /sources."
    )
    await cb.answer()


@router.message(StateFilter(AddSource.url), F.text & ~F.text.startswith("/"))
async def ms_url(message: Message, state: FSMContext):
    _touch(message.chat.id, message.from_user.id)
    url = _validate_url(message.text)
    if not url:
        await message.answer(
            "Это не похоже на ссылку. Отправьте адрес вида https://site.com/rss"
        )
        return
    try:
        feed_title, entries = await asyncio.to_thread(collect.fetch_feed, url)
    except Exception as exc:
        log.error("Превью не удалось %s: %s", url, exc)
        await message.answer(
            f"Не удалось прочитать фид: {exc}\n\nПроверьте адрес и отправьте снова."
        )
        return
    titles = [e.get("title", "") for e in entries[:PREVIEW_TITLES] if e.get("title")]
    await state.update_data(url=url, feed_title=feed_title)
    await state.set_state(AddSource.preview)
    await message.answer(
        f"«{feed_title}»\nПоследние заголовки:\n" + "\n".join("• " + t for t in titles)
        + "\n\nДобавить этот источник?",
        reply_markup=keyboards.preview_kb(),
    )


@router.callback_query(StateFilter(AddSource.preview), F.data == "a:confirm")
async def cq_confirm(cb: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    chat_id = cb.message.chat.id
    source_id = await asyncio.to_thread(
        db.add_source, onboarding.conn, chat_id, "rss", data["url"], data["feed_title"]
    )
    if source_id is None:
        await cb.answer("Такой источник уже добавлен", show_alert=True)
    else:
        log.info("Добавлен источник chat=%s: %s", chat_id, data["url"])
        await cb.answer("Добавлено")
    rows = await asyncio.to_thread(db.list_sources, onboarding.conn, chat_id)
    verb = "уже в списке" if source_id is None else f"добавлено: «{data['feed_title']}»"
    await cb.message.edit_text(
        f"{verb}.\n\n" + _list_text(rows), reply_markup=keyboards.sources_manage_kb(rows)
    )
    await _drop(state)


@router.callback_query(StateFilter(AddSource.kind, AddSource.url, AddSource.preview),
                       F.data == "a:cancel")
async def cq_add_cancel(cb: CallbackQuery, state: FSMContext):
    await _drop(state)
    rows = await asyncio.to_thread(db.list_sources, onboarding.conn, cb.message.chat.id)
    await cb.message.edit_text(
        "Добавление отменено.\n\n" + _list_text(rows),
        reply_markup=keyboards.sources_manage_kb(rows),
    )
    await cb.answer()


# --- посторонний ввод внутри мастера -------------------------------------------

@router.message(StateFilter(AddSource.kind, AddSource.preview), ~F.text.startswith("/"))
async def ms_foreign_add(message: Message, state: FSMContext):
    _touch(message.chat.id, message.from_user.id)
    await message.answer(
        "Сейчас идёт добавление источника — используйте кнопки этого сообщения. "
        "/sources — к списку источников."
    )
