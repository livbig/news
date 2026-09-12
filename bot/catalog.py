"""Каталог источников онбординга (D21): статические данные, затравка — feeds.txt."""
import json
from pathlib import Path

# Порядок списка = приоритет тем пользователя (FR-02); первые пять — «глубокие»
TOPIC_PRIORITY = [
    "metals_fx",
    "usmarket",
    "wsb",
    "ipo_ai_bio",
    "tech_ai",
    "macro",
    "geopolitics",
    "crypto",
]
DEFAULT_TOPICS = TOPIC_PRIORITY[:5]

TOPIC_LABELS = {
    "metals_fx": "Драгметаллы и валюты",
    "usmarket": "Рынок США",
    "wsb": "Инвест-идеи (wallstreetbets)",
    "ipo_ai_bio": "IPO / AI / роботы / биотех",
    "tech_ai": "Технологии и AI",
    "macro": "Макро и центробанки",
    "geopolitics": "Геополитика",
    "crypto": "Крипта",
}

PICK_LIMIT = 8  # верхняя граница подборки, чтобы первая сводка не была шумом (план §1.4)

with open(Path(__file__).with_name("catalog_data.json"), encoding="utf-8") as _f:
    CATALOG = json.load(_f)


def pick(topic_ids) -> list[dict]:
    """Подборка каталога по темам; пустой выбор — дефолт по приоритетным темам (FR-02)."""
    chosen = (set(topic_ids) & set(TOPIC_PRIORITY)) or set(DEFAULT_TOPICS)
    result = []
    for topic in TOPIC_PRIORITY:
        if topic in chosen:
            result += [e for e in CATALOG if topic in e["topics"]]
    return result[:PICK_LIMIT]
