"""Known "card-back placeholder" reference images that must never be embedded.

~70 catalog cards have no real front art on Scrydex. For those, Scrydex serves a
generic Pokémon CARD BACK image instead of the card face. Embedding a card back
creates a false "attractor" in the visual index: every affected card collapses to
the same point, so any scan that drifts toward a card back gets matched to an
arbitrary one of them. Two distinct generic card-back images account for all the
affected cards, and each is byte-identical across the cards it serves, so a small
sha256 allow-list is enough to catch them in both index builders.

Two entry paths must be guarded (see the builders for the call sites):
  (a) the incremental builder fabricating a Scrydex large-image URL for a card
      whose `image_url` is NULL, and
  (b) a card with a real, non-empty `image_url` whose URL still SERVES a card back
      (the McDonald's promo case) — only a content hash of the downloaded bytes
      catches this one.

Kept dependency-light (hashlib only) so both builders can import it cheaply.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

# sha256 of the two generic card-back images Scrydex serves for front-less cards.
#   - 49 cards: McDonald's promos mcd14/15/17/18 + hsp-HGSS18
#   - 21 JP promos
KNOWN_CARD_BACK_SHA256: frozenset[str] = frozenset(
    {
        "89724161e0680ed76259f32d3ad65b302172d0b32c9eaa52c16b5fe5d67d5872",
        "5b1e5bb6602761edf4bd09ed1bcca3351b0bd684bd15cbe92f7966c5f9c92e1b",
    }
)


def _raw_bytes(image_or_bytes_or_path: Any) -> bytes | None:
    """Best-effort extraction of the raw image bytes to hash.

    Accepts raw bytes, a filesystem path (str/Path) to a saved image, or a PIL
    image. Returns ``None`` when the bytes can't be read (e.g. a missing/unsaved
    file or a stub object), in which case the caller should treat it as "not a
    known card back" rather than erroring.
    """
    if isinstance(image_or_bytes_or_path, (bytes, bytearray)):
        return bytes(image_or_bytes_or_path)
    if isinstance(image_or_bytes_or_path, (str, Path)):
        try:
            return Path(image_or_bytes_or_path).read_bytes()
        except Exception:
            return None
    # PIL image: serialize to PNG bytes. Note: re-encoding a downloaded JPEG to PNG
    # would change the hash, so the saved-file/raw-bytes paths above are preferred.
    save = getattr(image_or_bytes_or_path, "save", None)
    if callable(save):
        try:
            import io

            buffer = io.BytesIO()
            save(buffer, format="PNG")
            return buffer.getvalue()
        except Exception:
            return None
    return None


def is_card_back_image(image_or_bytes_or_path: Any) -> bool:
    """Return True if the image is one of the known generic card-back placeholders.

    sha256-hashes the raw image bytes and checks membership in
    ``KNOWN_CARD_BACK_SHA256``. Unreadable inputs are treated as not-a-card-back.
    """
    raw = _raw_bytes(image_or_bytes_or_path)
    if raw is None:
        return False
    return hashlib.sha256(raw).hexdigest() in KNOWN_CARD_BACK_SHA256
