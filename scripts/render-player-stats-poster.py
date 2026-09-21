#!/usr/bin/env python3
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "spelarstatistik-2026.png"
LOGO = Path(__file__).resolve().parents[1] / "dist" / "logos" / "ifk-olme.png"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

PLAYERS = [
    ("p2015-1", "Casper Larsson", 2015),
    ("p2015-2", "Kevin von Segebaden", 2015),
    ("p2015-3", "William Fredriksson", 2015),
    ("p2015-4", "Lucas Petterson Nordvall", 2015),
    ("p2015-5", "Alfred Knudsen", 2015),
    ("p2015-6", "Elliot Norman", 2015),
    ("p2015-7", "Lukas Leukumaa", 2015),
    ("p2015-8", "Axel Sjöquist", 2015),
    ("p2015-9", "Harry Martinsson", 2015),
    ("p2016-1", "Tage Jansson Syversen", 2016),
    ("p2016-2", "Loui Austrin", 2016),
    ("p2016-3", "Tristan Granath", 2016),
    ("p2016-4", "Elliot Stålhammar", 2016),
    ("p2016-5", "Hilmer Yvdal", 2016),
    ("p2016-6", "Benjamin Eliasson", 2016),
    ("p2016-7", "Walter Sylvaner", 2016),
    ("p2016-8", "Preston Allen", 2016),
    ("p2016-9", "Sigvard Holmqvist", 2016),
    ("p2016-10", "Ellen Norman", 2016),
    ("p-1777742521513-khoqhv", "Theo Särnholm", 2014),
]

