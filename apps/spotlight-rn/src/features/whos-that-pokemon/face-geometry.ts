/**
 * Geometry for the "Who's That Pokémon?" lock-on beat.
 *
 * THREE coordinate spaces meet in this file and mixing them up is the single
 * easiest way to make the animation look broken (points landing off the face or
 * off the creature), so every function names the space it takes and returns:
 *
 *  1. SELFIE space   — `headBox` / `personBounds` are normalized 0..1 against
 *                      the ORIGINAL selfie pixels the backend analyzed.
 *  2. ARTWORK space  — `speciesOutline` points are normalized 0..1 against the
 *                      official artwork PNG (square, transparent background).
 *  3. LAYOUT space   — pixels inside the reveal container, which is what we
 *                      actually draw in.
 *
 * The selfie is rendered `contentFit="cover"` and NOT mirrored (see
 * `components/selfie-image.tsx`), so selfie→layout is a crop, not a
 * crop-and-flip as this said while the display flip existed. The artwork is
 * rendered `contentFit="contain"` inside a fixed percentage box, so
 * artwork→layout is a letterbox fit.
 */

export type NormalizedBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Where the reveal draws the species artwork, as a fraction of the container.
 * `reveal-morph.tsx` styles the artwork with the PCT constants below — the two
 * must stay in lockstep or the silhouette will jump on handoff.
 */
export const REVEAL_ARTWORK_BOX = { widthRatio: 0.8, heightRatio: 0.58 } as const;
export const REVEAL_ARTWORK_WIDTH_PCT = '80%';
export const REVEAL_ARTWORK_HEIGHT_PCT = '58%';

/**
 * Head box used when the backend gave us nothing (segmentation failed, or the
 * field simply is not deployed yet). Expressed directly in LAYOUT-normalized
 * units — a centred head at plausible portrait proportions, sitting in the
 * upper third. It is an honest guess, which is why the lock-on labels itself
 * "estimated" in that case and skips the precise-looking caliper readouts.
 */
export const FALLBACK_HEAD_BOX: NormalizedBox = {
  x: 0.335,
  y: 0.155,
  width: 0.33,
  height: 0.27,
};

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** True when a box is usable: finite, non-degenerate, and roughly inside 0..1. */
export function isUsableNormalizedBox(box: NormalizedBox | null | undefined): box is NormalizedBox {
  if (!box) {
    return false;
  }
  const { x, y, width, height } = box;
  if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return false;
  }
  if (width <= 0.01 || height <= 0.01) {
    return false;
  }
  // Allow a little slop for boxes clipped at the frame edge.
  return x >= -0.2 && y >= -0.2 && x + width <= 1.2 && y + height <= 1.2;
}

export type HeadRectResolution = {
  /** LAYOUT-space pixels. */
  rect: Rect;
  /** False when we fell back to the proportional guess. */
  isMeasured: boolean;
};

/**
 * SELFIE space → LAYOUT space for the head box, accounting for the `cover`
 * crop and the display mirror. Falls back to `FALLBACK_HEAD_BOX` whenever the
 * backend box or the source dimensions are missing/unusable.
 */
