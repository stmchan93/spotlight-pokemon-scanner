/**
 * Tuning + pure math for the bubble "following you" between pages: the leash
 * while the tab strip moves, the hop to a new spot on a route change, and the
 * glance back toward the page it came from. All UI-thread safe (worklets).
 */
import { pagerPageForPath } from '@/components/tab-pager/tab-pager-motion';
import { isTabRoute } from '@/features/assistant/page-context/assistant-bubble-zones';

// ── Leash (outer tab swipe) ─────────────────────────────────────────────────
/** Strip speed (pt/s) that pulls the leash all the way; a brisk swipe is ~1–3k. */
export const LEASH_FULL_SPEED = 1400;
/** Max trail behind the motion, pt. */
export const LEASH_OFFSET = 12;
/** Max lean toward the direction of travel, degrees. */
export const LEASH_TILT_DEG = 8;
/** Max stretch along the motion (scaleX +4%, scaleY -2%). */
export const LEASH_STRETCH = 0.04;
/** Velocity smoothing per strip frame: share of the new sample (0–1). */
export const LEASH_SMOOTHING = 0.35;
/** No strip frame for this long = the page has settled; spring back. */
export const LEASH_RELEASE_MS = 70;
/** Low damping: the return overshoots a little and wobbles once. */
export const LEASH_RETURN_SPRING = { damping: 7, mass: 0.6, stiffness: 180 } as const;

// ── Hop (resolved position changes with the route) ───────────────────────────
export const HOP_MS = 380;
/** Arc height at mid-flight, pt (less if the destination band is too short). */
export const HOP_HEIGHT = 20;
/** Landing squash: 5% wider / shorter, then a springy rebound. */
export const HOP_SQUASH = 0.05;
export const HOP_LAND_SPRING = { damping: 8, mass: 0.5, stiffness: 320 } as const;

// ── Look (glance toward the previous page) ───────────────────────────────────
/** Mark shift toward the previous page, pt. */
export const LOOK_SHIFT = 2.5;
/** Mark turn toward the previous page, degrees. */
export const LOOK_TILT_DEG = 7;
/** Wait after a route change with no hop (lets a tap's 280ms strip slide land). */
export const LOOK_DELAY_MS = 220;
export const LOOK_OUT_MS = 130;
export const LOOK_HOLD_MS = 110;
export const LOOK_BACK_MS = 190;

/**
 * Leash pull (-1…1) from the strip velocity in pages/s. Positive = the strip is
 * advancing (content travelling left), so the bubble trails right and leans left.
 */
export function leashAmount(pagesPerSecond: number, pageWidth: number): number {
  'worklet';
  const pull = (pagesPerSecond * pageWidth) / LEASH_FULL_SPEED;
  return Math.min(Math.max(pull, -1), 1);
}

/**
 * Arc height for a hop from `fromY` to `toY`: the peak sits at mid-flight and
 * never rises above the destination band's top (the scanner's frame→tray gap).
 */
export function hopHeight(fromY: number, toY: number, zoneMinY: number): number {
  const peakRoom = (fromY + toY) / 2 - zoneMinY;
  return Math.min(Math.max(peakRoom, 0), HOP_HEIGHT);
}

/**
 * Which way the mark glances after landing on `to`: toward where it came from.
 * -1 = left, 1 = right, 0 = no glance. Tabs use strip order; pushing a stack
 * page puts the previous one on the left, popping back to a tab on the right.
 */
export function lookDirection(from: string, to: string): -1 | 0 | 1 {
  if (from === to) {
    return 0;
  }
  const fromPage = pagerPageForPath(from);
  const toPage = pagerPageForPath(to);
  if (fromPage >= 0 && toPage >= 0) {
    return fromPage < toPage ? -1 : 1;
  }
  if (isTabRoute(to) && !isTabRoute(from)) {
    return 1;
  }
  return -1;
}
