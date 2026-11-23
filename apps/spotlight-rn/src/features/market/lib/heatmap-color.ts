/**
 * Diverging heatmap scale: neutral gray near 0, deepening toward green (up) or
 * red (down), saturating at ±HEATMAP_CLAMP_PCT. Pure so it is unit-tested;
 * callers pass the theme's token colors.
 */

export const HEATMAP_CLAMP_PCT = 15;
/** Moves smaller than this read as flat (neutral gray). */
export const HEATMAP_NEUTRAL_PCT = 0.5;
// The faintest tint a real move gets, so +1% is distinguishable from flat.
const MIN_TINT = 0.22;

export type HeatmapPalette = { up: string; down: string; neutral: string };

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.slice(0, 6);
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function mixHex(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const k = Math.min(1, Math.max(0, t));
  return toHex([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
}

/** 0 (flat) … 1 (at or past the clamp). */
export function heatmapIntensity(changePct: number): number {
  if (!Number.isFinite(changePct) || Math.abs(changePct) < HEATMAP_NEUTRAL_PCT) {
    return 0;
  }
  const t = Math.min(Math.abs(changePct), HEATMAP_CLAMP_PCT) / HEATMAP_CLAMP_PCT;
  return MIN_TINT + (1 - MIN_TINT) * t;
}

export function heatmapColor(changePct: number, palette: HeatmapPalette): string {
  const intensity = heatmapIntensity(changePct);
  if (intensity === 0) {
    return palette.neutral.toUpperCase();
  }
  return mixHex(palette.neutral, changePct > 0 ? palette.up : palette.down, intensity);
}

/** Relative luminance (sRGB), 0 black … 1 white. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Biased toward white past the pure-contrast crossover (~0.18): bold white
// labels read better on the saturated scale ends than dark ones do.
const LIGHT_TEXT_MAX_LUMINANCE = 0.3;

/** True when the tile's label should be white rather than gray900. */
export function prefersLightText(fill: string): boolean {
  return luminance(fill) < LIGHT_TEXT_MAX_LUMINANCE;
}
