import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// One shared reduce-motion subscription for every tray row: per-row listeners
// meant 150 native queries + subscriptions when a full tray rehydrated.
let reduceMotionEnabled = false;
let reduceMotionSubscription: { remove: () => void } | null = null;
const reduceMotionListeners = new Set<() => void>();

function setReduceMotionEnabled(enabled: boolean) {
  if (enabled === reduceMotionEnabled) {
    return;
  }
  reduceMotionEnabled = enabled;
  reduceMotionListeners.forEach((listener) => listener());
}

function subscribeReduceMotion(listener: () => void) {
  reduceMotionListeners.add(listener);
  if (!reduceMotionSubscription) {
    reduceMotionSubscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotionEnabled,
    );
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotionEnabled)
      .catch(() => {
        /* default to motion-on if the query fails */
      });
  }
  return () => {
    reduceMotionListeners.delete(listener);
    if (reduceMotionListeners.size === 0) {
      reduceMotionSubscription?.remove();
      reduceMotionSubscription = null;
    }
  };
}

function getReduceMotionEnabled() {
  return reduceMotionEnabled;
}

export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, getReduceMotionEnabled);
}
