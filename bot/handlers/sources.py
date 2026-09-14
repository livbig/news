"""CRUD источников (FR-04) и мастер добавления всех типов (FR-05..FR-09)."""
import asyncio
import logging

from aiogram import F, Router
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from .. import collect, config, db, keyboards
from ..states import AddSource
from . import onboarding
from .onboarding import _drop, _touch, allowed

log = logging.getLogger("bot.sources")

router = Router()

# подсказки шага AsUrl по типу (план §1.3)
KIND_PROMPTS = {
    "rss": "Отправьте ссылку на RSS/Atom-фид, например https://site.com/rss",
    "html": "Отправьте ссылку на страницу со списком новостей, например https://site.com/news",
    "tgweb": "Отправьте имя публичного канала (например, durov) или ссылку t.me/durov",
    "reddit": "Отправьте имя сабреддита, например wallstreetbets или r/wallstreetbets",
    "twitter": "Отправьте имя аккаунта X, например @durov",
}


def _list_text(rows) -> str:
    lines = []
    for _id, title, kind, url, origin, enabled, status, status_msg in rows:
        mark = "" if enabled else " (выключен)"
        tag = "опрос" if origin == "survey" else "свой"
        warn = ""
        if status in ("error", "degraded") and status_msg:
            warn = f"\n  ⚠ {status_msg}"
        lines.append(f"• {title} — {kind}, {tag}{mark}{warn}")
    if not rows:
        return "Источников пока нет — добавьте свой или пройдите опрос: /start"
    return f"Источники ({len(rows)}):\n\n" + "\n".join(lines)


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
    if kind == "twitter" and not config.TWITTER_BRIDGE_URL_TEMPLATE:
        return await cb.answer(
            "RSS-мост X не настроен (TWITTER_BRIDGE_URL_TEMPLATE) — добавление недоступно",
            show_alert=True,
        )
    _touch(cb.message.chat.id, cb.from_user.id)
    await state.update_data(kind=kind)
    await state.set_state(AddSource.url)
    await cb.message.edit_text(KIND_PROMPTS[kind] + "\nОтмена — /sources.")
    await cb.answer()


@router.message(StateFilter(AddSource.url), F.text & ~F.text.startswith("/"))
async def ms_url(message: Message, state: FSMContext):
    _touch(message.chat.id, message.from_user.id)
    data = await state.get_data()
    kind = data.get("kind") or "rss"
    try:
        title, url, lines = await asyncio.to_thread(collect.make_preview, kind, message.text)
    except Exception as exc:
        log.error("Превью не удалось [%s] %s: %r", kind, message.text, exc)
        await message.answer(f"{exc}\n\nПроверьте адрес и отправьте снова.")
        return
    word = "посты" if kind == "tgweb" else "заголовки"
    # D28: сабреддит — это rss-источник (.rss-эндпоинт), отдельного типа в БД нет
    store_kind = "rss" if kind == "reddit" else kind
    await state.update_data(kind=store_kind, url=url, title=title)
    await state.set_state(AddSource.preview)
    await message.answer(
        f"«{title}»\nПоследние {word}:\n" + "\n".join("• " + t for t in lines if t)
        + "\n\nДобавить этот источник?",
        reply_markup=keyboards.preview_kb(),
    )


@router.callback_query(StateFilter(AddSource.preview), F.data == "a:confirm")
async def cq_confirm(cb: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    chat_id = cb.message.chat.id
    source_id = await asyncio.to_thread(
        db.add_source, onboarding.conn, chat_id, data.get("kind") or "rss",
        data["url"], data["title"],
    )
    if source_id is None:
        await cb.answer("Такой источник уже добавлен", show_alert=True)
    else:
        log.info("Добавлен источник chat=%s: %s %s", chat_id, data.get("kind"), data["url"])
        await cb.answer("Добавлено")
    rows = await asyncio.to_thread(db.list_sources, onboarding.conn, chat_id)
    verb = "уже в списке" if source_id is None else f"добавлено: «{data['title']}»"
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
