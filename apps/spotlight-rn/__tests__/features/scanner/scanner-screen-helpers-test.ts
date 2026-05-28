import { buildUnifiedMismatchWarning } from '@/features/scanner/screens/scanner-screen-helpers';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';
import type {
  ScannerCardType,
  ScannerCondition,
} from '@/features/scanner/use-scanner-target-config';

function makeCapture(overrides: Partial<RecentCapture> = {}): RecentCapture {
  return {
    activeCandidateIndex: 0,
    candidates: [],
    conditionMismatchSuggestion: null,
    hasTrackedSelectionEvent: false,
    id: 'cap-1',
    isAddingToInventory: false,
    isLoadingCandidates: false,
    languageMismatchSuggestion: null,
    matchReviewDisposition: null,
    matchReviewReason: null,
    mode: 'raw',
    normalizedImageDimensions: null,
    normalizedImageUri: null,
    recentlyAdded: false,
    scanID: 'scan-1',
    slabContext: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
    uri: 'file:///cap-1.jpg',
    ...overrides,
  } as RecentCapture;
}

describe('buildUnifiedMismatchWarning', () => {
  it('returns null when no suggestions are set', () => {
    expect(buildUnifiedMismatchWarning(makeCapture())).toBeNull();
  });

  it('returns kind="language" with the JP copy when only a JP language switch is suggested', () => {
    const cardType: ScannerCardType = 'pokemon_jp';
    const warning = buildUnifiedMismatchWarning(
      makeCapture({ languageMismatchSuggestion: cardType }),
    );

    expect(warning).toEqual({
      kind: 'language',
      targetCardType: 'pokemon_jp',
      targetCondition: null,
      message: 'Looks like a Japanese card.',
      primaryActionLabel: 'Switch to JP & rescan',
    });
  });

  it('returns kind="language" with the EN copy when only an EN language switch is suggested', () => {
    const cardType: ScannerCardType = 'pokemon_en';
    const warning = buildUnifiedMismatchWarning(
      makeCapture({ languageMismatchSuggestion: cardType }),
    );

    expect(warning).toEqual({
      kind: 'language',
      targetCardType: 'pokemon_en',
      targetCondition: null,
      message: 'Looks like an English card.',
      primaryActionLabel: 'Switch to EN & rescan',
    });
  });

  it('returns kind="condition" with graded copy when only a graded switch is suggested', () => {
    const condition: ScannerCondition = 'graded';
    const warning = buildUnifiedMismatchWarning(
      makeCapture({ conditionMismatchSuggestion: condition }),
    );

    expect(warning).toEqual({
      kind: 'condition',
      targetCardType: null,
      targetCondition: 'graded',
      message: 'Looks like a graded slab.',
      primaryActionLabel: 'Switch to Graded & rescan',
    });
  });

  it('returns kind="condition" with ungraded copy when only an ungraded switch is suggested', () => {
    const condition: ScannerCondition = 'ungraded';
    const warning = buildUnifiedMismatchWarning(
      makeCapture({ conditionMismatchSuggestion: condition }),
    );

    expect(warning).toEqual({
      kind: 'condition',
      targetCardType: null,
      targetCondition: 'ungraded',
      message: 'Looks like a raw card.',
      primaryActionLabel: 'Switch to Ungraded & rescan',
    });
  });

  it('returns kind="both" with JP + graded copy', () => {
    const warning = buildUnifiedMismatchWarning(
      makeCapture({
        languageMismatchSuggestion: 'pokemon_jp',
        conditionMismatchSuggestion: 'graded',
      }),
    );

    expect(warning).toEqual({
      kind: 'both',
      targetCardType: 'pokemon_jp',
      targetCondition: 'graded',
      message: 'Looks like a Japanese graded slab.',
      primaryActionLabel: 'Switch to JP + Graded & rescan',
    });
  });

  it('returns kind="both" with JP + ungraded copy', () => {
    const warning = buildUnifiedMismatchWarning(
      makeCapture({
        languageMismatchSuggestion: 'pokemon_jp',
        conditionMismatchSuggestion: 'ungraded',
      }),
    );

    expect(warning).toEqual({
      kind: 'both',
      targetCardType: 'pokemon_jp',
      targetCondition: 'ungraded',
      message: 'Looks like a Japanese raw card.',
      primaryActionLabel: 'Switch to JP + Ungraded & rescan',
    });
  });

  it('returns kind="both" with EN + graded copy', () => {
    const warning = buildUnifiedMismatchWarning(
      makeCapture({
        languageMismatchSuggestion: 'pokemon_en',
        conditionMismatchSuggestion: 'graded',
      }),
    );

    expect(warning).toEqual({
      kind: 'both',
      targetCardType: 'pokemon_en',
      targetCondition: 'graded',
      message: 'Looks like an English graded slab.',
      primaryActionLabel: 'Switch to EN + Graded & rescan',
    });
  });

  it('returns kind="both" with EN + ungraded copy', () => {
    const warning = buildUnifiedMismatchWarning(
      makeCapture({
        languageMismatchSuggestion: 'pokemon_en',
        conditionMismatchSuggestion: 'ungraded',
      }),
    );

    expect(warning).toEqual({
      kind: 'both',
      targetCardType: 'pokemon_en',
      targetCondition: 'ungraded',
      message: 'Looks like an English raw card.',
      primaryActionLabel: 'Switch to EN + Ungraded & rescan',
    });
  });
});
