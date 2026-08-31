import {
  binderPageRows,
  binderPocketRowId,
  insertBinderPocketRows,
} from '@/features/scanner/screens/scanner-screen-helpers';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';

function placeholder(id: string): RecentCapture {
  return {
    activeCandidateIndex: 0,
    candidates: [],
    totalCandidateCount: 0,
    isLoadingMoreCandidates: false,
    hasTrackedSelectionEvent: false,
    id,
    isAddingToInventory: false,
    isLoadingCandidates: true,
    matchReviewDisposition: null,
    matchReviewReason: null,
    mode: 'raw',
    normalizedImageDimensions: null,
    normalizedImageUri: null,
    recentlyAdded: false,
    scanID: null,
    slabContext: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
    uri: '',
  };
}

describe('insertBinderPocketRows', () => {
  it('puts pocket 0 first and the rest beneath it in reading order, above older scans', () => {
    const older = placeholder('older');
    const rows = insertBinderPocketRows([placeholder('page'), older], 'page', 9);

    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.binderPage?.pocketIndex ?? null)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, null,
    ]);
    expect(rows[0].id).toBe('page');
    expect(rows[8].id).toBe(binderPocketRowId('page', 8));
    expect(rows[9]).toBe(older);
    rows.slice(0, 9).forEach((row) => expect(row.binderPage?.pageId).toBe('page'));
  });

  it('leaves the tray alone when the placeholder is gone (e.g. swiped away mid-normalize)', () => {
    const current = [placeholder('other')];
    expect(insertBinderPocketRows(current, 'page', 9)).toBe(current);
  });
});

describe('binderPageRows', () => {
  it('returns only that page, sorted by pocket even when the tray order drifted', () => {
    const rows = insertBinderPocketRows([placeholder('page'), placeholder('x')], 'page', 3).reverse();
    expect(binderPageRows(rows, 'page').map((row) => row.binderPage?.pocketIndex)).toEqual([0, 1, 2]);
  });
});
