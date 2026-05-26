import { colors } from '@spotlight/design-system';

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
 * Color-codes a candidate's match confidence percentage:
 * <34% red, 34–66% yellow, ≥67% green. Uses semantic design-system tokens.
 */
export function matchConfidenceColor(pct: number): string {
  if (pct < 34) {
    return colors.danger;
  }
  if (pct < 67) {
    return colors.warning;
  }
  return colors.success;
}
