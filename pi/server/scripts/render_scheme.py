# Схема из факта дня → PNG-карточка. Вход: JSON {title, subtitle, lines[]} на stdin.
# Выход: PNG в stdout. Рисуем сами, чтобы визуал был у каждого дня без внешних картинок.
import json
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
INK = (24, 30, 42)
MUTED = (108, 118, 132)
ACCENT = (198, 40, 40)
PAPER = (252, 250, 246)


def font(name, size):
    return ImageFont.truetype(f"{FONT_DIR}/{name}", size)


data = json.load(sys.stdin)
title = str(data.get("title") or "")[:80]
subtitle = str(data.get("subtitle") or "")[:110]

# В DejaVuSansMono нет ⟳/⟲ — меняем на совместимые ↻/↺, остальное рисуется как есть.
GLYPH_FIX = {"⟳": "↻", "⟲": "↺", "⟶": "→", "⇄": "↔"}


def fix(line):
    for bad, good in GLYPH_FIX.items():
        line = line.replace(bad, good)
    return line


lines = [fix(str(line)[:34]) for line in (data.get("lines") or [])][:6] or ["(схемы нет)"]

mono = font("DejaVuSansMono.ttf", 30)
f_title = font("DejaVuSans-Bold.ttf", 36)
f_sub = font("DejaVuSans.ttf", 22)

pad = 48
line_h = 44
width = 1120
height = pad + 52 + (28 if subtitle else 0) + 28 + line_h * len(lines) + pad

img = Image.new("RGB", (width, height), PAPER)
d = ImageDraw.Draw(img)

d.text((pad, pad), title, font=f_title, fill=INK)
y = pad + 52
if subtitle:
    d.text((pad, y), subtitle, font=f_sub, fill=MUTED)
    y += 28

# рамка схемы
box_top = y + 12
box_bottom = box_top + line_h * len(lines) + 24
d.rounded_rectangle([pad, box_top, width - pad, box_bottom], radius=14, fill=(255, 255, 255), outline=(226, 232, 240), width=2)

y = box_top + 14
for line in lines:
    d.text((pad + 18, y), line, font=mono, fill=INK)
    y += line_h

d.line([(pad, box_bottom + 18), (pad + 56, box_bottom + 18)], fill=ACCENT, width=4)

img.save(sys.stdout.buffer, "PNG", optimize=True)
