import {
  HttpSpotlightRepository,
  SpotlightRepositoryRequestError,
  __resetScanMultipartSupportForTests,
  parseRetryAfterMs,
  scanMatchRetryDelayMs,
} from '../../../../packages/api-client/src/spotlight/repository';
import type { ScannerCapturePayload } from '../../../../packages/api-client/src/spotlight/types';

// Weak-cell scan networking (Hawaii show 2026-10-24/25): only retryable
// failures are re-sent, a transient multipart failure never doubles into a
// base64 re-send, hung requests abort, and artifact uploads yield the uplink
// to in-flight matches.

class MockFormData {
  private parts: Record<string, unknown>[] = [];

  append(fieldName: string, value: unknown) {
    this.parts.push({ fieldName, value });
  }
}

function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

function inlinePayload(): ScannerCapturePayload {
  return {
    mode: 'raw',
    jpegBase64: 'NORM',
    width: 630,
    height: 880,
    captureSource: 'camera',
    normalizedImage: { jpegBase64: 'NORM', width: 630, height: 880 },
    sourceImage: { jpegBase64: 'SRC', width: 1260, height: 1760 },
    submittedAt: '2026-11-17T00:00:00.000Z',
  };
}

function filePayload(): ScannerCapturePayload & { readFileAsBase64: jest.Mock } {
  return {
    mode: 'raw',
    width: 630,
    height: 880,
    fileUri: 'file:///normalized.jpg',
    captureSource: 'camera',
    normalizedImage: { fileUri: 'file:///normalized.jpg', width: 630, height: 880 },
    sourceImage: { fileUri: 'file:///source.jpg', width: 1260, height: 1760 },
    submittedAt: '2026-11-17T00:00:00.000Z',
    readFileAsBase64: jest.fn(async () => 'B64'),
  } as ScannerCapturePayload & { readFileAsBase64: jest.Mock };
}

type FetchCall = [string, RequestInit | undefined];

function matchCalls(): FetchCall[] {
  return ((global.fetch as jest.Mock).mock.calls as FetchCall[])
    .filter(([url]) => String(url).includes('visual-match'));
}

function isMultipart(call: FetchCall) {
  return call[1]?.body instanceof MockFormData;
}

function abortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function matchError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as SpotlightRepositoryRequestError;
  }
  throw new Error('expected the match to fail');
}

describe('scan retry helpers', () => {
  it('backs off exponentially with jitter, honoring Retry-After up to a cap', () => {
    expect(scanMatchRetryDelayMs(0, null, () => 0)).toBe(300);
    expect(scanMatchRetryDelayMs(0, null, () => 1)).toBe(600);
    expect(scanMatchRetryDelayMs(1, null, () => 1)).toBe(1200);
    expect(scanMatchRetryDelayMs(0, 2000, () => 0)).toBe(2000);
    expect(scanMatchRetryDelayMs(0, 60000, () => 0)).toBe(5000);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 7_000)).toBe(3000);
    expect(parseRetryAfterMs('soon')).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });
});

