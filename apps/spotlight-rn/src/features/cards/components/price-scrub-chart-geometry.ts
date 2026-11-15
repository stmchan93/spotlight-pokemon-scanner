// Pure geometry for PriceScrubChart. Functions marked 'worklet' also run on
// the UI thread inside the scrub gesture.

export type ChartXY = { x: number; y: number };

export const CHART_PAD_TOP = 30;
export const CHART_PAD_BOTTOM = 14;
export const MORPH_SAMPLES = 120;
// A gap between sales draws dashed past 2 weeks, or a quarter of the window on
// long ranges — a ratio alone dashed ordinary 5-day gaps on 1M.
const SALES_GAP_DASH_MIN_MS = 14 * 24 * 60 * 60 * 1000;
const SALES_GAP_DASH_RATIO = 0.25;

export function salesGapThresholdMs(windowMs: number): number {
  return Math.max(SALES_GAP_DASH_MIN_MS, windowMs * SALES_GAP_DASH_RATIO);
}
// Same guard as the portfolio line: the y-window spans at least 8% of the
// value so a tiny move doesn't fill the whole height.
const MIN_SPAN_RATIO = 0.08;

// 'fit' stretches the line to fill the height for whatever moved in the window
// (the portfolio wants a quiet 7D blown up); the floor only keeps a flat or
// penny-level series from dividing by ~0.
const FIT_MIN_SPAN_RATIO = 0.001;

export type PriceYScale = 'padded' | 'fit';

export function priceYDomain(values: readonly number[], scale: PriceYScale = 'padded') {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { min: 0, max: 1 };
  }
  const dataMin = Math.min(...finite);
  const dataMax = Math.max(...finite);
  const ratio = scale === 'fit' ? FIT_MIN_SPAN_RATIO : MIN_SPAN_RATIO;
  const minSpan = Math.abs(dataMax) * ratio || (scale === 'fit' ? 0.02 : 2);
  const span = Math.max(dataMax - dataMin, minSpan);
  const mid = (dataMax + dataMin) / 2;
  return { min: mid - span / 2, max: mid + span / 2 };
}

export function projectPoints(
  points: readonly { t: number; v: number }[],
  windowStartMs: number,
  windowEndMs: number,
  width: number,
  height: number,
  scale: PriceYScale = 'padded',
): ChartXY[] {
  const domain = priceYDomain(points.map((point) => point.v), scale);
  const ySpan = Math.max(domain.max - domain.min, 1e-6);
  const tSpan = Math.max(windowEndMs - windowStartMs, 1);
  const plotHeight = Math.max(height - CHART_PAD_TOP - CHART_PAD_BOTTOM, 1);
  return points.map((point) => ({
    x: Math.min(Math.max(((point.t - windowStartMs) / tSpan) * width, 0), width),
    y: CHART_PAD_TOP + (1 - (point.v - domain.min) / ySpan) * plotHeight,
  }));
}

/** Nearest index by x; xs must be ascending. Binary search keeps a 365-point scrub O(log n). */
export function nearestIndexByX(xs: readonly number[], x: number): number {
  'worklet';
  const n = xs.length;
  if (n === 0) {
    return -1;
  }
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x)) {
    return lo - 1;
  }
  return lo;
}

const fmt = (value: number) => value.toFixed(1);

/** Splits consecutive segments into solid and dashed path strings. */
export function segmentPaths(
  points: readonly { t: number }[],
  coords: readonly ChartXY[],
  gapThresholdMs: number,
): { solid: string; dashed: string } {
  let solid = '';
  let dashed = '';
  for (let index = 1; index < coords.length; index += 1) {
    const a = coords[index - 1];
    const b = coords[index];
    const segment = `M${fmt(a.x)} ${fmt(a.y)} L${fmt(b.x)} ${fmt(b.y)} `;
    if (points[index].t - points[index - 1].t > gapThresholdMs) {
      dashed += segment;
    } else {
      solid += segment;
    }
  }
  return { solid: solid.trim(), dashed: dashed.trim() };
}

