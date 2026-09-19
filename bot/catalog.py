"""Каталог источников (D21 → 11d/D45): fallback-набор при недоступной LLM;
порядок = порядок файла. Темы/приоритеты удалены вместе с кнопочным онбордингом."""
import json
from pathlib import Path

with open(Path(__file__).with_name("catalog_data.json"), encoding="utf-8") as _f:
    CATALOG = json.load(_f)


def pick(topic_ids=None) -> list[dict]:
    """Fallback-пул: весь каталог, порядок файла (11d/D45; темы игнорируются)."""
    return list(CATALOG)
