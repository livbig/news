import logging
from datetime import datetime
from pathlib import Path

from . import config, db, llm, telegram

log = logging.getLogger("digest")

SECTIONS = [
    ("metals_fx", "🥇 Металлы и валюты"),
    ("usmarket", "📈 Рынок США и инвест-идеи"),
    ("wsb", "🎯 Идеи с форумов (WSB)"),
    ("ipo_ai_bio", "🚀 IPO / AI / робототехника / биотех"),
    ("tech_ai", "🤖 Технологии и AI"),
    ("macro", "🏦 Макро и центробанки"),
    ("geopolitics", "🌍 Геополитика"),
    ("crypto", "₿ Крипта"),
]


def build_digest(conn) -> str | None:
    rows = conn.execute(
        "SELECT id, title, url, category, source, published FROM articles"
        " WHERE in_digest = 0 ORDER BY id"
    ).fetchall()
    if not rows:
        return None

    items_lines = [
        f"[{category}] {title} — {source} ({published or 'нет даты'}) — {url}"
        for _, title, url, category, source, published in rows
    ]
    digest = llm.summarize("\n".join(items_lines))

    conn.execute(f"UPDATE articles SET in_digest = 1 WHERE id IN ({','.join('?' * len(rows))})",
                 [row[0] for row in rows])
    conn.commit()
    log.info("Сводка по %d новостям сформирована", len(rows))
    return digest


def deliver(digest: str) -> bool:
    sent = telegram.send(digest)
    if not sent:
        config.DIGEST_DIR.mkdir(exist_ok=True)
        out = Path(config.DIGEST_DIR) / f"digest_{datetime.now():%Y%m%d_%H%M}.txt"
        out.write_text(digest, encoding="utf-8")
        print(digest)
        print(f"\n[сохранено в {out}]")
    return sent
