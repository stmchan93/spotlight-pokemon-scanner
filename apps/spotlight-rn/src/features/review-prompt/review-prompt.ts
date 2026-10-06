import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppState, Linking, Platform } from 'react-native';

import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

// App Store review prompt. Users become eligible after a few good scans and
// are asked at the next pause (leaving the scanner, adding to the collection) —
// never mid-scan and never in a session where a scan failed or needed a
// correction. The OS draws the prompt and may silently skip it; Apple caps it
// at 3 per 365 days, and Guideline 5.6.1 / Play policy forbid asking "enjoying
// it?" first, so there is deliberately no sentiment gate.

const STATE_KEY = '@spotlight/review-prompt/state';

export const FIRST_PROMPT_GOOD_SCANS = 5;
export const REPEAT_PROMPT_GOOD_SCANS = 50;
export const REPEAT_PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_PROMPTS_PER_YEAR = 3;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const PROMPT_DELAY_MS = 2000;

// Reviews always go to the public listing, whichever build is installed.
const IOS_APP_STORE_ID = '6778252784';
const ANDROID_PACKAGE = 'com.ekalight.app';

export type ReviewPromptState = {
  goodScans: number;
  goodScansAtLastPrompt: number;
  promptedAt: number[];
};

export type ReviewPromptTrigger = 'scanner_blur' | 'collection_add' | 'collection_add_all';

const EMPTY_STATE: ReviewPromptState = { goodScans: 0, goodScansAtLastPrompt: 0, promptedAt: [] };

export function isReviewPromptEligible(
  state: ReviewPromptState,
  now: number,
  sessionHadTrouble: boolean,
): boolean {
  if (sessionHadTrouble) {
    return false;
  }
  const recentPrompts = state.promptedAt.filter((at) => now - at < YEAR_MS);
  if (recentPrompts.length >= MAX_PROMPTS_PER_YEAR) {
    return false;
  }
  const lastPromptAt = state.promptedAt.length > 0 ? Math.max(...state.promptedAt) : null;
  if (lastPromptAt === null) {
    return state.goodScans >= FIRST_PROMPT_GOOD_SCANS;
  }
  return now - lastPromptAt >= REPEAT_PROMPT_COOLDOWN_MS
    && state.goodScans - state.goodScansAtLastPrompt >= REPEAT_PROMPT_GOOD_SCANS;
}

type StoreReviewModule = Pick<typeof import('expo-store-review'), 'isAvailableAsync' | 'requestReview'>;

// `undefined` = not tried yet, `null` = unavailable. expo-store-review calls
// requireNativeModule at top level, so a static import throws on a binary
// built before it was added (JS-only OTA onto an old build). Probe, then
// require lazily — same pattern as tray-sqlite-module.ts.
let cachedStoreReview: StoreReviewModule | null | undefined;

function loadStoreReview(): StoreReviewModule | null {
  if (cachedStoreReview === undefined) {
    if (requireOptionalNativeModule('ExpoStoreReview') == null) {
      cachedStoreReview = null;
      return cachedStoreReview;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cachedStoreReview = require('expo-store-review') as StoreReviewModule;
    } catch {
      cachedStoreReview = null;
    }
  }
  return cachedStoreReview;
}

let cachedState: ReviewPromptState | null = null;
let sessionHadTrouble = false;
let promptPending = false;
let appStateSubscribed = false;

function subscribeToForeground() {
  if (appStateSubscribed) {
    return;
  }
  appStateSubscribed = true;
  let previous = AppState.currentState;
  AppState.addEventListener('change', (next) => {
    // A return from the background is a new session: earlier trouble no longer blocks.
    if (previous === 'background' && next === 'active') {
      sessionHadTrouble = false;
    }
    previous = next;
  });
}

async function loadState(): Promise<ReviewPromptState> {
  if (cachedState) {
    return cachedState;
  }
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ReviewPromptState>) : {};
    cachedState = {
      goodScans: typeof parsed.goodScans === 'number' ? parsed.goodScans : 0,
      goodScansAtLastPrompt: typeof parsed.goodScansAtLastPrompt === 'number' ? parsed.goodScansAtLastPrompt : 0,
      promptedAt: Array.isArray(parsed.promptedAt) ? parsed.promptedAt.filter((at) => typeof at === 'number') : [],
    };
  } catch {
    cachedState = { ...EMPTY_STATE, promptedAt: [] };
  }
  return cachedState;
}

async function saveState(state: ReviewPromptState) {
  cachedState = state;
  try {
    await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Non-fatal — worst case a scan isn't counted.
  }
}

/** A scan matched and painted a result. */
export function recordGoodScan() {
  subscribeToForeground();
  void (async () => {
    const state = await loadState();
    await saveState({ ...state, goodScans: state.goodScans + 1 });
  })();
}

/** A scan failed or the user had to pick a different match; hold the prompt this session. */
export function noteScanTrouble() {
  subscribeToForeground();
  sessionHadTrouble = true;
}

/** Call at a natural pause. Asks the OS for the review prompt if the user qualifies. */
export function maybeRequestReview(trigger: ReviewPromptTrigger) {
  if (promptPending) {
    return;
  }
  promptPending = true;
  void (async () => {
    try {
      const state = await loadState();
      if (!isReviewPromptEligible(state, Date.now(), sessionHadTrouble)) {
        return;
      }
      const StoreReview = loadStoreReview();
      // isAvailableAsync is false on TestFlight, where iOS never shows the prompt.
      if (!StoreReview || !(await StoreReview.isAvailableAsync())) {
        return;
      }
      capturePostHogEvent(AnalyticsEvent.reviewPromptEligible, { trigger, good_scans: state.goodScans });
      await new Promise((resolve) => setTimeout(resolve, PROMPT_DELAY_MS));
      // The user may have hit trouble during the delay.
      if (sessionHadTrouble) {
        return;
      }
      await StoreReview.requestReview();
      const now = Date.now();
      // Re-read: scans may have been counted during the delay.
      const latest = await loadState();
      await saveState({
        ...latest,
        goodScansAtLastPrompt: latest.goodScans,
        promptedAt: [...latest.promptedAt.filter((at) => now - at < YEAR_MS), now],
      });
      // "Requested", not "shown": the OS doesn't say whether it drew the prompt.
      capturePostHogEvent(AnalyticsEvent.reviewPromptRequested, {
        trigger,
        good_scans: latest.goodScans,
        prompt_number: latest.promptedAt.length + 1,
      });
    } catch {
      // Non-fatal — the prompt is best-effort.
    } finally {
      promptPending = false;
    }
  })();
}

/** Opens the store's write-a-review page. For an explicit "Rate" row, not the automatic prompt. */
export async function openStoreReviewPage() {
  capturePostHogEvent(AnalyticsEvent.reviewStorePageOpened, {});
  const url = Platform.OS === 'ios'
    ? `itms-apps://apps.apple.com/app/id${IOS_APP_STORE_ID}?action=write-review`
    : `market://details?id=${ANDROID_PACKAGE}`;
  const webUrl = Platform.OS === 'ios'
    ? `https://apps.apple.com/app/id${IOS_APP_STORE_ID}?action=write-review`
    : `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
  try {
    await Linking.openURL(url);
  } catch {
    await Linking.openURL(webUrl).catch(() => undefined);
  }
}

export function resetReviewPromptForTests() {
  cachedState = null;
  cachedStoreReview = undefined;
  sessionHadTrouble = false;
  promptPending = false;
}
