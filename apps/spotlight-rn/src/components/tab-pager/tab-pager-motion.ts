import { useSyncExternalStore } from 'react';
import type { SharedValue } from 'react-native-reanimated';

/**
 * The tab pager's strip position (in pages, 0 = Home) for UI outside the pager
 * — the floating assistant bubble trails the outer swipe off it on the UI
 * thread. The navigator publishes its shared value on mount; readers get null
 * while no pager is mounted.
 */
let pagerPosition: SharedValue<number> | null = null;
const listeners = new Set<() => void>();

export function publishTabPagerPosition(position: SharedValue<number> | null): void {
  if (position === pagerPosition) {
    return;
  }
  pagerPosition = position;
  listeners.forEach((listener) => listener());
}

/** Clears only if `position` is still the published one (a remount may have replaced it). */
export function unpublishTabPagerPosition(position: SharedValue<number>): void {
  if (pagerPosition === position) {
    publishTabPagerPosition(null);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SharedValue<number> | null {
  return pagerPosition;
}

export function useTabPagerPosition(): SharedValue<number> | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The pager page a tab pathname shows (`/` = 0 … `/social` = 3); -1 off the strip. */
export function pagerPageForPath(pathname: string): number {
  return ['/', '/scan', '/search', '/social'].indexOf(pathname);
}