export function resolveHeadRect(options: {
  headBox: NormalizedBox | null | undefined;
  sourceWidth: number;
  sourceHeight: number;
  containerWidth: number;
  containerHeight: number;
  /**
   * Whether the displayed photo is a mirror image of the one the backend
   * measured `headBox` against.
   *
   * DEFAULTS TO FALSE, and used to default to true. That default was written
   * when `SelfieImage` flipped the photo for display; it stopped, and this was
   * left behind — so the reticle was landing on the reflection of the face
   * rather than the face. `mirrorPerson` in `outline-morph` is the same switch
   * for the traced outline and carries the same default for the same reason:
   * all three describe ONE image and have to agree.
   *
   * The capture is un-mirrored at the source now (`bakeCaptureOrientation`), so
   * the photo on screen and the pixels the backend measured are the same pixels.
   */
  mirrored?: boolean;
}): HeadRectResolution {
  const { headBox, sourceWidth, sourceHeight, containerWidth, containerHeight, mirrored = false } =
    options;

  if (!isFinitePositive(containerWidth) || !isFinitePositive(containerHeight)) {
    return { rect: { x: 0, y: 0, width: 0, height: 0 }, isMeasured: false };
  }

  const fallback = (): HeadRectResolution => ({
    rect: {
      x: FALLBACK_HEAD_BOX.x * containerWidth,
      y: FALLBACK_HEAD_BOX.y * containerHeight,
      width: FALLBACK_HEAD_BOX.width * containerWidth,
      height: FALLBACK_HEAD_BOX.height * containerHeight,
    },
    isMeasured: false,
  });

  if (
    !isUsableNormalizedBox(headBox) ||
    !isFinitePositive(sourceWidth) ||
    !isFinitePositive(sourceHeight)
  ) {
    return fallback();
  }

  // `cover`: scale so the shorter axis fills, then centre-crop the overflow.
  const scale = Math.max(containerWidth / sourceWidth, containerHeight / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  const offsetX = (containerWidth - drawnWidth) / 2;
  const offsetY = (containerHeight - drawnHeight) / 2;

  // Mirror in SELFIE space before projecting, so the box lands on the face the
  // user actually sees rather than its reflection.
  const boxX = mirrored ? 1 - (headBox.x + headBox.width) : headBox.x;

  return {
    rect: {
      x: offsetX + boxX * drawnWidth,
      y: offsetY + headBox.y * drawnHeight,
      width: headBox.width * drawnWidth,
      height: headBox.height * drawnHeight,
    },
    isMeasured: true,
  };
}

/**
 * ARTWORK space → LAYOUT space. The artwork is drawn `contain` inside
 * `REVEAL_ARTWORK_BOX`; official artwork PNGs are square, so the default
 * aspect is 1.
 *
 * `box` exists because the result panel's morph loop draws the same artwork in
 * a different percentage box (`morph-loop.tsx`'s subject box). Both surfaces
 * need the exact rect the PNG lands in so an outline path can be laid over it
 * without drifting, and there should only ever be one letterbox-fit routine.
 */
export function resolveArtworkRect(
  containerWidth: number,
  containerHeight: number,
  aspect = 1,
  box: { widthRatio: number; heightRatio: number } = REVEAL_ARTWORK_BOX,
): Rect {
  if (!isFinitePositive(containerWidth) || !isFinitePositive(containerHeight)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const boxWidth = containerWidth * box.widthRatio;
  const boxHeight = containerHeight * box.heightRatio;
  const fitted = Math.min(boxWidth, boxHeight * aspect);
  const width = fitted;
  const height = fitted / aspect;
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Landmark template, in HEAD-BOX-local units (0..1 across the head box).
 *
 * These are a plausible face layout, NOT detected landmarks — the backend gives
 * us a head box, not a mesh. Everything the UI claims is scoped to that: the
 * readouts describe this template, and the copy says "estimated" when even the
 * box was a guess.
 */
export const FACE_LANDMARKS: readonly Point[] = [
  // 0-11: jaw, left temple around the chin to right temple
  { x: 0.04, y: 0.34 },
  { x: 0.06, y: 0.48 },
  { x: 0.11, y: 0.62 },
  { x: 0.19, y: 0.75 },
  { x: 0.3, y: 0.86 },
  { x: 0.44, y: 0.94 },
  { x: 0.56, y: 0.94 },
  { x: 0.7, y: 0.86 },
  { x: 0.81, y: 0.75 },
  { x: 0.89, y: 0.62 },
  { x: 0.94, y: 0.48 },
  { x: 0.96, y: 0.34 },
  // 12-16: hairline arc
  { x: 0.12, y: 0.2 },
  { x: 0.3, y: 0.09 },
  { x: 0.5, y: 0.05 },
  { x: 0.7, y: 0.09 },
  { x: 0.88, y: 0.2 },
  // 17-20: brows
  { x: 0.22, y: 0.33 },
  { x: 0.34, y: 0.29 },
  { x: 0.66, y: 0.29 },
  { x: 0.78, y: 0.33 },
  // 21-24: eyes
  { x: 0.28, y: 0.42 },
  { x: 0.38, y: 0.41 },
  { x: 0.62, y: 0.41 },
  { x: 0.72, y: 0.42 },
  // 25-28: nose
  { x: 0.5, y: 0.45 },
  { x: 0.5, y: 0.62 },
  { x: 0.42, y: 0.65 },
  { x: 0.58, y: 0.65 },
  // 29-32: mouth
  { x: 0.38, y: 0.75 },
  { x: 0.5, y: 0.72 },
  { x: 0.62, y: 0.75 },
  { x: 0.5, y: 0.79 },
  // 33-34: cheekbones
  { x: 0.22, y: 0.58 },
  { x: 0.78, y: 0.58 },
];

/** HEAD-BOX-local template → LAYOUT-space pixels. */
export function projectLandmarks(rect: Rect, landmarks: readonly Point[] = FACE_LANDMARKS): Point[] {
  return landmarks.map((point) => ({
    x: rect.x + point.x * rect.width,
    y: rect.y + point.y * rect.height,
  }));
}

export type FaceMeasurement = {
  /** Short caps label, e.g. "EYE SPAN". */
  label: string;
  /** Formatted value, e.g. "0.44w". */
  value: string;
  /** LAYOUT-space anchor the readout is pinned near. */
  anchor: Point;
};

/**
 * Two readouts derived from the landmarks we actually drew, so the numbers
 * describe something on screen rather than being invented per frame.
 */
export function describeFaceMeasurements(points: readonly Point[]): FaceMeasurement[] {
  const leftEye = points[21];
  const rightEye = points[24];
  const jawLeft = points[4];
  const chin = points[5];
  const jawRight = points[7];
  if (!leftEye || !rightEye || !jawLeft || !chin || !jawRight) {
    return [];
  }

  const faceWidth = Math.abs((points[11]?.x ?? rightEye.x) - (points[0]?.x ?? leftEye.x)) || 1;
  const eyeSpan = Math.abs(rightEye.x - leftEye.x) / faceWidth;

  const a = Math.atan2(jawLeft.y - chin.y, jawLeft.x - chin.x);
  const b = Math.atan2(jawRight.y - chin.y, jawRight.x - chin.x);
  let jawAngle = Math.abs((a - b) * (180 / Math.PI));
  if (jawAngle > 180) {
    jawAngle = 360 - jawAngle;
  }

  return [
    {
      label: 'EYE SPAN',
      value: `${eyeSpan.toFixed(2)}w`,
      anchor: { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 },
    },
    {
      label: 'JAW',
      value: `${Math.round(jawAngle)}°`,
      anchor: { x: chin.x, y: chin.y },
    },
  ];
}

function centroidOf(points: readonly Point[]): Point {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  return { x: sumX / points.length, y: sumY / points.length };
}

/** Shoelace signed area — sign tells us which way the outline winds. */
function signedArea(points: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

/**
 * ARTWORK space → LAYOUT space for the species outline. Returns the points in
 * a canonical winding direction (positive shoelace area in screen coordinates,
 * i.e. increasing atan2 bearing) so the face→outline assignment below never has
 * to guess which way the backend happened to walk the shape.
 */
export function projectSpeciesOutline(
  outline: readonly Point[] | null | undefined,
  artworkRect: Rect,
): Point[] {
  if (!outline || outline.length < 8) {
    return [];
  }
  const projected: Point[] = [];
  for (const point of outline) {
    if (
      typeof point?.x !== 'number' ||
      typeof point?.y !== 'number' ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    ) {
      continue;
    }
    projected.push({
      x: artworkRect.x + Math.min(1, Math.max(0, point.x)) * artworkRect.width,
      y: artworkRect.y + Math.min(1, Math.max(0, point.y)) * artworkRect.height,
    });
  }
  if (projected.length < 8) {
    return [];
  }
  return signedArea(projected) < 0 ? projected.reverse() : projected;
}

/**
 * Assign every face point a landing spot on the species outline.
 *
 * Both sets are ordered by angle about their own centre and the outline is
 * rotated so the two orderings start at the same bearing. That keeps the
 * assignment monotonic — no two flight paths cross — and spreads the face
 * points evenly around the creature, which is what makes the move read as one
 * shape rearranging rather than a swarm.
 */
export function assignOutlineTargets(
  facePoints: readonly Point[],
  faceCenter: Point,
  outlinePoints: readonly Point[],
): Point[] {
  const faceCount = facePoints.length;
  const outlineCount = outlinePoints.length;
  if (faceCount === 0 || outlineCount === 0) {
    return [];
  }

  const outlineCenter = centroidOf(outlinePoints);
  const angleOf = (point: Point, center: Point) => {
    const angle = Math.atan2(point.y - center.y, point.x - center.x);
    return angle < 0 ? angle + Math.PI * 2 : angle;
  };

  const order = facePoints
    .map((point, index) => ({ index, angle: angleOf(point, faceCenter) }))
    .sort((left, right) => left.angle - right.angle);

  // Rotate the outline so its first target sits at the same bearing as the
  // first (lowest-angle) face point.
  const startAngle = order[0].angle;
  let rotation = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let index = 0; index < outlineCount; index += 1) {
    const delta = Math.abs(angleOf(outlinePoints[index], outlineCenter) - startAngle);
    const wrapped = Math.min(delta, Math.PI * 2 - delta);
    if (wrapped < bestDelta) {
      bestDelta = wrapped;
      rotation = index;
    }
  }

  const targets: Point[] = new Array(faceCount);
  order.forEach((entry, position) => {
    const step = Math.round((position * outlineCount) / faceCount);
    targets[entry.index] = outlinePoints[(rotation + step) % outlineCount];
  });
  return targets;
}

/**
 * Fallback exit when the backend gave us no outline: push each point straight
 * out from the head centre so the point cloud bursts apart while the silhouette
 * rises. Deterministic per index — no per-frame randomness.
 */
export function scatterTargets(
  facePoints: readonly Point[],
  faceCenter: Point,
  spread = 2.1,
): Point[] {
  return facePoints.map((point, index) => {
    const dx = point.x - faceCenter.x;
    const dy = point.y - faceCenter.y;
    // A little per-point variation so the burst is not a uniform zoom.
    const jitter = 0.82 + ((index * 37) % 11) / 24;
    return {
      x: faceCenter.x + dx * spread * jitter,
      y: faceCenter.y + dy * spread * jitter,
    };
  });
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
