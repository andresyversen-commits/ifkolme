#!/usr/bin/env python3
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "sasong-2026.png"
LOGO = Path(__file__).resolve().parents[1] / "dist" / "logos" / "ifk-olme.png"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

MATCHES = [
    ("p10", "2026-05-03", "B", "Immetorp BK", 11, 2, "S"),
    ("p11", "2026-05-03", "B", "Degerfors IF", 0, 4, "T"),
    ("p10", "2026-05-10", "H", "Karlskoga SK", 3, 2, "S"),
    ("p11", "2026-05-10", "H", "Villastadens IF", 8, 2, "S"),
    ("p10", "2026-05-14", "B", "KB Karlskoga FF", 11, 5, "S"),
    ("p11", "2026-05-18", "H", "Immetorp BK", 5, 2, "S"),
    ("p10", "2026-05-24", "H", "Hammarö FK (syd)", 6, 7, "T"),
    ("p11", "2026-05-24", "B", "Karlskoga SK", 1, 10, "T"),
    ("p11", "2026-05-29", "H", "Björneborgs IF", 14, 1, "S"),
    ("p10", "2026-05-31", "B", "Filipstads FF", 25, 0, "S"),
    ("p11", "2026-06-03", "B", "Åtorps IF", 1, 5, "T"),
    ("p10", "2026-06-07", "H", "Åtorps IF", 5, 3, "S"),
    ("p11", "2026-06-10", "H", "KB Karlskoga FF", 3, 3, "U"),
    ("p10", "2026-06-16", "B", "Villastaden", 8, 1, "S"),
    ("p11", "2026-08-09", "B", "Bäckhammars SK", 3, 2, "S"),
    ("p10", "2026-08-13", "B", "Skattkärrs IF", 10, 3, "S"),
    ("p10", "2026-08-16", "H", "Degerfors IF", 8, 6, "S"),
    ("p11", "2026-08-16", "H", "IFK Kristinehamn Fotboll vit", 4, 2, "S"),
    ("p10", "2026-08-23", "H", "Immetorp BK", 6, 4, "S"),
    ("p11", "2026-08-23", "H", "Degerfors IF", 1, 11, "T"),
    ("p11", "2026-08-28", "B", "Villastadens IF", 3, 2, "S"),
    ("p10", "2026-08-30", "B", "Karlskoga SK", 6, 6, "U"),
    ("p10", "2026-09-06", "H", "KB Karlskoga FF", 8, 7, "S"),
    ("p11", "2026-09-06", "B", "Immetorp BK", 1, 3, "T"),
    ("p10", "2026-09-12", "B", "Hammarö FK", 7, 1, "S"),
    ("p11", "2026-09-13", "H", "Karlskoga SK", 3, 6, "T"),
    ("p11", "2026-09-20", "B", "Björneborgs IF", 5, 0, "S"),
]

SHORT = {
    "Villastadens IF": "Villastaden",
    "Villastaden": "Villastaden",
    "KB Karlskoga FF": "KB Karlskoga",
    "Hammarö FK (syd)": "Hammarö syd",
    "Hammarö FK": "Hammarö FK",
    "IFK Kristinehamn Fotboll vit": "Kristinehamn vit",
    "Bäckhammars SK": "Bäckhammar",
    "Björneborgs IF": "Björneborg",
    "Filipstads FF": "Filipstad",
    "Skattkärrs IF": "Skattkärr",
}

BG = (246, 247, 244)
INK = (22, 28, 24)
MUTED = (90, 98, 92)
LINE = (220, 224, 218)
GREEN = (27, 77, 43)
GREEN_SOFT = (232, 240, 233)
CARD = (255, 255, 255)
WIN = (32, 110, 62)
DRAW = (90, 98, 92)
LOSS = (163, 40, 40)


def font(path, size):
    return ImageFont.truetype(path, size)


def fmt_date(iso):
    y, m, d = iso.split("-")
    return f"{int(d)}.{int(m)}"


def venue_label(v):
    return "Hemma" if v == "H" else "Borta"


def outcome_label(o):
    return {"S": "Seier", "U": "Uavgjort", "T": "Tap"}[o]


def outcome_color(o):
    return {"S": WIN, "U": DRAW, "T": LOSS}[o]


def summarize(rows):
    w = sum(1 for r in rows if r[6] == "S")
    d = sum(1 for r in rows if r[6] == "U")
    l = sum(1 for r in rows if r[6] == "T")
    gf = sum(r[4] for r in rows)
    ga = sum(r[5] for r in rows)
    return w, d, l, gf, ga, gf - ga


def rounded(draw, box, r, fill, outline=None):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=1)


