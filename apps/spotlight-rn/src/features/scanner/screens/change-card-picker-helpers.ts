import { matchConfidence, type MatchConfidenceLevel } from '@spotlight/design-system';

// Pure helpers for the Change Card picker's per-candidate "% Match" line.
// Kept dependency-light so they can be unit-tested without rendering the sheet.

/**
 * Converts a normalized match score in [0, 1] to an integer percentage (0–100),
 * or null when the score is missing/invalid (e.g. manual catalog-search picks).
 */
export function matchPercentFromScore(score: number | null | undefined): number | null {
  if (score == null || !Number.isFinite(score)) {
    return null;
  }
  return Math.round(score * 100);
}

/**
 * Buckets a match confidence percentage into a palette level:
 * <34% red, 34–66% yellow, ≥67% green. Single source of truth for the
 * thresholds shared by the hero caption color and the row chip.
 */
export function matchConfidenceLevel(pct: number): MatchConfidenceLevel {
  if (pct < 34) {
    return 'red';
  }
  if (pct < 67) {
    return 'yellow';
  }
  return 'green';
}

/**
 * Muted text color for the hero "% Match" caption (Figma green/yellow/red/300).
 */
export function matchConfidenceColor(pct: number): string {
  return matchConfidence[matchConfidenceLevel(pct)].text;
}

/**
 * Pastel chip colors for the per-candidate row "% Match" badge: a soft fill
 * (`backgroundColor`) with a dark, legible label (`color`).
 */
export function matchPillColors(pct: number): { backgroundColor: string; color: string } {
  const palette = matchConfidence[matchConfidenceLevel(pct)];
  return { backgroundColor: palette.chipBg, color: palette.chipText };
}
