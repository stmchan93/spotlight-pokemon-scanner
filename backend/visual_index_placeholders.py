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

A third path is not a URL problem at all: a NEW card whose front Scrydex hasn't
published yet is served a card back that no list knows. The duplicate-bytes
guard (`check_reference_image`) catches those by class: real art is unique per
card, so one image under several cards is a placeholder.

Kept dependency-light (stdlib only) so both builders can import it cheaply.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

# sha256 of the generic card-back images Scrydex serves for front-less cards
# (hash of the cached PNG the incremental builder writes).
#   - 49 cards: McDonald's promos mcd14/15/17/18 + hsp-HGSS18
#   - 21 JP promos
#   - 6 cards cached Aug-Oct 2026 before Scrydex published fronts: me55-R/G/B
#     (30th Celebration Mew RGB), mep-120, tcgp-B4-, tcgp-B4b-
KNOWN_CARD_BACK_SHA256: frozenset[str] = frozenset(
    {
        "89724161e0680ed76259f32d3ad65b302172d0b32c9eaa52c16b5fe5d67d5872",
        "5b1e5bb6602761edf4bd09ed1bcca3351b0bd684bd15cbe92f7966c5f9c92e1b",
        "503854c5405b9ee345438d19c80839211dc21690f41848e9ef70c03156b788e0",
    }
)

# Pixel-identical reference images are normal for a same-name reprint PAIR
# (TCG Pocket B4/B4b, One Piece re-listings: ~40 such pairs on prod 2026-11-20),
# so a shared hash alone can't reject. A third card with the same image, or two
# cards with different names, can only be a placeholder.
MAX_CARDS_PER_SHARED_IMAGE = 2

REFERENCE_HASH_INDEX_FILENAME = "_reference_image_sha256.json"


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
        except OSError:
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
        # Unwritable/undecodable image (OSError, ValueError) or a stub whose `save`
        # takes a different signature (AttributeError, TypeError).
        except (OSError, ValueError, AttributeError, TypeError):
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


# ---------------------------------------------------------------------------
# Duplicate-bytes guard (class-level): a placeholder shows up as the SAME image
# under several card ids long before anyone adds its hash to the list above.
# ---------------------------------------------------------------------------

REASON_KNOWN_CARD_BACK = "known_card_back"
REASON_LEARNED_PLACEHOLDER = "learned_placeholder_hash"
REASON_DIFFERENT_CARDS = "shared_across_different_cards"
REASON_TOO_MANY_CARDS = "shared_by_too_many_cards"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def encode_reference_png(image: Any) -> bytes | None:
    """The exact bytes the builder caches for a downloaded reference image
    (PIL ``save(path)`` with a .png suffix == ``save(buffer, format="PNG")``),
    or None when the object can't be serialized (test stubs)."""
    raw = _raw_bytes(image)
    return raw or None


