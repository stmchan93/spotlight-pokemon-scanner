import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';
import type { ScannerCapturePayload } from '../../../../packages/api-client/src/spotlight/types';

// Coverage for the 2026-06 "matches could not load" fix: the RAW visual-match request is
// retried on transient transport/timeout/HTTP failures (so one stalled upload on a weak
// network recovers instead of dead-ending), a successful 200 is NEVER retried (a
// low-confidence/wrong match must pass straight through), and the raw artifact upload is
// DEFERRED until after the match so it stops starving the match for uplink bandwidth.
// Slab matches are intentionally untouched (single long attempt, parallel upload).

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

function rawPayload(): ScannerCapturePayload {
  return {
    mode: 'raw',
    jpegBase64: 'NORM',
    width: 630,
    height: 880,
    cardLanguage: 'english',
    captureSource: 'camera',
    normalizedImage: { jpegBase64: 'NORM', width: 630, height: 880 },
    sourceImage: { jpegBase64: 'SRC', width: 1260, height: 1760 },
    submittedAt: '2026-06-18T00:00:00.000Z',
  };
}

function slabPayload(): ScannerCapturePayload {
  return { ...rawPayload(), mode: 'slabs' };
}

function callKind(url: string): 'raw-match' | 'slab-match' | 'artifact' | 'other' {
  const u = String(url);
  if (u.includes('scan-artifacts')) return 'artifact';
  if (u.includes('visual-match')) return 'raw-match';
  if (u.includes('scan/match')) return 'slab-match';
  return 'other';
}

describe('scanner visual-match — retry + deferred raw artifact upload', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('retries a raw match after a transient transport failure, then succeeds', async () => {
    let matchAttempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (callKind(url) === 'raw-match') {
        matchAttempts += 1;
        if (matchAttempts === 1) {
          throw new Error('network stalled'); // transport failure (her `request_failed`)
        }
        return jsonResponse(200, { scanID: 'scan-test', candidates: [], topCandidates: [] });
      }
      return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.matchScannerCapture(rawPayload());

    expect(matchAttempts).toBe(2); // failed once, retried, landed
    expect(result.candidates).toEqual([]);
  }, 15000);

  it('gives up after a bounded number of raw attempts when every attempt fails', async () => {
    let matchAttempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (callKind(url) === 'raw-match') {
        matchAttempts += 1;
        throw new Error('network stalled');
      }
      return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await expect(repository.matchScannerCapture(rawPayload())).rejects.toBeTruthy();

    expect(matchAttempts).toBe(3); // 1 initial + 2 retries, then surfaces failure (no infinite loop)
  }, 15000);

  it('does NOT retry a successful 200 — a low-confidence/wrong match passes straight through', async () => {
    let matchAttempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (callKind(url) === 'raw-match') {
        matchAttempts += 1;
        // A scattered/empty shortlist is still a successful response — must not be retried.
        return jsonResponse(200, { scanID: 'scan-test', candidates: [], topCandidates: [] });
      }
      return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.matchScannerCapture(rawPayload());

    expect(matchAttempts).toBe(1);
  });

  it('defers the raw artifact upload until AFTER the match request', async () => {
    const order: string[] = [];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      order.push(callKind(url));
      if (callKind(url) === 'raw-match') {
        return jsonResponse(200, { scanID: 'scan-test', candidates: [], topCandidates: [] });
      }
      return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const artifactFired = new Promise<void>((resolve) => {
      void repository.matchScannerCapture(rawPayload(), {
        onArtifactUploadComplete: () => resolve(),
      });
    });
    await artifactFired;

    expect(order[0]).toBe('raw-match');
    expect(order.indexOf('raw-match')).toBeLessThan(order.indexOf('artifact'));
  }, 15000);

  it('exposes a distinct non-null smallImageUrl on a mapped scan candidate so RN can fetch thumbnails', async () => {
    // The backend returns BOTH imageSmallURL and imageLargeURL per candidate. The mapper
    // must surface them as smallImageUrl/largeImageUrl (thumbnail vs full-res) while keeping
    // imageUrl preferring the large url for back-compat.
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (callKind(url) === 'raw-match') {
        return jsonResponse(200, {
          scanID: 'scan-test',
          candidates: [],
          topCandidates: [
            {
              finalScore: 0.91,
              candidate: {
                id: 'sv1-1',
                name: 'Sprigatito',
                setName: 'Scarlet & Violet',
                number: '1/198',
                imageSmallURL: 'https://cdn.example.test/sv1/1-small.png',
                imageLargeURL: 'https://cdn.example.test/sv1/1-large.png',
                pricing: { currencyCode: 'USD', market: 1.23 },
              },
            },
          ],
        });
      }
      return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.matchScannerCapture(rawPayload());

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate.smallImageUrl).toBe('https://cdn.example.test/sv1/1-small.png');
    expect(candidate.largeImageUrl).toBe('https://cdn.example.test/sv1/1-large.png');
    // small must be distinct from large so RN actually downloads the smaller asset
    expect(candidate.smallImageUrl).not.toBe(candidate.largeImageUrl);
    // imageUrl stays large-preferring for back-compat
    expect(candidate.imageUrl).toBe('https://cdn.example.test/sv1/1-large.png');
  }, 15000);

  it('keeps an unnumbered promo candidate (blank collector number) instead of dropping it', async () => {
    // Regression for the 2026-06 "my scanned card is never in the list" bug: unnumbered JP
    // promos (e.g. Game Boy Dragonite miscp_ja-68, Ancient Mew) carry a blank `number`.
    // normalizeCardCandidate used to require a non-empty number, so it silently dropped these
    // ~589 cards from scan candidates — a perfect match was invisible in the UI. They must
    // now survive mapping, with the blank number rendered as the '--' placeholder.
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (callKind(url) === 'raw-match') {
        return jsonResponse(200, {
          scanID: 'scan-test',
          candidates: [],
          topCandidates: [
            {
              finalScore: 0.67,
              candidate: {
                id: 'miscp_ja-68',
                name: 'Dragonite',
                setName: 'Unnumbered Promos',
                number: '',
                imageSmallURL: 'https://cdn.example.test/gb/small.png',
                imageLargeURL: 'https://cdn.example.test/gb/large.png',
                pricing: { currencyCode: 'USD', market: null },
              },
            },
          ],
        });
      }
      return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.matchScannerCapture(rawPayload());

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].cardId).toBe('miscp_ja-68');
    // blank number renders as the '--' placeholder rather than dropping the card
    expect(result.candidates[0].cardNumber).toBe('#--');
  }, 15000);

  it('does NOT retry slab matches (they keep a single long attempt)', async () => {
    let slabAttempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (callKind(url) === 'slab-match') {
        slabAttempts += 1;
        throw new Error('network stalled');
      }
      return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await expect(repository.matchScannerCapture(slabPayload())).rejects.toBeTruthy();

    expect(slabAttempts).toBe(1); // unchanged: no retry for slabs
  }, 15000);
});
