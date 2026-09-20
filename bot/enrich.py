"""iter-14b (уровень 2): фоновая докачка полных текстов статей для пунктов
без собственного текста (RSS-фид дал только заголовок). Ссылка записи —
цель; извлечение текста — trafilatura (ленивый импорт: тяжёлая опциональная
зависимость). Неудача — enriched=2, повторов нет. Встраивается в collect_once
после сбора; вежливые паузы на домен против 403/429."""
import logging
import re
import time
from urllib.parse import urlsplit

from . import config

log = logging.getLogger("bot.enrich")

_sleep = time.sleep  # заменяется в тестах

URL_RE = re.compile(r"https?://[^\s)>\]]+", re.IGNORECASE)
_SKIP_HOSTS = ("t.me", "telegram.me", "telegram.dog", "x.com", "twitter.com")

_last_hit: dict[str, float] = {}  # host -> monotonic-время последнего запроса


def _polite_wait(host: str) -> None:
    """Пауза между запросами к одному домену (ENRICH_PAUSE)."""
    now = time.monotonic()
    prev = _last_hit.get(host)
    wait = config.ENRICH_PAUSE - (now - prev) if prev is not None else 0.0
    if wait > 0:
        _sleep(wait)
    _last_hit[host] = time.monotonic()


def extract_url(text: str) -> str | None:
    """Первая внешняя ссылка из текста (мессенджеры и соцсети — мимо)."""
    for match in URL_RE.finditer(text or ""):
        host = urlsplit(match.group(0)).netloc.lower()
        if host and not any(host == h or host.endswith("." + h)
                            for h in _SKIP_HOSTS):
            return match.group(0)
    return None


def fetch_article(url: str) -> str | None:
    """Скачать страницу и вытащить текст статьи. None — недоступно/мало
    текста (ENRICH_MIN_CHARS: заголовочные заглушки не храним)."""
    from .collectors.http import http_get

    try:
        _polite_wait(urlsplit(url).netloc.lower())
        page = http_get(url)
    except Exception as exc:
        log.warning("enrich FAIL %s: %r", url, exc)
        return None
    try:
        import trafilatura

        text = trafilatura.extract(
            page.text, include_comments=False, include_tables=True,
            favor_recall=True, url=url,
        ) or ""
    except Exception as exc:
        log.warning("enrich extract FAIL %s: %r", url, exc)
        return None
    text = " ".join(text.split())
    if len(text) < config.ENRICH_MIN_CHARS:
        return None
    return text[:config.ITEM_TEXT_CAP]


def enrich_once(conn) -> tuple[int, int]:
    """Один проход докачки: кандидаты из db.enrich_targets (квота
    ENRICH_MAX_PER_RUN). TG-пункты без текста — цель из первой внешней
    ссылки заголовка; у остальных — сама ссылка записи. Возвращает
    (успешно, попыток)."""
    from . import db

    rows = db.enrich_targets(conn, config.ENRICH_MAX_PER_RUN)
    done = 0
    for row in rows:
        target = row["url"] if row["kind"] != "tgweb" else extract_url(row["title"])
        text = fetch_article(target) if target else None
        db.set_item_text(conn, row["id"], text, 2)
        if text:
            done += 1
    if rows:
        log.info("enrich: +%d текстов из %d пунктов", done, len(rows))
    return done, len(rows)


def map_once(conn) -> tuple[int, int]:
    """Map-стадия (iter-14c): LLM-выжимка для пунктов с полным текстом
    (квота MAP_MAX_PER_RUN, пул MAP_WORKERS — вызовы LLM это I/O).
    '' — пустышка/сбой (исходник остаётся выдержкой ТЕКСТ в дайджесте).
    Возвращает (готово, попыток)."""
    from concurrent.futures import ThreadPoolExecutor

    from . import db, llm

    rows = db.map_targets(conn, config.MAP_MAX_PER_RUN)
    if not rows:
        return 0, 0
    workers = min(config.MAP_WORKERS, len(rows))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        gists = list(pool.map(llm.make_gist, [r["text"] for r in rows]))
    done = 0
    for row, gist in zip(rows, gists):  # БД — только из главного потока
        db.set_item_gist(conn, row["id"], gist)
        if gist:
            done += 1
    log.info("map: +%d выжимок из %d пунктов", done, len(rows))
    return done, len(rows)
