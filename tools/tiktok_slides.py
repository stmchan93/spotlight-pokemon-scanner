#!/usr/bin/env python3
"""Render TikTok slideshow frames (1080x1920) from the Ekalight catalog.

Modes:
  year   one slide per release year: that year's most expensive card,
         "No card this year" for gaps (the "2017: $0 / 2018: $14" format)
  list   every matching card, newest -> oldest (or --order asc)
  top    the N most expensive cards, cheapest first so the last slide is the payoff

Reads the public search API (staging by default), so prices are whatever the
app shows today. Output: numbered PNGs + preview.png contact sheet + slideshow.mp4
(silent; add a trending sound in CapCut/TikTok).

  python3 tools/tiktok_slides.py umbreon --mode year
  python3 tools/tiktok_slides.py charizard --mode top --count 8
  python3 tools/tiktok_slides.py "umbreon vmax" --mode list --exact
  python3 tools/tiktok_slides.py --manifest tools/tiktok_manifests/jumbo-500hp.json

--manifest renders a hand-made list instead (cards missing from the catalog,
like jumbo promos): {"title", "subtitle", "slides": [{"label", "name", "set",
"number", "release", "price", "image"} | {"label", "none": true}]}. "image" is a
URL or a path relative to the manifest file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BASE_URL = "https://looty.34.134.72.20.sslip.io"
APP_ICON = REPO / "apps/spotlight-rn/assets/images/icon.png"

W, H = 1080, 1920
CARD_W = 680
CARD_CENTER_Y = 760  # keeps the price above TikTok's caption/UI overlay (bottom ~25%)
GOLD = (255, 214, 64)
GREEN = (80, 230, 120)
RED = (255, 72, 72)
WHITE = (255, 255, 255)

FONT_HEADLINE = ["/System/Library/Fonts/Supplemental/Impact.ttf"]
FONT_BODY = ["/System/Library/Fonts/Supplemental/Arial Black.ttf"]
FONT_CJK = ["/System/Library/Fonts/Hiragino Sans GB.ttc"]


@dataclass
class Card:
    id: str
    name: str
    set_name: str
    number: str
    year: int
    release: str
    price: float | None
    image_url: str


def font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def body_font(text: str, size: int) -> ImageFont.FreeTypeFont:
    return font(FONT_BODY if text.isascii() else FONT_CJK, size)


def fetch_cards(base_url: str, query: str, game: str) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        qs = urllib.parse.urlencode({"q": query, "limit": 100, "offset": offset, "game": game})
        with urllib.request.urlopen(f"{base_url}/api/v1/cards/search?{qs}", timeout=60) as resp:
            payload = json.load(resp)
        rows.extend(payload.get("results") or [])
        if not payload.get("hasMore") or not payload.get("results") or offset > 2000:
            return rows
        offset += len(payload["results"])


def to_cards(rows: list[dict], query: str, language: str, exact: bool) -> list[Card]:
    wanted = query.strip().lower()
    tokens = wanted.split()
    seen: set[str] = set()
    cards: list[Card] = []
    for row in rows:
        name = (row.get("name") or "").strip()
        lowered = name.lower()
        if exact and lowered != wanted:
            continue
        if not all(t in lowered for t in tokens):
            continue
        if language != "any" and (row.get("language") or "").lower() != language:
            continue
        match = re.match(r"(\d{4})", row.get("setReleaseDate") or "")
        if not match or not row.get("imageURL") or row["id"] in seen:
            continue
        seen.add(row["id"])
        price = (row.get("pricing") or {}).get("market")
        cards.append(Card(
            id=row["id"],
            name=name,
            set_name=row.get("setName") or "",
            number=row.get("number") or "",
            year=int(match.group(1)),
            release=row.get("setReleaseDate") or "",
            price=float(price) if price else None,
            image_url=row["imageURL"],
        ))
    return cards


def load_image(url: str, cache: Path) -> Image.Image:
    if not url.startswith(("http://", "https://")):
        return Image.open(url).convert("RGBA")
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / (hashlib.sha1(url.encode()).hexdigest() + ".img")
    if not path.exists():
        req = urllib.request.Request(url, headers={"User-Agent": "ekalight-tiktok-slides"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            path.write_bytes(resp.read())
    return Image.open(path).convert("RGBA")


def fmt_price(price: float | None) -> str:
    if price is None:
        return "—"
    if price >= 1000:
        return f"${price:,.0f}"
    if price >= 100:
        return f"${price:.0f}"
    return f"${price:.2f}".replace(".00", "")


def outlined(draw: ImageDraw.ImageDraw, xy, text, fnt, fill, stroke=8, anchor="mm"):
    draw.text(xy, text, font=fnt, fill=fill, anchor=anchor, stroke_width=stroke, stroke_fill=(0, 0, 0))


def fit_font(text: str, size: int, max_w: int, headline: bool = False) -> ImageFont.FreeTypeFont:
    while size > 24:
        fnt = font(FONT_HEADLINE, size) if headline else body_font(text, size)
        if fnt.getlength(text) <= max_w:
            return fnt
        size -= 4
    return fnt


def background(art: Image.Image | None) -> Image.Image:
    if art is None:
        return Image.new("RGB", (W, H), (14, 16, 22))
    scale = max(W / art.width, H / art.height)
    bg = art.convert("RGB").resize((int(art.width * scale) + 1, int(art.height * scale) + 1))
    left, top = (bg.width - W) // 2, (bg.height - H) // 2
    bg = bg.crop((left, top, left + W, top + H)).filter(ImageFilter.GaussianBlur(40))
    return ImageEnhance.Brightness(bg).enhance(0.38)


def paste_card(canvas: Image.Image, art: Image.Image, center_y: int) -> int:
    ratio = CARD_W / art.width
    card = art.resize((CARD_W, int(art.height * ratio)), Image.LANCZOS)
    x, y = (W - card.width) // 2, center_y - card.height // 2
    shadow = Image.new("RGBA", (card.width + 120, card.height + 120), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((60, 70, card.width + 60, card.height + 70), 36, fill=(0, 0, 0, 200))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28)), (x - 60, y - 60))
    canvas.alpha_composite(card, (x, y))
    return y + card.height


def watermark(canvas: Image.Image) -> None:
    draw = ImageDraw.Draw(canvas)
    fnt = font(FONT_BODY, 34)
    text = "scanned with Ekalight"
    draw.text((W // 2, 1560), text, font=fnt, fill=(255, 255, 255, 170), anchor="mm",
              stroke_width=3, stroke_fill=(0, 0, 0, 170))


def card_slide(card: Card, art: Image.Image, label: str, price_color) -> Image.Image:
    canvas = background(art).convert("RGBA")
    draw = ImageDraw.Draw(canvas)
    outlined(draw, (W // 2, 180), label, fit_font(label, 140, W - 120, headline=True), GOLD, stroke=10)
    bottom = paste_card(canvas, art, CARD_CENTER_Y)
    subtitle = f"{card.set_name} · {card.number}" if card.number else card.set_name
    outlined(draw, (W // 2, bottom + 55), subtitle, fit_font(subtitle, 44, W - 120), WHITE, stroke=5)
    price = fmt_price(card.price)
    outlined(draw, (W // 2, bottom + 180), price, font(FONT_HEADLINE, 170), price_color, stroke=12)
    watermark(canvas)
    return canvas.convert("RGB")


def empty_slide(label: str, bg_art: Image.Image | None) -> Image.Image:
    canvas = background(bg_art).convert("RGBA")
    draw = ImageDraw.Draw(canvas)
    outlined(draw, (W // 2, 180), label, font(FONT_HEADLINE, 140), GOLD, stroke=10)
    # Holo-ish placeholder where the card would be.
    ph_w, ph_h = CARD_W, int(CARD_W * 1.395)
    holo = Image.new("RGB", (ph_w, ph_h))
    px = holo.load()
    for yy in range(ph_h):
        for xx in range(0, ph_w, 2):
            hue = (xx * 0.6 + yy * 0.35) % 360
            c = Image.new("HSV", (1, 1), (int(hue / 360 * 255), 150, 230)).convert("RGB").getpixel((0, 0))
            px[xx, yy] = c
            if xx + 1 < ph_w:
                px[xx + 1, yy] = c
    holo = holo.filter(ImageFilter.GaussianBlur(6)).convert("RGBA")
    mask = Image.new("L", holo.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, ph_w, ph_h), 36, fill=255)
    holo.putalpha(mask)
    top = CARD_CENTER_Y - ph_h // 2
    canvas.alpha_composite(holo, ((W - ph_w) // 2, top))
    outlined(draw, (W // 2, top + ph_h // 2 - 70), "No card in", font(FONT_HEADLINE, 120), WHITE, stroke=10)
    outlined(draw, (W // 2, top + ph_h // 2 + 70), "this year", font(FONT_HEADLINE, 120), WHITE, stroke=10)
    outlined(draw, (W // 2, top + ph_h + 180), "$0", font(FONT_HEADLINE, 170), RED, stroke=12)
    watermark(canvas)
    return canvas.convert("RGB")


def hook_slide(title: str, subtitle: str, art: Image.Image | None) -> Image.Image:
    canvas = background(art).convert("RGBA")
    draw = ImageDraw.Draw(canvas)
    lines = wrap(title, 14)
    y = H // 2 - (len(lines) - 1) * 95
    for line in lines:
        outlined(draw, (W // 2, y), line, fit_font(line, 170, W - 100, headline=True), WHITE, stroke=12)
        y += 190
    outlined(draw, (W // 2, y + 40), subtitle, fit_font(subtitle, 60, W - 120, headline=True), GOLD, stroke=8)
    return canvas.convert("RGB")


def end_slide(art: Image.Image | None) -> Image.Image:
    canvas = background(art).convert("RGBA")
    draw = ImageDraw.Draw(canvas)
    if APP_ICON.exists():
        icon = Image.open(APP_ICON).convert("RGBA").resize((300, 300), Image.LANCZOS)
        mask = Image.new("L", icon.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, 300, 300), 68, fill=255)
        icon.putalpha(mask)
        canvas.alpha_composite(icon, ((W - 300) // 2, 560))
    outlined(draw, (W // 2, 1010), "Which one do", font(FONT_HEADLINE, 120), WHITE, stroke=10)
    outlined(draw, (W // 2, 1140), "you own?", font(FONT_HEADLINE, 120), WHITE, stroke=10)
    outlined(draw, (W // 2, 1340), "Scan yours free", font(FONT_HEADLINE, 90), GOLD, stroke=8)
    outlined(draw, (W // 2, 1450), "on Ekalight", font(FONT_HEADLINE, 90), GOLD, stroke=8)
    return canvas.convert("RGB")


def wrap(text: str, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for word in words:
        if cur and len(cur) + 1 + len(word) > width:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    return lines + ([cur] if cur else [])


def contact_sheet(frames: list[Path], out: Path) -> None:
    thumbs = [Image.open(p).resize((216, 384)) for p in frames]
    cols = min(6, len(thumbs))
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 224 + 8, rows * 392 + 8), (0, 0, 0))
    for i, t in enumerate(thumbs):
        sheet.paste(t, (8 + (i % cols) * 224, 8 + (i // cols) * 392))
    sheet.save(out)


def render_video(frames: list[Path], seconds: float, out: Path, audio: Path | None = None) -> bool:
    if not shutil.which("ffmpeg"):
        return False
    listing = out.parent / "frames.txt"
    lines = []
    for p in frames:
        lines += [f"file '{p.name}'", f"duration {seconds}"]
    lines.append(f"file '{frames[-1].name}'")
    listing.write_text("\n".join(lines) + "\n")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing)]
    if audio:
        # Trim the track to the slideshow and fade out over the last second.
        total = seconds * len(frames)
        cmd += ["-i", str(audio), "-map", "0:v", "-map", "1:a",
                "-af", f"afade=t=out:st={max(total - 1, 0):.2f}:d=1", "-c:a", "aac", "-b:a", "192k",
                "-t", f"{total:.2f}"]
    cmd += ["-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-movflags", "+faststart", str(out)]
    return subprocess.run(cmd).returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query", nargs="?", help='card name, e.g. "umbreon" or "charizard ex"')
    ap.add_argument("--manifest", type=Path, help="render a hand-made slide list (JSON) instead of searching")
    ap.add_argument("--mode", choices=["year", "list", "top"], default="year")
    ap.add_argument("--order", choices=["asc", "desc"], help="default: year/top asc, list desc")
    ap.add_argument("--language", default="english", help='english | japanese | any')
    ap.add_argument("--exact", action="store_true", help="name must equal the query (drops V/VMAX/ex variants)")
    ap.add_argument("--from-year", type=int)
    ap.add_argument("--to-year", type=int)
    ap.add_argument("--min-price", type=float, default=0.0)
    ap.add_argument("--count", type=int, default=12, help="max card slides (top/list)")
    ap.add_argument("--title", help="hook slide text (default generated)")
    ap.add_argument("--audio", type=Path, help="music file (mp3/m4a/wav) to put under the mp4")
    ap.add_argument("--seconds", type=float, default=1.8, help="per-slide duration in the mp4")
    ap.add_argument("--game", default="pokemon")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    if args.manifest:
        title, subtitle, plan = load_manifest(args.manifest)
        title = args.title or title
        slug = args.manifest.stem
    elif not args.query:
        ap.error("give a card name or --manifest")
    else:
        title, subtitle, plan = search_plan(args)
        if not plan:
            return 1
        slug = re.sub(r"[^a-z0-9]+", "-", f"{args.query}-{args.mode}".lower()).strip("-")
    return render(args, title, subtitle, plan, slug)


def load_manifest(path: Path) -> tuple[str, str, list[tuple[str, Card | None]]]:
    spec = json.loads(path.read_text())
    plan: list[tuple[str, Card | None]] = []
    for i, slide in enumerate(spec["slides"]):
        if slide.get("none"):
            plan.append((slide["label"], None))
            continue
        image = slide["image"]
        if not image.startswith(("http://", "https://")):
            image = str((path.parent / image).resolve())
        release = str(slide.get("release", ""))
        plan.append((slide["label"], Card(
            id=slide.get("id") or f"manifest-{i}",
            name=slide["name"],
            set_name=slide.get("set", ""),
            number=slide.get("number", ""),
            year=int(release[:4]) if release[:4].isdigit() else 0,
            release=release,
            price=slide.get("price"),
            image_url=image,
        )))
    return spec.get("title", ""), spec.get("subtitle", ""), plan


def search_plan(args) -> tuple[str, str, list[tuple[str, Card | None]]]:
    rows = fetch_cards(args.base_url, args.query, args.game)
    cards = to_cards(rows, args.query, args.language.lower(), args.exact)
    if args.from_year:
        cards = [c for c in cards if c.year >= args.from_year]
    if args.to_year:
        cards = [c for c in cards if c.year <= args.to_year]
    if args.mode != "list":
        cards = [c for c in cards if c.price is not None and c.price >= args.min_price]
    if not cards:
        print(f"No cards matched {args.query!r} ({len(rows)} search rows before filtering).", file=sys.stderr)
        return "", "", []

    pretty = args.query.title()
    # (label, card or None) in display order
    plan: list[tuple[str, Card | None]] = []
    if args.mode == "year":
        best: dict[int, Card] = {}
        for c in cards:
            if c.year not in best or (c.price or 0) > (best[c.year].price or 0):
                best[c.year] = c
        years = range(min(best), max(best) + 1)
        if args.order == "desc":
            years = reversed(years)
        plan = [(f"{y}:", best.get(y)) for y in years]
        title = args.title or f"The most expensive {pretty} card every year"
        subtitle = f"{min(best)} → {max(best)}"
    elif args.mode == "top":
        picked = sorted(cards, key=lambda c: c.price or 0, reverse=True)[: args.count]
        picked.sort(key=lambda c: c.price or 0, reverse=args.order == "desc")
        plan = [(f"#{len(picked) - i}" if args.order != "desc" else f"#{i + 1}", c) for i, c in enumerate(picked)]
        title = args.title or f"Top {len(picked)} most expensive {pretty} cards"
        subtitle = "wait for #1"
    else:
        picked = sorted(cards, key=lambda c: (c.release, c.id), reverse=args.order != "asc")[: args.count]
        plan = [(str(c.year), c) for c in picked]
        title = args.title or f"Every {pretty} card"
        subtitle = "Newest → Oldest" if args.order != "asc" else "Oldest → Newest"
    return title, subtitle, plan


def render(args, title: str, subtitle: str, plan: list[tuple[str, Card | None]], slug: str) -> int:
    out = args.out or REPO / "tools/output/tiktok" / slug
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("[0-9][0-9]-*.png"):
        old.unlink()
    cache = REPO / "tools/output/tiktok/.image-cache"

    hero_card = max((c for _, c in plan if c), key=lambda c: c.price or 0)
    hero_art = load_image(hero_card.image_url, cache)
    max_price = hero_card.price or 0

    frames: list[Path] = []

    def save(img: Image.Image, name: str) -> None:
        path = out / f"{len(frames):02d}-{name}.png"
        img.save(path)
        frames.append(path)

    save(hook_slide(title, subtitle, hero_art), "hook")
    prev_art = hero_art
    for label, card in plan:
        if card is None:
            save(empty_slide(label, prev_art), f"{label.strip(':')}-none")
            continue
        art = load_image(card.image_url, cache)
        color = RED if card.price == max_price else GREEN
        save(card_slide(card, art, label, color), re.sub(r"[^a-z0-9]+", "-", f"{label}-{card.id}".lower()).strip("-"))
        prev_art = art
        print(f"  {label:<6} {fmt_price(card.price):>9}  {card.name} — {card.set_name} {card.number} ({card.release})".rstrip())
    save(end_slide(hero_art), "end")

    contact_sheet(frames, out / "preview.png")
    video = out / "slideshow.mp4"
    made_video = render_video(frames, args.seconds, video, args.audio)
    print(f"\n{len(frames)} slides → {out}")
    print(f"preview: {out / 'preview.png'}")
    if made_video:
        print(f"video:   {video}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
