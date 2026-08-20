import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';
import type { ScannerCapturePayload } from '../../../../packages/api-client/src/spotlight/types';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      if (body === undefined) {
        return '';
      }
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  } as Response;
}

function rawPayload(overrides: Partial<ScannerCapturePayload> = {}): ScannerCapturePayload {
  return {
    mode: 'raw',
    jpegBase64: 'AAAA',
    width: 630,
    height: 880,
    cardLanguage: 'english',
    captureSource: 'camera',
    normalizedImage: { jpegBase64: 'AAAA', width: 630, height: 880 },
    sourceImage: null,
    submittedAt: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

function findMatchBody(pathFragment = 'scan/visual-match'): Record<string, unknown> {
  const calls = (global.fetch as jest.Mock).mock.calls as Array<[string, RequestInit | undefined]>;
  const matchCall = calls.find(([url]) => String(url).includes(pathFragment));
  if (!matchCall) {
    throw new Error(`${pathFragment} request was never issued`);
  }
  return JSON.parse(String(matchCall[1]?.body)) as Record<string, unknown>;
}

/**
 * The backend picks a SEPARATE visual index per game off the scan payload's
 * `game` field, so these assertions are the contract that keeps a Lorcana
 * capture from being matched against the Pokémon catalog.
 */
describe('scanner match payload — game', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockOkFetch() {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { scanID: 'scan-test', candidates: [] }),
    ) as typeof fetch;
  }

  it('sends the requested game with a raw visual match', async () => {
    mockOkFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.matchScannerCapture(rawPayload({ game: 'onepiece', cardLanguage: null }));

    const body = findMatchBody();
    expect(body.game).toBe('onepiece');
    expect(body.cardLanguage).toBeNull();
  });

  it('sends the requested game with a slab match too', async () => {
    mockOkFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.matchScannerCapture(rawPayload({ mode: 'slabs', game: 'lorcana' }));

    expect(findMatchBody('scan/match').game).toBe('lorcana');
  });

  it('defaults to Pokémon when the capture names no game', async () => {
    // Pre-multi-game callers send nothing; the backend reads an absent game as
    // Pokémon, so sending it explicitly resolves identically.
    mockOkFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.matchScannerCapture(rawPayload());

    expect(findMatchBody().game).toBe('pokemon');
  });

  it('leaves the rest of a Pokémon capture byte-identical', async () => {
    mockOkFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.matchScannerCapture(rawPayload({ game: 'pokemon' }));

    const body = findMatchBody();
    // Everything a Pokémon EN scan has always sent, unchanged — `game` is the
    // only addition, and it carries the value the backend already inferred.
    expect(body).toMatchObject({
      game: 'pokemon',
      cardLanguage: 'english',
      resolverModeHint: 'raw_card',
      rawResolverMode: 'visual',
      collectorNumber: null,
      ocrAnalysis: null,
      recognizedTokens: [],
      setHintTokens: [],
      setBadgeHint: null,
      promoCodeHint: null,
      cropConfidence: 1,
      warnings: [],
    });
    expect(Object.keys(body).sort()).toEqual([
      'capturedAt',
      'cardLanguage',
      'clientContext',
      'collectorNumber',
      'cropConfidence',
      'game',
      'image',
      'ocrAnalysis',
      'promoCodeHint',
      'rawResolverMode',
      'recognizedTokens',
      'resolverModeHint',
      'scanID',
      'setBadgeHint',
      'setHintTokens',
      'slabBarcodePayloads',
      'slabCardNumberRaw',
      'slabCertConfidence',
      'slabCertNumber',
      'slabClassifierReasons',
      'slabGrade',
      'slabGradeConfidence',
      'slabGrader',
      'slabGraderConfidence',
      'slabParsedLabelText',
      'slabRecommendedLookupPath',
      'warnings',
    ]);
  });
});