def main():
    p10 = [m for m in MATCHES if m[0] == "p10"]
    p11 = [m for m in MATCHES if m[0] == "p11"]
    s10 = summarize(p10)
    s11 = summarize(p11)
    sall = summarize(MATCHES)

    W = 1680
    row_h = 40
    header_block = 132
    cards_top = 160
    card_h = 168
    list_header = 88
    rows_n = max(len(p10), len(p11))
    H = cards_top + card_h + list_header + 36 + rows_n * row_h + 72
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    title = font(FONT_BOLD, 42)
    subtitle = font(FONT_REG, 20)
    card_kicker = font(FONT_BOLD, 15)
    card_big = font(FONT_BOLD, 36)
    card_sub = font(FONT_REG, 18)
    col_title = font(FONT_BOLD, 22)
    row_font = font(FONT_REG, 17)
    row_bold = font(FONT_BOLD, 17)
    row_small = font(FONT_REG, 14)
    footer_f = font(FONT_REG, 14)

    d.rectangle((0, 0, W, 132), fill=GREEN)
    if LOGO.exists():
        logo = Image.open(LOGO).convert("RGBA")
        logo.thumbnail((78, 78))
        img.paste(logo, (48, 27), logo)
        tx = 148
    else:
        tx = 48
    d.text((tx, 28), "IFK Ölme", font=title, fill=(255, 255, 255))
    d.text((tx, 82), "Säsongen 2026  ·  P 10 Grön & P 11 Blå", font=subtitle, fill=(210, 226, 214))

    cards = [
        ("P 10 GRÖN", s10, "13 kamper"),
        ("P 11 BLÅ", s11, "14 kamper"),
        ("SAMLET", sall, "27 kamper"),
    ]
    gap = 20
    card_w = (W - 96 - 2 * gap) // 3
    y0 = cards_top
    for i, (name, stats, games) in enumerate(cards):
        x = 48 + i * (card_w + gap)
        fill = GREEN_SOFT if i == 2 else CARD
        rounded(d, (x, y0, x + card_w, y0 + card_h), 16, fill, LINE)
        d.text((x + 24, y0 + 16), name, font=card_kicker, fill=GREEN)
        d.text((x + 24, y0 + 40), games, font=row_small, fill=MUTED)
        w, dr, l, gf, ga, gd = stats
        rec = f"{w}–{dr}–{l}"
        d.text((x + 24, y0 + 64), rec, font=card_big, fill=INK)
        gd_txt = f"+{gd}" if gd > 0 else str(gd)
        d.text((x + 24, y0 + 118), f"{gf}–{ga} i mål   {gd_txt}", font=card_sub, fill=MUTED)

    d.text((48, y0 + card_h + 18), "Seier – uavgjort – tap. Resultat vist som Ölme–motstander.", font=row_small, fill=MUTED)

    cols = [("P 10 Grön", p10), ("P 11 Blå", p11)]
    col_gap = 28
    col_w = (W - 96 - col_gap) // 2
    header_y = y0 + card_h + 52
    row_h = 40
    for ci, (cname, rows) in enumerate(cols):
        x = 48 + ci * (col_w + col_gap)
        d.text((x, header_y), cname, font=col_title, fill=INK)
        hy = header_y + 36
        d.text((x, hy), "Dato", font=row_small, fill=MUTED)
        d.text((x + 70, hy), "Bane", font=row_small, fill=MUTED)
        d.text((x + 150, hy), "Motstander", font=row_small, fill=MUTED)
        d.text((x + col_w - 168, hy), "Ölme", font=row_small, fill=MUTED)
        d.text((x + col_w - 78, hy), "Utfall", font=row_small, fill=MUTED)
        d.line((x, hy + 22, x + col_w, hy + 22), fill=LINE, width=1)
        for i, (_br, date, venue, opp, gf, ga, out) in enumerate(rows):
            y = hy + 30 + i * row_h
            if i % 2 == 0:
                rounded(d, (x - 8, y - 6, x + col_w + 8, y + row_h - 8), 8, (255, 255, 255))
            d.text((x, y), fmt_date(date), font=row_font, fill=MUTED)
            d.text((x + 70, y), venue_label(venue), font=row_font, fill=INK)
            d.text((x + 150, y), SHORT.get(opp, opp), font=row_font, fill=INK)
            score = f"{gf}–{ga}"
            sw = d.textlength(score, font=row_bold)
            d.text((x + col_w - 168, y), score, font=row_bold, fill=INK)
            label = outcome_label(out)
            lw = d.textlength(label, font=row_bold)
            d.text((x + col_w - lw, y), label, font=row_bold, fill=outcome_color(out))
            _ = sw

    d.text(
        (48, H - 42),
        "IFK Ölme 2015/2016  ·  Registrert kampresultat er hjemmelagets mål først  ·  2–3 borte = seier",
        font=footer_f,
        fill=MUTED,
    )
    img.save(OUT, "PNG", optimize=True)
    print(OUT, img.size)


if __name__ == "__main__":
    main()