describe('scanner visual-match — weak-signal retry policy', () => {
  const originalFetch = global.fetch;
  const originalFormData = global.FormData;

  beforeEach(() => {
    __resetScanMultipartSupportForTests();
    (global as Record<string, unknown>).FormData = MockFormData;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    (global as Record<string, unknown>).FormData = originalFormData;
    jest.restoreAllMocks();
  });

  it('does not retry a non-retryable 500', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => (
      String(url).includes('visual-match')
        ? jsonResponse(500, { error: 'boom' })
        : jsonResponse(200, {})
    )) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const error = await matchError(repository.matchScannerCapture(inlinePayload()));

    expect(matchCalls()).toHaveLength(1);
    expect(error.failure).toBe('http');
    expect(error.status).toBe(500);
    expect(error.attemptCount).toBe(1);
  });

  it('retries a 503 (honoring Retry-After) and then succeeds', async () => {
    let attempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (!String(url).includes('visual-match')) {
        return jsonResponse(200, {});
      }
      attempts += 1;
      return attempts === 1
        ? jsonResponse(503, { error: 'database is locked' }, { 'retry-after': '1' })
        : jsonResponse(200, { scanID: 's', candidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const startedAt = Date.now();
    const result = await repository.matchScannerCapture(inlinePayload());

    expect(attempts).toBe(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950);
    expect(result.requestAttemptCount).toBe(2);
  }, 10000);

  it('on a multipart network failure, retries multipart only — never a same-attempt base64 re-send', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('visual-match')) {
        throw new Error('Network request failed');
      }
      return jsonResponse(200, {});
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const payload = filePayload();
    const error = await matchError(repository.matchScannerCapture(payload));

    // Before: multipart → JSON, JSON, JSON (4 sends, 3 of them +33% base64).
    expect(matchCalls()).toHaveLength(3);
    expect(matchCalls().every(isMultipart)).toBe(true);
    expect(payload.readFileAsBase64).not.toHaveBeenCalled();
    expect(error.failure).toBe('network');
    expect(error.attemptCount).toBe(3);
  }, 10000);

  it('retries a 502 over multipart without latching the session to JSON', async () => {
    let attempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (!String(url).includes('visual-match')) {
        return jsonResponse(200, {});
      }
      attempts += 1;
      return attempts === 1
        ? jsonResponse(502, 'Bad Gateway')
        : jsonResponse(200, { scanID: 's', candidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.matchScannerCapture(filePayload());
    await repository.matchScannerCapture(filePayload());

    expect(matchCalls()).toHaveLength(3);
    expect(matchCalls().every(isMultipart)).toBe(true);
  }, 10000);

  it('a truncated-body 400 ("multipart body is malformed") does not latch the session to JSON', async () => {
    let attempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (!String(url).includes('visual-match')) {
        return jsonResponse(200, {});
      }
      attempts += 1;
      return attempts === 1
        ? jsonResponse(400, { error: 'multipart body is malformed' })
        : jsonResponse(200, { scanID: 's', candidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.matchScannerCapture(filePayload());
    (global.fetch as jest.Mock).mockClear();
    await repository.matchScannerCapture(filePayload());

    expect(isMultipart(matchCalls()[0])).toBe(true);
  }, 10000);

  it('aborts a hung request at the per-attempt budget and reports a timeout', async () => {
    const realSetTimeout = global.setTimeout;
    const armed: number[] = [];
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 10000) {
        armed.push(ms);
        return realSetTimeout(fn, 5);
      }
      return realSetTimeout(fn, ms);
    }) as typeof global.setTimeout);

    global.fetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (!String(url).includes('visual-match')) {
        return Promise.resolve(jsonResponse(200, {}));
      }
      // Hangs until aborted, like a stalled cellular upload.
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const error = await matchError(repository.matchScannerCapture(inlinePayload()));

    expect(error.failure).toBe('timeout');
    expect(error.attemptCount).toBe(3);
    expect(armed).toEqual(expect.arrayContaining([20000, 15000, 15000]));
  }, 10000);
});

describe('scan artifact queue — yields the uplink to scan matches', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('a starting match preempts the in-flight artifact upload; it resends after the match, full payload, without spending an attempt', async () => {
    const artifactBodies: Record<string, unknown>[] = [];
    let matchCount = 0;
    let releaseSecondMatch: (() => void) | null = null;

    global.fetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('scan-artifacts')) {
        artifactBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (artifactBodies.length === 1) {
          return new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(abortError()));
          });
        }
        return Promise.resolve(jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' }));
      }
      matchCount += 1;
      if (matchCount === 1) {
        return Promise.resolve(jsonResponse(200, { scanID: 'a', candidates: [] }));
      }
      return new Promise((resolve) => {
        releaseSecondMatch = () => resolve(jsonResponse(200, { scanID: 'b', candidates: [] }));
      });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const firstUpload = new Promise<{ status: string } | null>((resolve) => {
      void repository.matchScannerCapture(inlinePayload(), {
        onArtifactUploadComplete: (result) => resolve(result),
      });
    });
    await waitFor(() => artifactBodies.length === 1);

    const secondMatch = repository.matchScannerCapture(inlinePayload());
    await waitFor(() => releaseSecondMatch !== null);
    // Nothing else goes up while the match is in flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(artifactBodies).toHaveLength(1);

    releaseSecondMatch!();
    await secondMatch;
    const result = await firstUpload;

    expect(result?.status).toBe('uploaded');
    expect(artifactBodies.length).toBeGreaterThanOrEqual(2);
    // Resent as attempt 1 again: source_capture still included.
    expect(artifactBodies[1].sourceImage).toMatchObject({ jpegBase64: 'SRC' });
  }, 10000);

  it('runs queued uploads one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
      }
      return jsonResponse(200, { scanID: 's', candidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const uploads = [0, 1, 2].map(() => new Promise<unknown>((resolve) => {
      void repository.matchScannerCapture(inlinePayload(), {
        onArtifactUploadComplete: (result) => resolve(result),
      });
    }));
    await Promise.all(uploads);

    expect(maxInFlight).toBe(1);
  }, 10000);
});
