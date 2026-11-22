import { useEffect, useState } from 'react';

import { colors } from '@spotlight/design-system';

// react-native-image-colors is a NATIVE module that may be missing from older
// shipped binaries, and OTA'd JS must not crash on them: lazy-require, and any
// failure keeps the neutral wash (same pattern as whos-that-pokemon/palette.ts).
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

/**
 * The wash with no set colour: while the logo is read, with no logo, or when
 * extraction fails. Neutral on purpose: a brand accent here made every set
 * look like the one whose colour it happened to be.
 */
export const SET_PAGE_FALLBACK_ACCENT = colors.gray200;

// What the native side fills in when it can't read the image. Pure black, so
// the near-black check drops it like any other unusable colour.
const EXTRACTION_FALLBACK = '#000000';

// Most representative first, per platform.
// iOS (UIImageColors): `background` is the most frequent OPAQUE colour (it
// skips transparent pixels and prefers a colour over a black/white majority),
// i.e. the logo's own colour, not the canvas. primary/secondary/detail are
// colours picked to CONTRAST with it, the fallbacks when it is an outline black.
// Android (Palette): `dominant` is the most populous swatch, `vibrant` the
// brand-y one. `average` is skipped: it averages transparent pixels in.
const IOS_KEYS = ['background', 'primary', 'secondary', 'detail'] as const;
const ANDROID_KEYS = ['dominant', 'vibrant', 'lightVibrant', 'darkVibrant', 'muted', 'lightMuted'] as const;

const HEX6 = /^#[0-9a-fA-F]{6}$/;
// The wash runs from the accent to white behind a dark back button and dark
// text: grays carry no colour, near-white vanishes, near-black swallows it.
const MIN_SATURATION = 0.25;
const MIN_LIGHTNESS = 0.25;
const MAX_LIGHTNESS = 0.9;

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

function candidateKeys(platform: unknown): readonly string[] {
  if (platform === 'ios') {
    return IOS_KEYS;
  }
  if (platform === 'android') {
    return ANDROID_KEYS;
  }
  return [...ANDROID_KEYS.slice(0, 1), ...IOS_KEYS, ...ANDROID_KEYS.slice(1)];
}

/**
 * The set's own colour: the logo's most representative colour that can carry
 * the header wash, or null when none can (the caller keeps the neutral wash).
 */
export function pickSetPageAccent(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) {
    return null;
  }
  for (const key of candidateKeys(result.platform)) {
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
 * The set page header's accent, read from the set's own logo. Neutral while
 * loading, with no logo, or when extraction is unavailable or fails.
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
    void mod.getColors(logoUrl, { cache: true, fallback: EXTRACTION_FALLBACK, key: logoUrl })
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
