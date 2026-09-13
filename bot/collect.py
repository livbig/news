"""Сбор источников всех типов (И6): rss (+reddit-фиды, D28), html (bs4),
tgweb (скрейпер t.me/s, R6), twitter (RSS-мост, N4)."""
import calendar
import logging
import re
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

import feedparser
import httpx
from bs4 import BeautifulSoup
from pipeline.channels import _post_num, parse_page  # R6: боевой скрейпер t.me/s
from pipeline.config import MAX_ARTICLES_PER_FEED

from . import config, db
from .collectors.http import http_get

log = logging.getLogger("bot.collect")

TGWEB_PAUSE = 1.0   # щадящие запросы к t.me: пауза между страницами/каналами (FR-07)
TGWEB_MAX_PAGES = 6  # как в проде (R6)
HTML_MIN_TEXT = 10   # эвристика «ссылка-статья», а не пункт меню (FR-06)

# деградация с предупреждением, не блокер: мост X (D3), закрытое превью канала (§3)
DEGRADED_KINDS = ("tgweb", "twitter")

TG_NAME_RE = re.compile(r"^[A-Za-z0-9_]{4,32}$")
REDDIT_NAME_RE = re.compile(r"^[A-Za-z0-9_]{2,21}$")
TWITTER_NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")


def _pause(seconds: float) -> None:
    time.sleep(seconds)  # замок в тестах


def _iso(entry) -> str:
    st = entry.get("published_parsed") or entry.get("updated_parsed")
    if st:
        ts = calendar.timegm(st)  # published_parsed — UTC
        return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return db.now_iso()  # fallback: fetched_at-семантика (план §1.2)


def _iso_dt(value: str | None) -> str:
    """ISO-строка (напр. datetime поста t.me) → единый формат Z для сортировки."""
    try:
        moment = datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except ValueError:
        return db.now_iso()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- валидация ввода мастера (типоспецифичная, FR-04..FR-09) -------------------

def validate_http_url(value: str) -> str | None:
    """TC-12: 'htp:/bad-url', 'not-a-url' — None; валидный http(s) — сам URL."""
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    if "." not in parts.netloc and parts.netloc != "localhost":
        return None
    return value


def tg_name(value: str) -> str | None:
    value = value.strip().rstrip("/")
    m = re.search(r"t\.me/s?/([A-Za-z0-9_]+)", value)
    if m:
        value = m.group(1)
    return value if TG_NAME_RE.match(value) else None


def reddit_name(value: str) -> str | None:
    value = value.strip().rstrip("/")
    m = re.search(r"reddit\.com/r/([A-Za-z0-9_]+)", value)
    value = m.group(1) if m else value.removeprefix("r/")
    return value if REDDIT_NAME_RE.match(value) else None


def twitter_name(value: str) -> str | None:
    value = value.strip().rstrip("/").lstrip("@")
    m = re.search(r"(?:twitter|x)\.com/@?([A-Za-z0-9_]+)", value)
    if m:
        value = m.group(1)
    return value if TWITTER_NAME_RE.match(value) else None


def bridge_url(name: str) -> str:
    template = config.TWITTER_BRIDGE_URL_TEMPLATE
    if not template:
        raise RuntimeError("RSS-мост X не настроен (TWITTER_BRIDGE_URL_TEMPLATE)")
    return template.format(name=name)


def fetch_url(kind: str, url: str) -> str:
    """Канонический адрес источника → запрашиваемый URL (для сбора/лога/футера)."""
    if kind == "tgweb":
        return config.TGWEB_URL_TEMPLATE.format(name=url)
    if kind == "twitter":
        return bridge_url(url)
    return url


# --- rss (+ reddit-фиды — тот же путь, D28) --------------------------------------

def fetch_feed(url: str):
    """Скачать и распарсить RSS/Atom через retry-обёртку (NFR-04).
    Возвращает (title, entries); bozo-проверка как в R3; HTML-мусор без
    элементов — ошибка (TC-12)."""
    response = http_get(url)
    parsed = feedparser.parse(response.content)
    if parsed.bozo and not parsed.entries:
        raise RuntimeError(f"некорректный фид: {parsed.bozo_exception}")
    if not parsed.entries:
        raise RuntimeError("в ленте нет элементов — это точно RSS/Atom-фид?")
    return parsed.feed.get("title") or url, parsed.entries


