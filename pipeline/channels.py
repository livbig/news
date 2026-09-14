import logging
import re
from html import unescape

import httpx

from . import db, fetch

log = logging.getLogger("channels")

TEXT_RE = re.compile(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', re.S)
DT_RE = re.compile(r'datetime="([^"]+)"')


def parse_page(html: str) -> list[tuple[str, str, str]]:
    """HTML страницы t.me/s/<name> → [(post_id, datetime, text), ...]."""
    posts = []
    for chunk in html.split('data-post="')[1:]:
        m = re.match(r'([^"]+)"', chunk)
        if not m:
            continue
        post_id = m.group(1)
        tm = DT_RE.search(chunk)
        tx = TEXT_RE.search(chunk)
        if not tx:
            continue
        text = re.sub(r"<br\s*/?>", "\n", tx.group(1))
        text = re.sub(r"<[^>]+>", " ", text)
        text = unescape(text)
        text = "\n".join(" ".join(line.split()) for line in text.splitlines()).strip()
        if not text:
            continue
        posts.append((post_id, tm.group(1) if tm else "", text))
    return posts


def _post_num(post_id: str) -> int:
    tail = post_id.rsplit("/", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def _fetch_page(name: str, before: int | None) -> list[tuple[str, str, str]]:
    url = f"https://t.me/s/{name}" + (f"?before={before}" if before else "")
    response = httpx.get(url, headers=fetch.HEADERS, timeout=20, follow_redirects=True)
    response.raise_for_status()
    return parse_page(response.text)


def fetch_channel(conn, name: str, category: str) -> int:
    """Без пропусков: идём назад страницами t.me/s (?before=) до последнего
    обработанного поста (last_post_id), максимум 6 страниц за прогон."""
    row = conn.execute("SELECT last_post_id FROM channel_subs WHERE name = ?", (name,)).fetchone()
    last_seen = row[0] if row and row[0] else 0

    pages: list[tuple[str, str, str]] = []
    before = None
    for _ in range(6):
        try:
            page = _fetch_page(name, before)
        except httpx.HTTPError:
            if before is None:
                raise
            break
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

    added = 0
    max_id = last_seen
    for post_id, dt, text in pages:
        n = _post_num(post_id)
        if n > max_id:
            max_id = n
        if last_seen and n and n <= last_seen:
            continue
        url = f"https://t.me/{post_id}"
        if db.insert_article(conn, url, text[:160], category, source=f"t.me/{name}", published=dt):
            added += 1
    if max_id > (last_seen or 0):
        conn.execute("UPDATE channel_subs SET last_post_id = ? WHERE name = ?", (max_id, name))
    conn.commit()
    return added


def fetch_all_channels(conn) -> int:
    total = 0
    rows = conn.execute("SELECT name, category FROM channel_subs").fetchall()
    for name, category in rows:
        try:
            added = fetch_channel(conn, name, category)
            total += added
            log.info("OK канал t.me/%s [%s]: +%d постов", name, category, added)
        except Exception as exc:
            log.error("FAIL канал t.me/%s: %s", name, exc)
    return total