class ReferenceImageHashes:
    """card id -> sha256 of its cached reference PNG (``<cache>/<id>.png``).

    Persisted next to the PNGs keyed by (size, mtime_ns), so a run only hashes
    new/changed files; the first run on a box hashes the whole cache once.
    """

    def __init__(self, cache_root: Path, records: dict[str, tuple[int, int, str]]) -> None:
        self.cache_root = Path(cache_root)
        self._records = records
        self._dirty = False

    @property
    def index_path(self) -> Path:
        return self.cache_root / REFERENCE_HASH_INDEX_FILENAME

    @classmethod
    def load(cls, cache_root: Path) -> "ReferenceImageHashes":
        cache_root = Path(cache_root)
        stored: dict[str, Any] = {}
        try:
            stored = json.loads((cache_root / REFERENCE_HASH_INDEX_FILENAME).read_text()).get("files", {})
        except (OSError, ValueError, AttributeError):
            stored = {}
        records: dict[str, tuple[int, int, str]] = {}
        dirty = False
        try:
            listing = list(os.scandir(cache_root))
        except OSError:
            listing = []
        for item in listing:
            if not item.name.endswith(".png") or not item.is_file():
                continue
            card_id = item.name[: -len(".png")]
            try:
                stat = item.stat()
            except OSError:
                continue
            previous = stored.get(card_id)
            if (
                isinstance(previous, list)
                and len(previous) == 3
                and previous[0] == stat.st_size
                and previous[1] == stat.st_mtime_ns
            ):
                records[card_id] = (stat.st_size, stat.st_mtime_ns, str(previous[2]))
                continue
            try:
                records[card_id] = (stat.st_size, stat.st_mtime_ns, _file_sha256(Path(item.path)))
            except OSError:
                continue
            dirty = True
        instance = cls(cache_root, records)
        instance._dirty = dirty or set(stored) != set(records)
        return instance

    def sha_for(self, card_id: str) -> str | None:
        record = self._records.get(card_id)
        return record[2] if record else None

    def card_ids_for(self, sha: str) -> list[str]:
        return sorted(cid for cid, record in self._records.items() if record[2] == sha)

    def groups(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for cid, record in self._records.items():
            out.setdefault(record[2], []).append(cid)
        return {sha: sorted(ids) for sha, ids in out.items()}

    def record(self, card_id: str, sha: str, path: Path | None = None) -> None:
        size, mtime = -1, -1
        if path is not None:
            try:
                stat = Path(path).stat()
                size, mtime = stat.st_size, stat.st_mtime_ns
            except OSError:
                pass
        self._records[card_id] = (size, mtime, sha)
        self._dirty = True

    def save(self) -> None:
        if not self._dirty:
            return
        payload = {"version": 1, "files": {cid: list(rec) for cid, rec in sorted(self._records.items())}}
        _write_json_atomic(self.index_path, payload)
        self._dirty = False


def _normalized_name(name: Any) -> str:
    return " ".join(str(name or "").casefold().split())


def placeholder_reason(
    sha: str,
    card_ids: Iterable[str],
    names: Mapping[str, Any],
    learned_hashes: Iterable[str] = (),
) -> str | None:
    """Why the cards sharing this image hash are placeholders, or None."""
    if sha in KNOWN_CARD_BACK_SHA256:
        return REASON_KNOWN_CARD_BACK
    if sha in set(learned_hashes):
        return REASON_LEARNED_PLACEHOLDER
    ids = sorted(set(card_ids))
    if len(ids) < 2:
        return None
    # Ids missing from the catalog have no name to compare; ignore them here.
    distinct_names = {_normalized_name(names.get(cid)) for cid in ids if names.get(cid)}
    if len(distinct_names) > 1:
        return REASON_DIFFERENT_CARDS
    if len(ids) > MAX_CARDS_PER_SHARED_IMAGE:
        return REASON_TOO_MANY_CARDS
    return None


@dataclass(frozen=True)
class ReferenceImageVerdict:
    card_id: str
    sha256: str
    accepted: bool
    reason: str | None = None
    shared_with: tuple[str, ...] = field(default_factory=tuple)


def check_reference_image(
    *,
    card_id: str,
    sha: str,
    hashes: ReferenceImageHashes,
    card_names: Callable[[list[str]], Mapping[str, Any]],
    learned_hashes: Iterable[str] = (),
) -> ReferenceImageVerdict:
    """Reject a downloaded reference image that is a known/learned placeholder
    or duplicates another card's cached image in a way only placeholders do.
    The card's own previous cached image never counts against it."""
    shared_with = tuple(cid for cid in hashes.card_ids_for(sha) if cid != card_id)
    group = [card_id, *shared_with]
    names = card_names(group) if shared_with else {}
    reason = placeholder_reason(sha, group, names, learned_hashes)
    return ReferenceImageVerdict(
        card_id=card_id, sha256=sha, accepted=reason is None, reason=reason, shared_with=shared_with
    )


# ---------------------------------------------------------------------------
# Denylist file (data/visual-index/placeholder_card_ids.json). Writers only
# append/remove the ids they own and keep every other key (manual notes, the
# audit tool's provenance) intact.
# ---------------------------------------------------------------------------


def _write_json_atomic(path: Path, payload: Any) -> None:
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(tmp, path)


def read_denylist(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def learned_placeholder_hashes(payload: Mapping[str, Any]) -> frozenset[str]:
    values = payload.get("placeholderImageSha256") or []
    return frozenset(str(v) for v in values if v) if isinstance(values, list) else frozenset()


def add_to_denylist(
    path: Path,
    flagged: Iterable[Mapping[str, Any]],
    *,
    learned_hashes: Iterable[str] = (),
    flagged_at: str | None = None,
) -> list[str]:
    """Append flagged card ids (+ learned placeholder hashes); return the ids
    that were newly added. Writes nothing when nothing changes."""
    payload = read_denylist(path)
    card_ids = [str(cid) for cid in payload.get("cardIds") or [] if cid]
    existing = set(card_ids)
    hashes = [str(h) for h in payload.get("placeholderImageSha256") or [] if h]
    new_hashes = [h for h in sorted(set(learned_hashes)) if h not in set(hashes)]
    records = list(payload.get("autoFlagged") or [])
    added: list[str] = []
    for item in flagged:
        cid = str(item.get("cardId") or "")
        if not cid or cid in existing:
            continue
        existing.add(cid)
        added.append(cid)
        records.append({**dict(item), "flaggedAt": flagged_at})
    if not added and not new_hashes:
        return []
    payload["cardIds"] = sorted(existing)
    payload["placeholderImageSha256"] = sorted(set(hashes) | set(new_hashes))
    payload["autoFlagged"] = records
    _write_json_atomic(path, payload)
    return added


def remove_from_denylist(path: Path, card_ids: Iterable[str]) -> list[str]:
    """Remove exactly these ids from ``cardIds``; return the ids removed."""
    payload = read_denylist(path)
    current = [str(cid) for cid in payload.get("cardIds") or [] if cid]
    targets = {str(cid) for cid in card_ids}
    removed = [cid for cid in current if cid in targets]
    if not removed:
        return []
    payload["cardIds"] = [cid for cid in current if cid not in targets]
    _write_json_atomic(path, payload)
    return removed