def _insert_entries(conn, source_id, entries) -> int:
    added = 0
    for entry in entries[:MAX_ARTICLES_PER_FEED]:
        link = entry.get("link", "")
        title = entry.get("title", "")
        if not link or not title:
            continue
        if db.insert_item(conn, source_id, link, title, _iso(entry)):
            added += 1
    return added


def collect_source(conn, source_id, feed_url) -> int:
    """Собрать фид по прямому URL (mock-прогон И1, TC-11); статус ok
    фиксирует и вставки (insert_item не коммитит сам)."""
    _, entries = fetch_feed(feed_url)
    added = _insert_entries(conn, source_id, entries)
    db.set_source_status(conn, source_id, "ok", None)
    log.info("OK %s: +%d новых", feed_url, added)
    return added


# --- html (FR-06, N3) -------------------------------------------------------------

def parse_html_items(page_url: str, text: str) -> list[tuple[str, str]]:
    """Ссылки-«статьи» со страницы: <a> с текстом-заголовком на тот же хост.
    bs4 — единственная новая зависимость (D11)."""
    host = urlsplit(page_url).netloc
    soup = BeautifulSoup(text, "html.parser")
    items, seen = [], set()
    for a in soup.find_all("a", href=True):
        title = " ".join(a.get_text(" ", strip=True).split())
        if len(title) < HTML_MIN_TEXT:
            continue
        link = urljoin(page_url, a["href"])
        parts = urlsplit(link)
        if parts.scheme not in ("http", "https") or parts.netloc != host:
            continue
        if link in seen:
            continue
        seen.add(link)
        items.append((link, title))
        if len(items) >= MAX_ARTICLES_PER_FEED:
            break
    return items


def collect_html(conn, source_id, page_url) -> int:
    items = parse_html_items(page_url, http_get(page_url).text)
    if not items:
        raise RuntimeError("на странице не найдено ссылок на статьи")
    added = 0
    for link, title in items:  # даты на списках-страницах нет → fetched_at (§1.2)
        if db.insert_item(conn, source_id, link, title, None):
            added += 1
    return added


# --- tgweb (FR-07, R6+A3) ----------------------------------------------------------

def fetch_tgweb_pages(name: str, last_seen: int) -> list[tuple[str, str, str]]:
    """Страницы t.me/s/<name> назад (?before=) до последнего обработанного
    поста — парсинг/пагинация/лимит 6 страниц как в проде (R6); паузы между
    страницами — щадящий режим (FR-07)."""
    pages, before = [], None
    for page_no in range(TGWEB_MAX_PAGES):
        if page_no:
            _pause(TGWEB_PAUSE)
        url = config.TGWEB_URL_TEMPLATE.format(name=name)
        if before:
            url += f"?before={before}"
        try:
            page = parse_page(http_get(url).text)
        except Exception:
            if before is None:  # первая страница не далась — источник падает
                raise
            break  # страница пагинации — берём уже собранное, как в проде
        if not page:
            break
        pages = page + pages
        nums = [n for n in (_post_num(p) for p, _, _ in page) if n]
        if not nums:
            break
        oldest = min(nums)
        if last_seen and oldest <= last_seen:
            break
        if not last_seen or len(page) < 2:
            break
        before = oldest
    return pages


def collect_tgweb(conn, source_id, name: str, last_seen: int) -> int:
    try:
        pages = fetch_tgweb_pages(name, last_seen)
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(f"превью канала закрыто (HTTP {exc.response.status_code})") from None
    if not pages:
        raise RuntimeError("превью канала закрыто или пусто")
    added, max_id = 0, last_seen
    for post_id, dt, text in pages:
        n = _post_num(post_id)
        max_id = max(max_id, n)
        if last_seen and n and n <= last_seen:
            continue
        title = " ".join(text.split())[:160]
        if db.insert_item(conn, source_id, f"https://t.me/{post_id}", title, _iso_dt(dt)):
            added += 1
    if max_id > (last_seen or 0):
        db.set_last_post_id(conn, source_id, max_id)
    return added


# --- диспетчер и прогон чата --------------------------------------------------------

def collect_one(conn, row) -> int:
    """Собрать источник (mapping: id, kind, url, last_post_id) в items.
    Статус ok обновляется здесь; ошибки — наверх (изоляция на collect_enabled)."""
    kind, url, source_id = row["kind"], row["url"], row["id"]
    if kind == "tgweb":
        added = collect_tgweb(conn, source_id, url, row["last_post_id"])
    elif kind == "html":
        added = collect_html(conn, source_id, url)
    else:  # rss (+ reddit-фиды), twitter — фид моста
        return collect_source(conn, source_id, fetch_url(kind, url))
    db.set_source_status(conn, source_id, "ok", None)
    log.info("OK %s: +%d новых", fetch_url(kind, url), added)
    return added


