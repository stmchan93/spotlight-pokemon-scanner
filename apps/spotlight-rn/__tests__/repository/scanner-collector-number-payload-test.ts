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

function findVisualMatchBody(): Record<string, unknown> {
  const calls = (global.fetch as jest.Mock).mock.calls as Array<[string, RequestInit | undefined]>;
  const matchCall = calls.find(([url]) => String(url).includes('scan/visual-match'));
  if (!matchCall) {
    throw new Error('visual-match request was never issued');
  }
  return JSON.parse(String(matchCall[1]?.body)) as Record<string, unknown>;
}

describe('scanner match payload — raw collector number (Phase 2)', () => {
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

  it('forwards the on-device collector number into ocrAnalysis.rawEvidence and collectorNumber', async () => {
    mockOkFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.matchScannerCapture(
      rawPayload({
        ocrAnalysis: { rawEvidence: { collectorNumberExact: '089/162' } },
      }),
    );

    const body = findVisualMatchBody();
    expect(body.collectorNumber).toBe('089/162');
    expect(body.ocrAnalysis).toEqual({ rawEvidence: { collectorNumberExact: '089/162' } });
  });

  it('keeps collectorNumber null and ocrAnalysis null when no number was read', async () => {
    mockOkFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.matchScannerCapture(rawPayload());

    const body = findVisualMatchBody();
    expect(body.collectorNumber).toBeNull();
    expect(body.ocrAnalysis).toBeNull();
  });

  it('ignores an empty collector-number string', async () => {
    mockOkFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.matchScannerCapture(
      rawPayload({ ocrAnalysis: { rawEvidence: { collectorNumberExact: '   ' } } }),
    );

    const body = findVisualMatchBody();
    expect(body.collectorNumber).toBeNull();
    expect(body.ocrAnalysis).toBeNull();
  });
});
