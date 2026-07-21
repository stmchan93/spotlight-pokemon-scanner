import { colors } from '@spotlight/design-system';

// react-native-image-colors is a NATIVE module that may be missing from older
// shipped binaries, and OTA'd JS must not crash on them — lazy-require and fall
// back (same pattern as expo-sharing in portfolio/export-collection.ts).
type ImageColorsResult = Record<string, unknown> & { platform?: string };
type ImageColorsModule = {
  getColors: (
    uri: string,
    options?: { fallback?: string; cache?: boolean; key?: string },
  ) => Promise<ImageColorsResult>;
};

function loadImageColorsModule(): ImageColorsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-image-colors') as
      | ImageColorsModule
      | { default?: ImageColorsModule };
    if (typeof (mod as ImageColorsModule).getColors === 'function') {
      return mod as ImageColorsModule;
    }
    const fallback = (mod as { default?: ImageColorsModule }).default;
    return fallback && typeof fallback.getColors === 'function' ? fallback : null;
  } catch {
    return null;
  }
}

/**
 * Neutral brand-ish palette used when color extraction is unavailable (missing
 * native module on an older binary) or fails. Purely decorative data — these
 * hexes tint theater swatches / the reveal wash, not UI chrome.
 */
export const fallbackSelfiePalette: string[] = [
  colors.brand,
  colors.purple300,
  colors.yellow400,
  colors.green400,
];

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Ordered so the most representative colors land first on both platforms:
// iOS emits background/primary/secondary/detail, Android emits dominant/
// vibrant/&c. Unknown keys are simply absent and skipped.
const PALETTE_RESULT_KEYS = [
  'primary',
  'vibrant',
  'dominant',
  'secondary',
  'darkVibrant',
  'lightVibrant',
  'background',
  'average',
  'muted',
  'detail',
] as const;

/**
 * Extract 3-5 dominant hex colors from the selfie. Never throws and never
 * returns an empty list — any failure yields `fallbackSelfiePalette` so the
 * scanning theater and reveal wash always have colors to work with.
 */
export async function extractSelfiePalette(uri: string): Promise<string[]> {
  const mod = loadImageColorsModule();
  if (!mod) {
    return fallbackSelfiePalette;
  }

  try {
    const result = await mod.getColors(uri, { fallback: colors.brand, cache: false });
    const seen = new Set<string>();
    const palette: string[] = [];
    for (const key of PALETTE_RESULT_KEYS) {
      const value = result[key];
      if (typeof value !== 'string' || !HEX_COLOR_REGEX.test(value)) {
        continue;
      }
      const normalized = value.toUpperCase();
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      palette.push(normalized);
      if (palette.length >= 5) {
        break;
      }
    }
    return palette.length >= 3 ? palette : fallbackSelfiePalette;
  } catch {
    return fallbackSelfiePalette;
  }
}
