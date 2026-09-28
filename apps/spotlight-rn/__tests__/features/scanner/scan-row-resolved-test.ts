import {
  buildScanRowResolvedProperties,
  scannerCaptureThumbUri,
  type ScanRowOutcome,
} from '@/features/scanner/screens/scanner-screen-helpers';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';

function makeCapture(overrides: Partial<RecentCapture> = {}): RecentCapture {
  return {
    candidates: [
      { cardId: 'a' },
      { cardId: 'b' },
      { cardId: 'c' },
    ] as RecentCapture['candidates'],
    activeCandidateIndex: 0,
    hasTrackedSelectionEvent: false,
    shownAtMs: 1_000,
    id: 'capture-1',
    isAddingToInventory: false,
    isLoadingCandidates: false,
    isLoadingMoreCandidates: false,
    recentlyAdded: false,
    matchReviewDisposition: null,
    matchReviewReason: null,
    mode: 'raw',
    normalizedImageDimensions: null,
    normalizedImageUri: null,
    scanID: 'scan-1',
    slabContext: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
    totalCandidateCount: 3,
    uri: 'file://capture.jpg',
    ...overrides,
  } as RecentCapture;
}

describe('scan_row_resolved properties', () => {
  it('reports rank 1 when the scanner top answer still stood', () => {
    const properties = buildScanRowResolvedProperties(makeCapture(), 'read', 3_500);
    expect(properties.selection_rank).toBe(1);
    expect(properties.outcome).toBe('read');
    expect(properties.candidate_count).toBe(3);
  });

  it('reports the rank the user reached down to', () => {
    const properties = buildScanRowResolvedProperties(
      makeCapture({ activeCandidateIndex: 2 }),
      'added',
      3_500,
    );
    expect(properties.selection_rank).toBe(3);
  });

  it('carries dwell so a snap dismissal reads differently from a considered one', () => {
    const properties = buildScanRowResolvedProperties(makeCapture(), 'dismissed', 3_500);
    expect(properties.dwell_ms).toBe(2_500);
  });

  it('omits dwell for a restored row, whose clock started in a prior session', () => {
    const properties = buildScanRowResolvedProperties(
      makeCapture({ shownAtMs: null }),
      'dismissed',
      3_500,
    );
    expect(properties.dwell_ms).toBeUndefined();
  });

  it('flags a row that never resolved to a card, so "no price" is separable', () => {
    const properties = buildScanRowResolvedProperties(
      makeCapture({ candidates: [] as RecentCapture['candidates'] }),
      'evicted',
      3_500,
    );
    expect(properties.had_price).toBe(false);
    expect(properties.candidate_count).toBe(0);
  });

  it('carries the lane game, so outcomes break down per TCG', () => {
    const properties = buildScanRowResolvedProperties(
      makeCapture(),
      'read',
      3_500,
      'onepiece',
    );
    expect(properties.game).toBe('onepiece');
  });

  it('omits game when the lane does not name one', () => {
    expect(buildScanRowResolvedProperties(makeCapture(), 'read', 3_500).game).toBeUndefined();
  });

  it('carries the matched alt-art printing when the active candidate has one', () => {
    const properties = buildScanRowResolvedProperties(
      makeCapture({
        candidates: [
          { cardId: 'a', matchedVariant: { label: 'Manga Alt Art', tcgplayerProductId: '527026', imageUrl: null, source: 'tcgplayer' } },
        ] as RecentCapture['candidates'],
      }),
      'read',
      3_500,
    );
    expect(properties.matched_variant).toBe('Manga Alt Art');
    expect(buildScanRowResolvedProperties(makeCapture(), 'read', 3_500).matched_variant).toBeUndefined();
  });

  it('every outcome produces one bucket, so outcomes sum to scans attempted', () => {
    const outcomes: ScanRowOutcome[] = ['added', 'opened', 'dismissed', 'read', 'evicted'];
    const buckets = outcomes.map(
      (outcome) => buildScanRowResolvedProperties(makeCapture(), outcome, 3_500).outcome,
    );
    expect(new Set(buckets).size).toBe(outcomes.length);
  });
});

describe('tray thumbnail and the matched alt-art image flag', () => {
  const matchedCandidate = {
    cardId: 'op-1',
    imageUrl: 'https://img/luffy.png',
    smallImageUrl: 'https://img/luffy-small.png',
    matchedVariant: {
      label: 'Manga Alt Art',
      tcgplayerProductId: '527026',
      imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/527026_in_1000x1000.jpg',
      source: 'tcgplayer',
    },
  } as RecentCapture['candidates'][number];

  it("keeps the card's own art by default (image rights not cleared)", () => {
    const capture = makeCapture({ candidates: [matchedCandidate] });
    expect(scannerCaptureThumbUri(capture, matchedCandidate)).toBe('https://img/luffy-small.png');
    expect(scannerCaptureThumbUri(capture, matchedCandidate, false)).toBe('https://img/luffy-small.png');
  });

  it('shows the matched printing image when the flag is on', () => {
    const capture = makeCapture({ candidates: [matchedCandidate] });
    expect(scannerCaptureThumbUri(capture, matchedCandidate, true)).toBe(
      'https://tcgplayer-cdn.tcgplayer.com/product/527026_in_1000x1000.jpg',
    );
  });
});
