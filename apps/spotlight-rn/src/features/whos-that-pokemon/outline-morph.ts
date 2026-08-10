/**
 * Geometry for the "Who's That Pokémon?" shape morph.
 *
 * The reveal used to hard-cut the selfie to the artwork in 40ms under a full
 * white-out — the flash existed to hide a swap. Nothing morphed. This module is
 * the replacement: it turns the two outlines the backend traces into a single
 * SVG path that can be evaluated at any `t` in 0..1, so the silhouette actually
 * DEFORMS from your shape into the creature's.
 *
 * COORDINATE SPACES (mixing them up is how this animation looks broken):
 *
 *  1. CUTOUT space  — `personOutline` points, normalized 0..1 against the
 *                     person-cutout PNG (which preserves the selfie's aspect).
 *  2. ARTWORK space — `speciesOutline` points, normalized 0..1 against the
 *                     official artwork PNG.
 *  3. LAYOUT space  — pixels inside the animating container. Everything this
 *                     module returns after projection is in LAYOUT space.
 *
 * WHY IT DOES NOT TWIST: both outlines come off the same backend tracer, which
 * casts rays from the shape's centroid at evenly spaced bearings. Rather than
 * trusting the raw arrays to line up index-for-index — rays that miss are
 * dropped server-side, and mirroring the selfie for display reverses the
 * winding — both shapes are RESAMPLED here onto the same fixed set of bearings
 * about their own centroids. After that, index i is the same bearing on both
 * shapes by construction, so a straight point-for-point lerp is a valid,
 * monotonic, non-crossing morph.
 */

import { projectSpeciesOutline, type Point, type Rect } from './face-geometry';

/** Bearings sampled per shape. Matches the backend's OUTLINE_POINT_COUNT. */
export const MORPH_POINT_COUNT = 48;

const TAU = Math.PI * 2;
/** Below this a bounding box is degenerate and cannot be fitted anywhere. */
const MIN_EXTENT = 1e-6;

const UNIT_RECT: Rect = { x: 0, y: 0, width: 1, height: 1 };

function centroidOf(points: readonly Point[]): Point {
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  return { x: sumX / points.length, y: sumY / points.length };
}

/**
 * NORMALIZED space → LAYOUT space, fitting the outline's own bounding box into
 * `rect` with a `contain` fit.
 *
 * The species outline is projected straight onto the rect the artwork is drawn
 * in (see `projectOutlineOntoRect`) because the path has to land exactly where
 * the coloured PNG will appear. YOUR outline has no such anchor — the cutout is
 * a whole selfie frame, so a raw projection would drop a tall, off-centre sliver
 * wherever you happened to stand. Fitting the bbox instead puts both shapes in
 * the same box at comparable size, which is the trick `morph-loop` already
 * relies on: same box, same colour, so the ONLY thing that changes is the
 * outline.
 *
 * `mirrorX` mirrors in normalized space first, because the selfie is flipped for
 * display — without it your silhouette is your reflection.
 */
export function fitOutlineIntoRect(
  outline: readonly Point[] | null | undefined,
  rect: Rect,
  options: { mirrorX?: boolean } = {},
): Point[] {
  const sanitized = projectSpeciesOutline(outline, UNIT_RECT);
  if (sanitized.length === 0 || !(rect.width > 0) || !(rect.height > 0)) {
    return [];
  }
  const points = options.mirrorX
    ? sanitized.map((point) => ({ x: 1 - point.x, y: point.y }))
    : sanitized;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const boxWidth = maxX - minX;
  const boxHeight = maxY - minY;
  if (boxWidth < MIN_EXTENT || boxHeight < MIN_EXTENT) {
    return [];
  }

  const scale = Math.min(rect.width / boxWidth, rect.height / boxHeight);
  const offsetX = rect.x + (rect.width - boxWidth * scale) / 2;
  const offsetY = rect.y + (rect.height - boxHeight * scale) / 2;
  return points.map((point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale,
  }));
}

/**
 * NORMALIZED space → LAYOUT space, straight onto `rect`. Thin alias over
 * `projectSpeciesOutline` so callers do not have to know that the species path
 * and the artwork image share a rect — they must, or the shape jumps when the
 * colour fades in.
 */
export function projectOutlineOntoRect(
  outline: readonly Point[] | null | undefined,
  rect: Rect,
): Point[] {
  return projectSpeciesOutline(outline, rect);
}

/**
 * Resample an outline onto `count` evenly spaced bearings about its centroid.
 *
 * This is what makes index i mean the same thing on both shapes regardless of
 * how many points survived server-side, which direction the array winds, or
 * where it started. The backend traced these radially in the first place, so
 * sampling radially loses nothing it had.
 *
 * Returns `[]` for anything too small to be a shape.
 */