MATCHES = [
    ("p10", ["p2015-3", "p2015-4", "p2015-7", "p2016-6", "p2016-4", "p2016-5", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], []),
    ("p11", ["p2015-5", "p2015-8", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-3", "p2016-1", "p2016-6", "p2016-7", "p-1777742521513-khoqhv"], []),
    ("p11", ["p2015-5", "p2015-8", "p2015-6", "p2015-9", "p2015-4", "p2015-7", "p2015-3", "p2016-8", "p-1777742521513-khoqhv", "p2016-6", "p2016-7"], []),
    ("p10", ["p2015-9", "p2015-7", "p2015-5", "p2016-6", "p2016-5", "p2016-8", "p2016-9", "p2016-3", "p2016-7", "p2016-1"], []),
    ("p10", ["p2015-7", "p2015-1", "p2015-5", "p2016-6", "p2016-8", "p2016-9", "p2016-7"], []),
    ("p11", ["p2015-5", "p2015-8", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2015-3", "p2016-3", "p2016-5", "p2016-9", "p-1777742521513-khoqhv"], []),
    ("p11", ["p2015-5", "p2015-8", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2015-3", "p2016-5", "p2016-6", "p2016-7", "p-1777742521513-khoqhv"], ["p2015-3"]),
    ("p10", ["p2015-3", "p2015-4", "p2015-9", "p2016-6", "p2016-10", "p2016-4", "p2016-5", "p2016-2", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], ["p2015-3"]),
    ("p11", ["p2015-5", "p2015-8", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2015-3", "p2016-1", "p2016-4", "p2016-8", "p-1777742521513-khoqhv"], []),
    ("p10", ["p2015-1", "p2015-5", "p2015-7", "p2016-6", "p2016-10", "p2016-4", "p2016-5", "p2016-2", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], ["p2016-10"]),
    ("p11", ["p2015-5", "p2015-8", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2015-3", "p2016-2", "p2016-3", "p2016-6", "p2016-7", "p-1777742521513-khoqhv"], ["p2016-2", "p2016-3"]),
    ("p10", ["p2015-8", "p2015-6", "p2015-9", "p2016-6", "p2016-10", "p2016-4", "p2016-5", "p2016-2", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], ["p2016-10"]),
    ("p11", ["p2015-5", "p2015-8", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2015-3", "p2016-1", "p2016-5", "p2016-9", "p-1777742521513-khoqhv"], []),
    ("p10", ["p2015-2", "p2015-1", "p2015-4", "p2016-6", "p2016-10", "p2016-4", "p2016-5", "p2016-2", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], []),
    ("p11", ["p2015-5", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2016-5", "p2016-6", "p2016-7", "p2016-8", "p-1777742521513-khoqhv"], ["p-1777742521513-khoqhv", "p2015-8", "p2015-3", "p2016-10"]),
    ("p10", ["p2015-2", "p2015-7", "p2016-6", "p2016-10", "p2016-4", "p2016-5", "p2016-2", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7", "p2015-9"], ["p2015-3", "p2016-10"]),
    ("p11", ["p2015-5", "p2015-8", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2015-3", "p2016-1", "p2016-6", "p2016-7", "p-1777742521513-khoqhv"], ["p2016-2", "p2016-10"]),
    ("p10", ["p2015-3", "p2015-2", "p2015-1", "p2016-2", "p2016-1", "p2016-7", "p2016-6"], []),
    ("p10", ["p2015-2", "p2015-1", "p2015-3", "p2016-6", "p2016-10", "p2016-4", "p2016-5", "p2016-2", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], []),
    ("p11", ["p2015-5", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2016-5", "p2016-9", "p2016-1", "p2016-7", "p2016-8", "p-1777742521513-khoqhv"], ["p2015-8", "p2015-3"]),
    ("p11", ["p2015-2", "p2015-9", "p2015-6", "p2015-1", "p2015-7", "p2016-6", "p2016-7", "p2016-8", "p2015-4", "p2015-5", "p-1777742521513-khoqhv"], []),
    ("p10", ["p2015-3", "p2015-2", "p2015-7", "p2016-6", "p2016-10", "p2016-4", "p2016-5", "p2016-2", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], ["p2016-10"]),
    ("p10", ["p2015-2", "p2015-4", "p2015-1", "p2016-6", "p2016-4", "p2016-5", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], ["p2016-10"]),
    ("p11", ["p2015-5", "p2015-8", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2016-1", "p2016-5", "p2016-9", "p2016-6", "p2016-7", "p-1777742521513-khoqhv"], ["p2015-3", "p2016-10"]),
    ("p10", ["p2015-2", "p2015-7", "p2015-9", "p2016-6", "p2016-4", "p2016-5", "p2016-2", "p2016-8", "p2016-9", "p2016-1", "p2016-3", "p2016-7"], ["p2016-10"]),
    ("p11", ["p2015-5", "p2015-8", "p2015-1", "p2015-6", "p2015-9", "p2015-2", "p2015-4", "p2015-7", "p2015-3", "p2016-1", "p2016-6", "p2016-7", "p-1777742521513-khoqhv"], []),
    ("p11", ["p2015-5", "p2015-8", "p2015-6", "p2015-9", "p2015-2", "p2015-7", "p2015-3", "p2016-5", "p2016-8", "p2016-9", "p-1777742521513-khoqhv"], []),
]

DISPLAY = {
    "Kevin von Segebaden": "Kevin von Segebaden",
    "Lucas Petterson Nordvall": "Lucas Nordvall",
    "Tage Jansson Syversen": "Tage Jansson Syversen",
}

BG = (246, 247, 244)
INK = (22, 28, 24)
MUTED = (90, 98, 92)
LINE = (220, 224, 218)
GREEN = (27, 77, 43)
GREEN_SOFT = (232, 240, 233)
CARD = (255, 255, 255)
DECLINE = (163, 40, 40)


def font(path, size):
    return ImageFont.truetype(path, size)


def eligible(year, branch):
    if branch == "p11":
        return year in (2014, 2015, 2016)
    return year in (2015, 2016)


def counts_as_played(branch, selected, declined, pid, year):
    if pid not in selected:
        return False
    if pid in declined:
        return False
    return eligible(year, branch)


def stats_for(scope):
    rows = []
    for pid, name, year in PLAYERS:
        played = 0
        declined_n = 0
        for branch, selected, declined in MATCHES:
            if scope != "both" and branch != scope:
                continue
            if counts_as_played(branch, selected, declined, pid, year):
                played += 1
            if pid in declined:
                declined_n += 1
        rows.append((pid, name, year, played, declined_n))
    rows.sort(key=lambda r: (-r[3], r[1]))
    return rows


def rounded(draw, box, r, fill, outline=None):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=1)


def main():
    p10 = stats_for("p10")
    p11 = stats_for("p11")
    both = stats_for("both")
    n10 = sum(1 for m in MATCHES if m[0] == "p10")
    n11 = sum(1 for m in MATCHES if m[0] == "p11")

    W = 1680
    row_h = 38
    cards_top = 160
    card_h = 118
    rows_n = len(PLAYERS)
    H = cards_top + card_h + 86 + rows_n * row_h + 72

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    title = font(FONT_BOLD, 42)
    subtitle = font(FONT_REG, 20)
    card_kicker = font(FONT_BOLD, 15)
    card_big = font(FONT_BOLD, 32)
    card_sub = font(FONT_REG, 16)
    col_title = font(FONT_BOLD, 22)
    row_font = font(FONT_REG, 16)
    row_bold = font(FONT_BOLD, 16)
    row_small = font(FONT_REG, 13)
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
    d.text((tx, 82), "Spelarstatistik 2026  ·  P 10 Grön & P 11 Blå", font=subtitle, fill=(210, 226, 214))

    cards = [
        ("P 10 GRÖN", f"{n10} kamper", "Födda 2015 och 2016"),
        ("P 11 BLÅ", f"{n11} kamper", "Födda 2014 räknas bara här"),
        ("SAMLET", "27 kamper", "P 10 och P 11 tillsammans"),
    ]
    gap = 20
    card_w = (W - 96 - 2 * gap) // 3
    y0 = cards_top
    for i, (name, games, note) in enumerate(cards):
        x = 48 + i * (card_w + gap)
        fill = GREEN_SOFT if i == 2 else CARD
        rounded(d, (x, y0, x + card_w, y0 + card_h), 16, fill, LINE)
        d.text((x + 24, y0 + 16), name, font=card_kicker, fill=GREEN)
        d.text((x + 24, y0 + 42), games, font=card_big, fill=INK)
        d.text((x + 24, y0 + 84), note, font=card_sub, fill=MUTED)

    d.text(
        (48, y0 + card_h + 16),
        "Matcher = genomförda där spelaren räknas som deltagare.  Nej = tackade nej.  Samma regler som i appen.",
        font=row_small,
        fill=MUTED,
    )

    cols = [("P 10 Grön", p10, n10), ("P 11 Blå", p11, n11), ("Samlet", both, 27)]
    col_gap = 24
    col_w = (W - 96 - 2 * col_gap) // 3
    header_y = y0 + card_h + 46
    for ci, (cname, rows, total) in enumerate(cols):
        x = 48 + ci * (col_w + col_gap)
        d.text((x, header_y), cname, font=col_title, fill=INK)
        hy = header_y + 34
        d.text((x, hy), "Namn", font=row_small, fill=MUTED)
        d.text((x + col_w - 118, hy), "År", font=row_small, fill=MUTED)
        d.text((x + col_w - 78, hy), "M", font=row_small, fill=MUTED)
        d.text((x + col_w - 36, hy), "Nej", font=row_small, fill=MUTED)
        d.line((x, hy + 20, x + col_w, hy + 20), fill=LINE, width=1)
        for i, (_pid, name, year, played, declined_n) in enumerate(rows):
            y = hy + 28 + i * row_h
            if i % 2 == 0:
                rounded(d, (x - 6, y - 6, x + col_w + 6, y + row_h - 10), 8, (255, 255, 255))
            shown = DISPLAY.get(name, name)
            d.text((x, y), shown, font=row_font, fill=INK)
            d.text((x + col_w - 118, y), str(year), font=row_font, fill=MUTED)
            score_col = GREEN if played == total else INK
            d.text((x + col_w - 78, y), str(played), font=row_bold, fill=score_col)
            d.text(
                (x + col_w - 36, y),
                str(declined_n),
                font=row_bold,
                fill=DECLINE if declined_n else MUTED,
            )

    d.text(
        (48, H - 42),
        "Födda 2014 räknas bara i P 11.  Sorterat efter flest matcher, sedan namn.",
        font=footer_f,
        fill=MUTED,
    )
    img.save(OUT, "PNG", optimize=True)
    print(OUT, img.size)
    for label, rows, total in cols:
        print(label, total)
        for r in rows:
            print(f"  {r[1]:28} {r[2]}  {r[3]:2}/{total}  nej {r[4]}")


if __name__ == "__main__":
    main()
