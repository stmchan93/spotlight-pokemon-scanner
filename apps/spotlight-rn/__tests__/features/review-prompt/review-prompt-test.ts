import AsyncStorage from '@react-native-async-storage/async-storage';
import * as StoreReview from 'expo-store-review';

import {
  FIRST_PROMPT_GOOD_SCANS,
  REPEAT_PROMPT_COOLDOWN_MS,
  REPEAT_PROMPT_GOOD_SCANS,
  isReviewPromptEligible,
  maybeRequestReview,
  noteScanTrouble,
  recordGoodScan,
  resetReviewPromptForTests,
} from '@/features/review-prompt/review-prompt';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      clear: () => store.clear(),
    },
  };
});

jest.mock('expo-store-review', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(true)),
  requestReview: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: jest.fn(() => ({})),
}));

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe('isReviewPromptEligible', () => {
  it('waits for the first-prompt scan threshold', () => {
    const state = { goodScans: FIRST_PROMPT_GOOD_SCANS - 1, goodScansAtLastPrompt: 0, promptedAt: [] };
    expect(isReviewPromptEligible(state, NOW, false)).toBe(false);
    expect(isReviewPromptEligible({ ...state, goodScans: FIRST_PROMPT_GOOD_SCANS }, NOW, false)).toBe(true);
  });

  it('never asks in a session with a failed or corrected scan', () => {
    const state = { goodScans: 100, goodScansAtLastPrompt: 0, promptedAt: [] };
    expect(isReviewPromptEligible(state, NOW, true)).toBe(false);
  });

  it('needs both the cooldown and more scans before asking again', () => {
    const lastPromptAt = NOW - REPEAT_PROMPT_COOLDOWN_MS;
    const base = { goodScans: 10 + REPEAT_PROMPT_GOOD_SCANS, goodScansAtLastPrompt: 10, promptedAt: [lastPromptAt] };
    expect(isReviewPromptEligible(base, NOW, false)).toBe(true);
    expect(isReviewPromptEligible({ ...base, goodScans: base.goodScans - 1 }, NOW, false)).toBe(false);
    expect(isReviewPromptEligible({ ...base, promptedAt: [lastPromptAt + DAY] }, NOW, false)).toBe(false);
  });

  it('stops at three prompts a year', () => {
    const state = {
      goodScans: 1000,
      goodScansAtLastPrompt: 0,
      promptedAt: [NOW - 300 * DAY, NOW - 200 * DAY, NOW - 100 * DAY],
    };
    expect(isReviewPromptEligible(state, NOW, false)).toBe(false);
    expect(isReviewPromptEligible({ ...state, promptedAt: state.promptedAt.slice(1) }, NOW, false)).toBe(true);
  });
});

describe('maybeRequestReview', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetReviewPromptForTests();
    (AsyncStorage as unknown as { clear: () => void }).clear();
    jest.mocked(StoreReview.requestReview).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function flush() {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  }

  async function scan(count: number) {
    for (let i = 0; i < count; i += 1) {
      recordGoodScan();
      await flush();
    }
  }

  it('asks after enough good scans, once', async () => {
    await scan(FIRST_PROMPT_GOOD_SCANS);
    maybeRequestReview('scanner_blur');
    await flush();
    jest.advanceTimersByTime(2000);
    await flush();
    expect(StoreReview.requestReview).toHaveBeenCalledTimes(1);

    maybeRequestReview('scanner_blur');
    await flush();
    jest.advanceTimersByTime(2000);
    await flush();
    expect(StoreReview.requestReview).toHaveBeenCalledTimes(1);
  });

  it('holds the prompt after scan trouble this session', async () => {
    await scan(FIRST_PROMPT_GOOD_SCANS);
    noteScanTrouble();
    maybeRequestReview('collection_add');
    await flush();
    jest.advanceTimersByTime(2000);
    await flush();
    expect(StoreReview.requestReview).not.toHaveBeenCalled();
  });
});
