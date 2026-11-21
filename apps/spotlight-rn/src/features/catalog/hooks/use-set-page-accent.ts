import { useEffect, useState } from 'react';

import { colors } from '@spotlight/design-system';

// react-native-image-colors is a NATIVE module that may be missing from older
// shipped binaries, and OTA'd JS must not crash on them: lazy-require, and any
// failure keeps the token accent (same pattern as whos-that-pokemon/palette.ts).
type ImageColorsModule = {
  getColors: (
    uri: string,
    options?: { fallback?: string; cache?: boolean; key?: string },
  ) => Promise<Record<string, unknown>>;
};

function loadImageColorsModule(): ImageColorsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module: react-native-image-colors may be missing from the binary
    const mod = require('react-native-image-colors') as ImageColorsModule | { default?: ImageColorsModule };
    if (typeof (mod as ImageColorsModule).getColors === 'function') {
      return mod as ImageColorsModule;
    }
    const fallback = (mod as { default?: ImageColorsModule }).default;
    return fallback && typeof fallback.getColors === 'function' ? fallback : null;
  } catch {
    return null;
  }
}

/** The wash's accent before the logo is read, and whenever it can't be. */
export const SET_PAGE_FALLBACK_ACCENT = colors.eventAccent;

// Most vivid first. iOS returns primary/secondary/detail/background, Android
// vibrant/dominant/&c. `background` is skipped: on a transparent logo it is
// the empty canvas, not the art.
const ACCENT_KEYS = [
  'vibrant',
  'primary',
  'lightVibrant',
  'dominant',
  'secondary',
  'detail',
  'darkVibrant',
  'average',
  'muted',
] as const;

const HEX6 = /^#[0-9a-fA-F]{6}$/;
// The wash runs from the accent to white behind a dark back button and dark
// text: grays carry no colour, near-white vanishes, near-black swallows it.
const MIN_SATURATION = 0.35;
const MIN_LIGHTNESS = 0.3;
const MAX_LIGHTNESS = 0.85;

function hsl(hex: string): { saturation: number; lightness: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { saturation, lightness };
}

/**
 * The first logo colour that can carry the header wash, or null when none can
 * (the caller keeps the token accent).
 */
export function pickSetPageAccent(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) {
    return null;
  }
  for (const key of ACCENT_KEYS) {
    const value = result[key];
    if (typeof value !== 'string' || !HEX6.test(value)) {
      continue;
    }
    const { saturation, lightness } = hsl(value);
    if (saturation >= MIN_SATURATION && lightness >= MIN_LIGHTNESS && lightness <= MAX_LIGHTNESS) {
      return value.toUpperCase();
    }
  }
  return null;
}

/**
 * The set page header's accent, read from the set's own logo. The token accent
 * while loading, with no logo, or when extraction is unavailable or fails.
 */
export function useSetPageAccent(logoUrl: string | null): string {
  const [accent, setAccent] = useState<{ url: string; color: string } | null>(null);

  useEffect(() => {
    if (!logoUrl) {
      return undefined;
    }
    const mod = loadImageColorsModule();
    if (!mod) {
      return undefined;
    }
    let cancelled = false;
    void mod.getColors(logoUrl, { cache: true, fallback: SET_PAGE_FALLBACK_ACCENT, key: logoUrl })
      .then((result) => {
        const color = pickSetPageAccent(result);
        if (!cancelled && color) {
          setAccent({ url: logoUrl, color });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [logoUrl]);

  return accent && accent.url === logoUrl ? accent.color : SET_PAGE_FALLBACK_ACCENT;
}