def collect_enabled(conn, chat_id):
    """Собрать все включённые источники чата (все типы). Отказ одного не валит
    прогон (NFR-02): ошибка — в лог с URL и исключением, tgweb/twitter —
    деградация (D3), остальные — error; сводка продолжается."""
    total = 0
    errors = []
    tgweb_seen = False
    for row in db.enabled_sources(conn, chat_id):
        if row["kind"] == "tgweb":
            if tgweb_seen:
                _pause(TGWEB_PAUSE)  # пауза между каналами t.me (FR-07)
            tgweb_seen = True
        try:
            total += collect_one(conn, row)
        except Exception as exc:
            try:
                failed_url = fetch_url(row["kind"], row["url"])
            except Exception:
                failed_url = row["url"]
            log.error("FAIL %s: %r", failed_url, exc)
            status = "degraded" if row["kind"] in DEGRADED_KINDS else "error"
            db.set_source_status(conn, row["id"], status, str(exc)[:200])
            errors.append((failed_url, exc))
    return total, errors


# --- превью мастера добавления -------------------------------------------------------

PREVIEW_NOUN = {"rss": "фид", "html": "страницу", "tgweb": "канал",
                "reddit": "фид", "twitter": "фид"}


def _entry_titles(entries, count=3) -> list[str]:
    return [e.get("title", "") for e in entries[:count] if e.get("title")]


def make_preview(kind: str, value: str) -> tuple[str, str, list[str]]:
    """Валидация ввода мастера + превью: (title, канонический url, заголовки).
    ValueError — формат ввода; RuntimeError — источник не читается (состояние
    AsUrl сохраняется, шаг повторяется — TC-12/TC-15…TC-19)."""
    if kind in ("rss", "html"):
        url = validate_http_url(value)
        if not url:
            raise ValueError("Это не похоже на ссылку. Отправьте адрес вида https://site.com/…")
        if kind == "rss":
            try:
                title, entries = fetch_feed(url)
            except Exception as exc:
                raise RuntimeError(f"Не удалось прочитать фид: {exc}") from None
            return title, url, _entry_titles(entries)
        try:
            items = parse_html_items(url, http_get(url).text)
        except Exception as exc:
            raise RuntimeError(f"Не удалось открыть страницу: {exc}") from None
        if not items:
            raise RuntimeError("На странице не найдено ссылок на статьи — это точно список новостей?")
        return urlsplit(url).netloc, url, [t for _u, t in items[:3]]
    if kind == "tgweb":
        name = tg_name(value)
        if not name:
            raise ValueError("Не похоже на имя канала. Отправьте имя (A-z, 0-9, _) или ссылку t.me/имя")
        try:
            pages = fetch_tgweb_pages(name, 0)
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Не удалось открыть канал: превью закрыто (HTTP {exc.response.status_code})") from None
        except Exception as exc:
            raise RuntimeError(f"Не удалось открыть канал: {exc}") from None
        if not pages:
            raise RuntimeError("Не удалось открыть канал: превью закрыто или постов нет")
        titles = [" ".join(t.split())[:60] for _pid, _dt, t in pages[-3:]][::-1]
        return f"t.me/{name}", name, titles
    if kind == "reddit":
        name = reddit_name(value)
        if not name:
            raise ValueError("Не похоже на имя сабреддита. Например: wallstreetbets или r/wallstreetbets")
        url = config.REDDIT_RSS_TEMPLATE.format(name=name)
        try:
            _title, entries = fetch_feed(url)
        except Exception as exc:
            raise RuntimeError(f"Не удалось прочитать фид сабреддита: {exc}") from None
        return f"r/{name}", url, _entry_titles(entries)
    if kind == "twitter":
        name = twitter_name(value)
        if not name:
            raise ValueError("Не похоже на имя аккаунта X. Например: @durov")
        try:
            _title, entries = fetch_feed(bridge_url(name))
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Не удалось прочитать фид моста: {exc}") from None
        return f"@{name}", name, _entry_titles(entries)
    raise ValueError("Неизвестный тип источника")