export function polylinePath(coords: readonly ChartXY[]): string {
  return coords.map((c, index) => `${index ? 'L' : 'M'}${fmt(c.x)} ${fmt(c.y)}`).join(' ');
}

/** y at evenly spaced x across [0, width], linearly interpolated; coords x-ascending. */
export function resampleY(
  coords: readonly ChartXY[],
  width: number,
  samples: number = MORPH_SAMPLES,
): number[] {
  const out: number[] = [];
  if (coords.length === 0) {
    return out;
  }
  let j = 1;
  for (let s = 0; s < samples; s += 1) {
    const x = samples > 1 ? (s / (samples - 1)) * width : 0;
    while (j < coords.length - 1 && coords[j].x < x) {
      j += 1;
    }
    const a = coords[Math.min(j - 1, coords.length - 1)];
    const b = coords[j] ?? a;
    const f = b.x === a.x ? 0 : Math.min(Math.max((x - a.x) / (b.x - a.x), 0), 1);
    out.push(a.y + (b.y - a.y) * f);
  }
  return out;
}

/**
 * A series' morph samples: y at evenly spaced x across the series' OWN x
 * extent, not the chart width — history that starts mid-window must not grow a
 * flat lead-in from x=0 while it animates.
 */
export type SeriesSamples = { x0: number; x1: number; ys: number[] };

export function resampleSeries(coords: readonly ChartXY[], samples: number = MORPH_SAMPLES): SeriesSamples | null {
  if (coords.length < 2) {
    return null;
  }
  const x0 = coords[0].x;
  const x1 = coords[coords.length - 1].x;
  const shifted = coords.map((c) => ({ x: c.x - x0, y: c.y }));
  return { x0, x1, ys: resampleY(shifted, x1 - x0, samples) };
}

export function morphPath(from: SeriesSamples, to: SeriesSamples, progress: number): string {
  'worklet';
  const n = Math.min(from.ys.length, to.ys.length);
  const x0 = from.x0 + (to.x0 - from.x0) * progress;
  const x1 = from.x1 + (to.x1 - from.x1) * progress;
  let d = '';
  for (let s = 0; s < n; s += 1) {
    const x = n > 1 ? x0 + (s / (n - 1)) * (x1 - x0) : x0;
    const y = from.ys[s] + (to.ys[s] - from.ys[s]) * progress;
    d += `${s ? ' L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

/**
 * Closes a line path into the area under it: down from the LAST point, back
 * along the bottom, up under the FIRST point. Closing at the chart corners
 * instead drew a diagonal wedge whenever the data didn't span the window.
 */
export function areaFillPath(linePath: string, firstX: number, lastX: number, bottom: number): string {
  'worklet';
  if (!linePath) {
    return '';
  }
  return `${linePath} L${lastX.toFixed(1)} ${bottom} L${firstX.toFixed(1)} ${bottom} Z`;
}

export function morphFillPath(from: SeriesSamples, to: SeriesSamples, progress: number, bottom: number): string {
  'worklet';
  const firstX = from.x0 + (to.x0 - from.x0) * progress;
  const lastX = from.x1 + (to.x1 - from.x1) * progress;
  return areaFillPath(morphPath(from, to, progress), firstX, lastX, bottom);
}

/** -1 / 0 / 1 side of the baseline, for the crossing haptic. */
export function baselineSide(value: number, baseline: number): number {
  if (value > baseline) {
    return 1;
  }
  if (value < baseline) {
    return -1;
  }
  return 0;
}

/** Content equality, so a parent re-deriving the same series doesn't re-trigger the morph. */
export function samePoints(
  a: readonly { t: number; v: number }[],
  b: readonly { t: number; v: number }[],
): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].t !== b[index].t || a[index].v !== b[index].v) {
      return false;
    }
  }
  return true;
}