export function resampleOutlineByAngle(
  points: readonly Point[] | null | undefined,
  count = MORPH_POINT_COUNT,
): Point[] {
  if (!points || points.length < 3 || count < 3) {
    return [];
  }
  const center = centroidOf(points);

  const samples: { angle: number; radius: number }[] = [];
  for (const point of points) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const radius = Math.hypot(dx, dy);
    if (!Number.isFinite(radius)) {
      continue;
    }
    let angle = Math.atan2(dy, dx);
    if (angle < 0) {
      angle += TAU;
    }
    samples.push({ angle, radius });
  }
  if (samples.length < 3) {
    return [];
  }
  samples.sort((left, right) => left.angle - right.angle);

  const total = samples.length;
  const resampled: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const target = (index / count) * TAU;

    // Bracketing pair, walking the sorted ring. `total` is 48-ish and this runs
    // once per layout, so the linear scan is cheaper than the bookkeeping a
    // binary search would need for the wraparound case.
    let start = total - 1;
    for (let cursor = 0; cursor < total; cursor += 1) {
      if (samples[cursor].angle > target) {
        start = (cursor - 1 + total) % total;
        break;
      }
      if (cursor === total - 1) {
        start = total - 1;
      }
    }
    const end = (start + 1) % total;
    const startAngle = samples[start].angle;
    let span = samples[end].angle - startAngle;
    if (span <= 0) {
      span += TAU;
    }
    let offset = target - startAngle;
    if (offset < 0) {
      offset += TAU;
    }
    const weight = span < MIN_EXTENT ? 0 : Math.min(1, Math.max(0, offset / span));
    const radius = samples[start].radius + (samples[end].radius - samples[start].radius) * weight;

    resampled.push({
      x: center.x + Math.cos(target) * radius,
      y: center.y + Math.sin(target) * radius,
    });
  }
  return resampled;
}

/**
 * Point-for-point interpolation between two outlines. Runs on the UI thread
 * every frame, so it is a worklet.
 *
 * Lengths are expected to match (both sides go through
 * `resampleOutlineByAngle`), but a mismatch is resolved by index-proportional
 * sampling rather than by bailing out — a slightly coarse morph beats a blank
 * screen.
 */
export function lerpOutline(
  from: readonly Point[],
  to: readonly Point[],
  t: number,
): Point[] {
  'worklet';
  if (to.length === 0) {
    return from as Point[];
  }
  if (from.length === 0) {
    return to as Point[];
  }
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const count = to.length;
  const points: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const source =
      from.length === count
        ? from[index]
        : from[Math.min(from.length - 1, Math.round((index * from.length) / count))];
    const target = to[index];
    points.push({
      x: source.x + (target.x - source.x) * clamped,
      y: source.y + (target.y - source.y) * clamped,
    });
  }
  return points;
}

function round2(value: number): number {
  'worklet';
  return Math.round(value * 100) / 100;
}

/**
 * Closed smooth path through `points`, as an SVG `d` string.
 *
 * Catmull-Rom converted to cubic béziers: straight segments between 48 radial
 * samples read as a faceted polygon, which is exactly the "cheap" tell an
 * organic silhouette cannot afford. The curve passes through every sample, so
 * the shape is still the traced one.
 */
export function outlinePathD(points: readonly Point[]): string {
  'worklet';
  const count = points.length;
  if (count < 3) {
    return '';
  }
  let d = `M ${round2(points[0].x)} ${round2(points[0].y)}`;
  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count];
    const current = points[index];
    const next = points[(index + 1) % count];
    const after = points[(index + 2) % count];
    const c1x = current.x + (next.x - previous.x) / 6;
    const c1y = current.y + (next.y - previous.y) / 6;
    const c2x = next.x - (after.x - current.x) / 6;
    const c2y = next.y - (after.y - current.y) / 6;
    d += ` C ${round2(c1x)} ${round2(c1y)} ${round2(c2x)} ${round2(c2y)} ${round2(next.x)} ${round2(next.y)}`;
  }
  return `${d} Z`;
}

/**
 * The whole morph in one call: interpolate, then draw. This is what
 * `useAnimatedProps` invokes on every frame, which is why the chain
 * (`morphPathD` → `lerpOutline` → `outlinePathD`) is worklets end to end.
 */
export function morphPathD(
  from: readonly Point[],
  to: readonly Point[],
  t: number,
): string {
  'worklet';
  return outlinePathD(lerpOutline(from, to, t));
}

export type MorphOutlines = {
  /** LAYOUT-space start shape (you). Empty when unavailable. */
  from: Point[];
  /** LAYOUT-space end shape (the species). Empty when unavailable. */
  to: Point[];
  /** True only when both shapes exist and a real deformation can be drawn. */
  canMorph: boolean;
};

const EMPTY_MORPH: MorphOutlines = { from: [], to: [], canMorph: false };

/**
 * Prepare both sides of the morph for a measured layout.
 *
 * Cheap to call from a `useMemo` keyed on the container size; everything after
 * this point is per-frame arithmetic on two fixed-length arrays.
 *
 * Degrades in exactly one direction: if either outline is missing or unusable
 * the result is empty and `canMorph` is false, and the caller falls back to the
 * silhouette-rise beat. It never invents a shape.
 */
export function buildMorphOutlines(options: {
  personOutline: readonly Point[] | null | undefined;
  speciesOutline: readonly Point[] | null | undefined;
  /** Where the species artwork is drawn — both shapes land in this box. */
  artworkRect: Rect;
  /** Selfies are flipped for display, so your outline is mirrored by default. */
  mirrorPerson?: boolean;
  count?: number;
}): MorphOutlines {
  const {
    personOutline,
    speciesOutline,
    artworkRect,
    // Matches `SelfieImage`, which no longer flips the photo either. These two
    // must agree or the traced outline lands on the mirror image of the body it
    // came from — reported as "the outline of me does not match my silhouette".
    mirrorPerson = false,
    count = MORPH_POINT_COUNT,
  } = options;

  if (!(artworkRect.width > 0) || !(artworkRect.height > 0)) {
    return EMPTY_MORPH;
  }

  const to = resampleOutlineByAngle(projectOutlineOntoRect(speciesOutline, artworkRect), count);
  if (to.length === 0) {
    return EMPTY_MORPH;
  }
  const from = resampleOutlineByAngle(
    fitOutlineIntoRect(personOutline, artworkRect, { mirrorX: mirrorPerson }),
    count,
  );
  if (from.length === 0) {
    return EMPTY_MORPH;
  }
  return { from, to, canMorph: true };
}
