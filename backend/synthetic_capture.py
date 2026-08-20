"""Deterministic synthetic capture degradations for reference card images.

Purpose
-------
We have zero real phone photos for the newly-added games (One Piece, Lorcana,
Riftbound, Gundam), so the real-photo harness (``tools/eval_raw_visual_model.py``)
cannot be pointed at them. This module fabricates a *plausible* phone capture out
of a card's own reference image so that a directional retrieval number can be
produced offline, with no API credits and no labelled fixtures.

READ THIS BEFORE QUOTING ANY NUMBER PRODUCED FROM THIS MODULE
-------------------------------------------------------------
A score derived from these degradations is NOT an accuracy measurement. The
query image is a filtered copy of the very reference image that is sitting in
the index, so the two share pixel-level provenance that a real camera never
reproduces. Everything this module does is a hand-written approximation of one
optical or sensor effect; none of it models print variation, real ambient
lighting, sensor noise, lens characteristics, or holo-foil interference. Treat
the output only as (a) a floor and (b) a comparison between games measured under
byte-identical conditions.

Design rules
------------
* Every function is pure: image in, new image out. Nothing mutates its input.
* Every function takes an explicit ``numpy.random.Generator``. There is no
  unseeded randomness anywhere in this module.
* Every function is a visible no-op at ``strength <= 0`` and produces a
  *guaranteed visible* change at ``strength >= 1`` (magnitudes are drawn away
  from zero on purpose, so a degradation can never silently sample itself into
  an identity transform).
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from typing import Callable

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter


# ---------------------------------------------------------------------------
# Honesty text. Reused verbatim by the CLI --help epilog and the report header
# so the caveat cannot drift away from the numbers it qualifies.
# ---------------------------------------------------------------------------

CAVEAT_HEADLINE = "SYNTHETIC FLOOR - NOT AN ACCURACY BENCHMARK"

CAVEAT_LINES: tuple[str, ...] = (
    "These numbers are a synthetic FLOOR and a RELATIVE comparison between games.",
    "They are NOT a scanner accuracy claim and must not be reported as one.",
    "",
    "Why the number flatters itself:",
    "  * The query is a filtered copy of the SAME reference image that is in the",
    "    index. Query and gallery share pixel provenance no real camera can produce,",
    "    so retrieval is far easier here than on a real phone photo.",
    "  * Degradations are hand-written approximations, not a camera simulation.",
    "",
    "What is NOT modelled at all:",
    "  * print variation, card wear, surface texture and holo-foil interference",
    "  * real ambient lighting, mixed colour sources, shadows and reflections of",
    "    the room, hands, sleeves and playmats",
    "  * sensor noise, ISO grain, rolling shutter, lens distortion and demosaicing",
    "  * the real capture pipeline (reticle detection, normalisation, upload)",
    "",
    "What it IS good for:",
    "  * comparing games against each other under byte-identical conditions",
    "  * ranking WHICH degradation hurts a given catalog most",
    "  * catching a catastrophically bad index (near-duplicate art, dead images)",
    "",
    "A real accuracy number requires real photographed cards scored against a",
    "human-confirmed label. Nothing here substitutes for that.",
)


def caveat_block(prefix: str = "") -> str:
    lines = [f"{prefix}{CAVEAT_HEADLINE}", f"{prefix}{'-' * len(CAVEAT_HEADLINE)}"]
    lines.extend(f"{prefix}{line}".rstrip() for line in CAVEAT_LINES)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Deterministic seeding
# ---------------------------------------------------------------------------


def derive_seed(*parts: object) -> int:
    """Stable 64-bit seed from arbitrary parts.

    Uses blake2b rather than ``hash()`` because Python string hashing is salted
    per-process (PYTHONHASHSEED) and would make runs irreproducible.
    """
    digest = hashlib.blake2b("\x1f".join(str(part) for part in parts).encode("utf-8"), digest_size=8)
    return int.from_bytes(digest.digest(), "big")


def make_rng(*parts: object) -> np.random.Generator:
    return np.random.default_rng(derive_seed(*parts))


def _signed_magnitude(rng: np.random.Generator, low: float, high: float) -> float:
    """Draw a magnitude in [low, high] with a random sign, never near zero."""
    sign = 1.0 if rng.random() < 0.5 else -1.0
    return sign * float(rng.uniform(low, high))


def _to_float_array(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("RGB"), dtype=np.float32)


def _from_float_array(array: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(array, 0.0, 255.0).astype(np.uint8), mode="RGB")


# ---------------------------------------------------------------------------
# Individual degradations
# ---------------------------------------------------------------------------


def apply_specular_glare(image: Image.Image, rng: np.random.Generator, strength: float = 1.0) -> Image.Image:
    """Specular highlights plus highlight blooming.

    The dominant real-world failure mode for holo/foil cards: a light source
    reflects off the card surface, blows out a region toward white, and the
    blown-out region blooms into its neighbours. Modelled as 1-3 blurred,
    rotated elliptical hotspots screened toward white, followed by a bloom pass
    that re-blurs the brightest pixels back over the frame.
    """
    if strength <= 0:
        return image.copy()

    width, height = image.size
    mask = Image.new("L", (width, height), 0)
    blob_count = int(rng.integers(1, 4))

    for _ in range(blob_count):
        blob_width = max(8, int(width * float(rng.uniform(0.25, 0.65))))
        blob_height = max(6, int(height * float(rng.uniform(0.06, 0.22))))
        blob = Image.new("L", (blob_width, blob_height), 0)
        ImageDraw.Draw(blob).ellipse((0, 0, blob_width - 1, blob_height - 1), fill=255)
        blob = blob.rotate(float(rng.uniform(-75.0, 75.0)), resample=Image.BILINEAR, expand=True)
        offset_x = int(rng.integers(-blob.width // 2, max(1, width - blob.width // 2)))
        offset_y = int(rng.integers(-blob.height // 2, max(1, height - blob.height // 2)))
        layer = Image.new("L", (width, height), 0)
        layer.paste(blob, (offset_x, offset_y))
        mask = ImageChops.lighter(mask, layer)

    blur_radius = max(2.0, max(width, height) * 0.03)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    base = _to_float_array(image)
    mask_array = (np.asarray(mask, dtype=np.float32) / 255.0)[:, :, None]
    peak = min(0.97, 0.95 * float(strength))
    # Screen toward white: bright regions saturate, dark regions lift less.
    result = base + mask_array * peak * (255.0 - base)

    # Bloom: the blown-out pixels leak into their neighbourhood.
    luminance = result.mean(axis=2) / 255.0
    bright = np.clip((luminance - 0.72) / 0.28, 0.0, 1.0)
    bright_image = Image.fromarray((bright * 255.0).astype(np.uint8), mode="L")
    bloom = np.asarray(
        bright_image.filter(ImageFilter.GaussianBlur(radius=max(2.0, max(width, height) * 0.02))),
        dtype=np.float32,
    )
    result = result + (bloom[:, :, None] * 0.35 * float(strength))
    return _from_float_array(result)


def _shift_replicate(array: np.ndarray, shift_x: int, shift_y: int) -> np.ndarray:
    height, width = array.shape[:2]
    rows = np.clip(np.arange(height) - shift_y, 0, height - 1)
    columns = np.clip(np.arange(width) - shift_x, 0, width - 1)
    return array[rows][:, columns]


def apply_motion_blur(image: Image.Image, rng: np.random.Generator, strength: float = 1.0) -> Image.Image:
    """Directional (linear) motion blur from hand shake during capture.

    Implemented as an average of edge-replicated shifted copies along a random
    direction, which is exactly a convolution with a line kernel but needs no
    scipy dependency.
    """
    if strength <= 0:
        return image.copy()

    width, height = image.size
    span = max(3, int(round(max(width, height) * 0.018 * float(strength))))
    span = min(span, 41)
    angle = float(rng.uniform(0.0, np.pi))
    direction_x = float(np.cos(angle))
    direction_y = float(np.sin(angle))

    base = _to_float_array(image)
    accumulator = np.zeros_like(base)
    offsets = np.linspace(-span / 2.0, span / 2.0, num=span)
    for offset in offsets:
        accumulator += _shift_replicate(base, int(round(offset * direction_x)), int(round(offset * direction_y)))
    return _from_float_array(accumulator / float(len(offsets)))


def apply_defocus(image: Image.Image, rng: np.random.Generator, strength: float = 1.0) -> Image.Image:
    """Slight focus miss (the auto-focus has not settled yet)."""
    if strength <= 0:
        return image.copy()

    width, height = image.size
    radius = max(0.6, max(width, height) * float(rng.uniform(0.0030, 0.0075)) * float(strength))
    return image.convert("RGB").filter(ImageFilter.GaussianBlur(radius=radius))


def _perspective_coefficients(
    source_corners: list[tuple[float, float]],
    destination_corners: list[tuple[float, float]],
) -> list[float]:
    """Coefficients for ``Image.transform(..., Image.PERSPECTIVE, coeffs)``.

    PIL's perspective transform maps *output* coordinates back to *input*
    coordinates, so the returned coefficients solve destination -> source.
    """
    matrix: list[list[float]] = []
    for (source_x, source_y), (destination_x, destination_y) in zip(source_corners, destination_corners):
        matrix.append(
            [destination_x, destination_y, 1.0, 0.0, 0.0, 0.0, -source_x * destination_x, -source_x * destination_y]
        )
        matrix.append(
            [0.0, 0.0, 0.0, destination_x, destination_y, 1.0, -source_y * destination_x, -source_y * destination_y]
        )
    coefficient_matrix = np.asarray(matrix, dtype=np.float64)
    target = np.asarray(source_corners, dtype=np.float64).reshape(8)
    return list(np.linalg.solve(coefficient_matrix, target))


PERSPECTIVE_BACKGROUND_RGB = (38, 40, 44)


def apply_perspective_warp(image: Image.Image, rng: np.random.Generator, strength: float = 1.0) -> Image.Image:
    """Card photographed off-axis: the rectangle becomes a trapezoid.

    A dominant tilt axis (left/right/top/bottom edge foreshortened) plus
    per-corner jitter and a small in-plane rotation. Uncovered pixels are filled
    with a neutral dark background, matching a card lying on a table.
    """
    if strength <= 0:
        return image.copy()

    width, height = image.size
    source_corners = [(0.0, 0.0), (float(width), 0.0), (float(width), float(height)), (0.0, float(height))]

    tilt = min(0.22, float(rng.uniform(0.06, 0.13)) * float(strength))
    axis = int(rng.integers(0, 4))
    inset_x = width * tilt
    inset_y = height * tilt

    if axis == 0:  # right edge further away
        destination = [(0.0, 0.0), (width - inset_x, inset_y), (width - inset_x, height - inset_y), (0.0, float(height))]
    elif axis == 1:  # left edge further away
        destination = [(inset_x, inset_y), (float(width), 0.0), (float(width), float(height)), (inset_x, height - inset_y)]
    elif axis == 2:  # top edge further away
        destination = [(inset_x, 0.0), (width - inset_x, 0.0), (float(width), float(height)), (0.0, float(height))]
    else:  # bottom edge further away
        destination = [(0.0, 0.0), (float(width), 0.0), (width - inset_x, float(height)), (inset_x, float(height))]

    jitter_x = width * 0.02 * float(strength)
    jitter_y = height * 0.02 * float(strength)
    destination = [
        (x + float(rng.uniform(-jitter_x, jitter_x)), y + float(rng.uniform(-jitter_y, jitter_y)))
        for x, y in destination
    ]

    # Shrink slightly so the warped card stays inside the frame instead of
    # being clipped by it, then re-centre.
    centre_x, centre_y = width / 2.0, height / 2.0
    scale = 1.0 - 0.06 * float(strength)
    destination = [
        (centre_x + (x - centre_x) * scale, centre_y + (y - centre_y) * scale) for x, y in destination
    ]

    coefficients = _perspective_coefficients(source_corners, destination)
    warped = image.convert("RGB").transform(
        (width, height),
        Image.PERSPECTIVE,
        coefficients,
        resample=Image.BICUBIC,
        fillcolor=PERSPECTIVE_BACKGROUND_RGB,
    )

    rotation = _signed_magnitude(rng, 1.2, 3.5) * float(strength)
    return warped.rotate(
        rotation,
        resample=Image.BICUBIC,
        expand=False,
        fillcolor=PERSPECTIVE_BACKGROUND_RGB,
    )


def apply_off_center_crop(image: Image.Image, rng: np.random.Generator, strength: float = 1.0) -> Image.Image:
    """Imperfect reticle alignment: the crop is zoomed in and off-centre.

    Simulates the user not lining the card up with the on-screen reticle, so the
    normalised target loses a border on one side and gains framing slop on the
    other.
    """
    if strength <= 0:
        return image.copy()

    width, height = image.size
    keep = max(0.55, 1.0 - 0.16 * float(strength))
    window_width = max(16, int(round(width * keep)))
    window_height = max(16, int(round(height * keep)))

    slack_x = width - window_width
    slack_y = height - window_height
    # Offsets pushed away from centre so the crop is always visibly off-centre.
    offset_x = int(round(slack_x / 2.0 + _signed_magnitude(rng, 0.35, 1.0) * (slack_x / 2.0)))
    offset_y = int(round(slack_y / 2.0 + _signed_magnitude(rng, 0.35, 1.0) * (slack_y / 2.0)))
    offset_x = max(0, min(slack_x, offset_x))
    offset_y = max(0, min(slack_y, offset_y))

    cropped = image.convert("RGB").crop(
        (offset_x, offset_y, offset_x + window_width, offset_y + window_height)
    )
    return cropped.resize((width, height), resample=Image.BICUBIC)


def apply_jpeg_compression(image: Image.Image, rng: np.random.Generator, strength: float = 1.0) -> Image.Image:
    """JPEG ringing/blocking from on-device encoding before upload."""
    if strength <= 0:
        return image.copy()

    quality = int(round(88.0 - 48.0 * float(strength)))
    quality = max(8, min(95, quality))
    quality = max(8, min(95, quality + int(rng.integers(-8, 9))))

    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=quality, subsampling=2)
    buffer.seek(0)
    with Image.open(buffer) as decoded:
        return decoded.convert("RGB")


def apply_color_shift(image: Image.Image, rng: np.random.Generator, strength: float = 1.0) -> Image.Image:
    """White-balance and exposure error.

    Warm tungsten / cool LED venue lighting plus a mis-metered exposure. Sign
    and magnitude are drawn away from zero so this is never an accidental no-op.
    """
    if strength <= 0:
        return image.copy()

    temperature = _signed_magnitude(rng, 0.45, 1.0) * float(strength)
    brightness = 1.0 + _signed_magnitude(rng, 0.12, 0.30) * float(strength)
    contrast = 1.0 + _signed_magnitude(rng, 0.05, 0.16) * float(strength)

    gains = np.asarray(
        [
            1.0 + 0.18 * temperature,
            1.0 - 0.03 * abs(temperature),
            1.0 - 0.18 * temperature,
        ],
        dtype=np.float32,
    )

    base = _to_float_array(image)
    result = base * gains[None, None, :] * float(brightness)
    result = (result - 127.5) * float(contrast) + 127.5
    return _from_float_array(result)


# ---------------------------------------------------------------------------
# Registry, presets and composition
# ---------------------------------------------------------------------------

DegradationFn = Callable[[Image.Image, np.random.Generator, float], Image.Image]

# Applied in this order when several are combined. The order follows the
# physical capture chain: geometry -> light on the card -> optics -> sensor ->
# encoder.
DEGRADATION_ORDER: tuple[str, ...] = (
    "perspective",
    "crop",
    "glare",
    "defocus",
    "motion_blur",
    "color",
    "jpeg",
)

DEGRADATIONS: dict[str, DegradationFn] = {
    "perspective": apply_perspective_warp,
    "crop": apply_off_center_crop,
    "glare": apply_specular_glare,
    "defocus": apply_defocus,
    "motion_blur": apply_motion_blur,
    "color": apply_color_shift,
    "jpeg": apply_jpeg_compression,
}

DEGRADATION_DESCRIPTIONS: dict[str, str] = {
    "perspective": "off-axis perspective warp + slight in-plane rotation",
    "crop": "off-centre crop / imperfect reticle alignment",
    "glare": "specular glare + highlight blooming",
    "defocus": "slight defocus (auto-focus not settled)",
    "motion_blur": "directional motion blur (hand shake)",
    "color": "colour-temperature + brightness/contrast shift",
    "jpeg": "JPEG compression artefacts",
}

# Per-degradation strengths used by the combined "realistic" capture. Each one
# is deliberately moderate: a real bad capture is worse than this, a real good
# capture is better.
REALISTIC_STRENGTHS: dict[str, float] = {
    "perspective": 0.7,
    "crop": 0.8,
    "glare": 0.8,
    "defocus": 0.6,
    "motion_blur": 0.5,
    "color": 0.7,
    "jpeg": 0.7,
}


@dataclass(frozen=True)
class Condition:
    """A named bundle of degradations to apply together."""

    name: str
    strengths: dict[str, float]
    description: str

    @property
    def is_clean(self) -> bool:
        return not self.strengths


def build_conditions(scale: float = 1.0) -> list[Condition]:
    """The standard condition set: a clean control, each degradation on its own,
    then the combined realistic capture."""
    conditions = [
        Condition(
            name="clean",
            strengths={},
            description="control: untouched reference image (upper bound, not a real capture)",
        )
    ]
    for name in DEGRADATION_ORDER:
        conditions.append(
            Condition(
                name=name,
                strengths={name: REALISTIC_STRENGTHS[name] * scale},
                description=DEGRADATION_DESCRIPTIONS[name],
            )
        )
    conditions.append(
        Condition(
            name="realistic",
            strengths={name: value * scale for name, value in REALISTIC_STRENGTHS.items()},
            description="combined preset: every degradation at moderate strength",
        )
    )
    return conditions


def apply_condition(
    image: Image.Image,
    condition: Condition,
    *,
    seed: int,
    key: str = "",
) -> Image.Image:
    """Apply a condition's degradations in physical order.

    Each degradation gets its own generator derived from ``(seed, key, name)``,
    so adding or removing a degradation from a condition does not perturb the
    randomness of the others.
    """
    result = image.convert("RGB")
    for name in DEGRADATION_ORDER:
        strength = condition.strengths.get(name)
        if strength is None or strength <= 0:
            continue
        rng = make_rng(seed, key, condition.name, name)
        result = DEGRADATIONS[name](result, rng, float(strength))
    if result is image:
        return image.convert("RGB").copy()
    return result
