"""Branded share-card composition for "Who's That Pokemon".

Keeps all Pillow layout code out of server.py. The selfie bytes are handled
in memory only — the ONLY thing this module ever writes to disk is the
public PokeAPI official artwork (cached per Pokedex id under the dataset
root so repeat share cards don't re-download it).
"""

from __future__ import annotations

import io
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image, ImageDraw, ImageFont

ARTWORK_URL_TEMPLATE = (
    "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/"
    "other/official-artwork/{pokedex_id}.png"
)
ARTWORK_CACHE_DIRNAME = "pokeapi_artwork"
ARTWORK_FETCH_USER_AGENT = "SpotlightBackend/1.0 (whos-that-pokemon share card)"

CARD_WIDTH = 1080
CARD_HEIGHT = 1350
BACKGROUND_COLOR = (11, 11, 15)  # ~#0B0B0F
TEXT_PRIMARY = (245, 245, 248)
TEXT_MUTED = (156, 156, 168)
PILL_FILL = (255, 203, 5)  # Pokemon yellow
PILL_TEXT = (11, 11, 15)

_FONT_PATH = Path(__file__).resolve().parent / "assets" / "fonts" / "PlusJakartaSans-Bold.ttf"


def artwork_cache_dir(dataset_root: Path) -> Path:
    return Path(dataset_root) / ARTWORK_CACHE_DIRNAME


def fetch_official_artwork(pokedex_id: int, *, dataset_root: Path, timeout: int = 15) -> bytes:
    """Return the official-artwork PNG bytes for ``pokedex_id``.

    Serves from the on-disk cache when present; otherwise downloads from the
    public PokeAPI sprites repo and caches the bytes for next time.
    """
    cache_path = artwork_cache_dir(dataset_root) / f"{int(pokedex_id)}.png"
    if cache_path.exists():
        return cache_path.read_bytes()

    request = Request(ARTWORK_URL_TEMPLATE.format(pokedex_id=int(pokedex_id)))
    request.add_header("User-Agent", ARTWORK_FETCH_USER_AGENT)
    with urlopen(request, timeout=timeout) as response:
        artwork_bytes = response.read()

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(artwork_bytes)
    return artwork_bytes


def _load_font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype(str(_FONT_PATH), size)
    except Exception:  # noqa: BLE001 - fall back rather than fail the share card
        try:
            return ImageFont.load_default(size=size)
        except TypeError:  # pragma: no cover - very old Pillow
            return ImageFont.load_default()


def _rounded_selfie_thumb(selfie_jpeg: bytes, *, size: int = 380, radius: int = 48) -> Image.Image:
    selfie = Image.open(io.BytesIO(selfie_jpeg)).convert("RGB")
    # Center-crop to a square, then resize to the thumb size.
    side = min(selfie.width, selfie.height)
    left = (selfie.width - side) // 2
    top = (selfie.height - side) // 2
    selfie = selfie.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    thumb = Image.new("RGBA", (size, size))
    thumb.paste(selfie, (0, 0), mask)
    return thumb


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and draw.textlength(candidate, font=font) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def compose_share_card(
    *,
    selfie_jpeg: bytes,
    species: str,
    pokedex_id: int,
    reason: str,
    confidence: float,
    dataset_root: Path,
) -> bytes:
    """Compose the 1080x1350 share PNG and return its bytes (memory only)."""
    artwork_bytes = fetch_official_artwork(pokedex_id, dataset_root=dataset_root)

    canvas = Image.new("RGB", (CARD_WIDTH, CARD_HEIGHT), BACKGROUND_COLOR)
    draw = ImageDraw.Draw(canvas)

    # Official artwork, large on the right/center.
    artwork = Image.open(io.BytesIO(artwork_bytes)).convert("RGBA")
    artwork_width = 620
    artwork_height = max(1, round(artwork.height * artwork_width / max(1, artwork.width)))
    artwork = artwork.resize((artwork_width, artwork_height), Image.LANCZOS)
    canvas.paste(artwork, (CARD_WIDTH - artwork_width - 40, 140), artwork)

    # Selfie as a rounded-corner thumb, top-left.
    thumb = _rounded_selfie_thumb(selfie_jpeg)
    canvas.paste(thumb, (48, 48), thumb)

    # Header + species name.
    header_font = _load_font(40)
    draw.text((48, 470), "Who's That Pokemon?", font=header_font, fill=TEXT_MUTED)
    name_font = _load_font(96)
    draw.text((48, 790), species, font=name_font, fill=TEXT_PRIMARY)

    # Confidence pill.
    pill_font = _load_font(36)
    pill_label = f"{int(round(min(1.0, max(0.0, float(confidence))) * 100))}% match"
    pill_text_width = draw.textlength(pill_label, font=pill_font)
    pill_left, pill_top = 48, 920
    pill_right = pill_left + int(pill_text_width) + 48
    pill_bottom = pill_top + 60
    draw.rounded_rectangle((pill_left, pill_top, pill_right, pill_bottom), radius=30, fill=PILL_FILL)
    draw.text((pill_left + 24, pill_top + 10), pill_label, font=pill_font, fill=PILL_TEXT)

    # The one-liner quote, wrapped.
    quote_font = _load_font(44)
    quote_lines = _wrap_text(draw, f"“{reason}”", quote_font, CARD_WIDTH - 96)
    quote_y = 1030
    for line in quote_lines[:4]:
        draw.text((48, quote_y), line, font=quote_font, fill=TEXT_PRIMARY)
        quote_y += 58

    # Wordmark, bottom. The BRAND name — "Spotlight" is the repo/codename, and a
    # shared card is the most public surface the app has.
    wordmark_font = _load_font(40)
    draw.text((48, CARD_HEIGHT - 88), "Ekalight", font=wordmark_font, fill=TEXT_MUTED)

    output = io.BytesIO()
    canvas.save(output, format="PNG")
    return output.getvalue()
