import {
  HttpSpotlightRepository,
  __resetScanMultipartSupportForTests,
} from '../../../../packages/api-client/src/spotlight/repository';
import type { ScannerCapturePayload } from '../../../../packages/api-client/src/spotlight/types';

// Coverage for the 2026-07 multipart scan transport: the default path streams
// the scan JPEGs as multipart file parts (payload JSON minus base64 + file
// parts the OS uploads natively), so no image base64 ever crosses the JS
// thread. If the backend doesn't speak multipart (400/404/405/415 — deployed
// pre-multipart backends answer 400 "Invalid JSON body") the SAME call
// falls back to the legacy JSON+base64 body — materialized through the LAZY
// readFileAsBase64 reader — and the failure is remembered for the rest of the
// app session so later scans go straight to JSON. A scan must never hard-fail
// on transport negotiation.

// React-Native-flavored FormData stand-in: keeps appended parts inspectable
// via getParts() (Node's undici FormData would stringify the RN `{ uri, name,
// type }` file descriptor and hide it from assertions).
type MockFormDataPart = Record<string, unknown> & { fieldName: string };

class MockFormData {
  private parts: MockFormDataPart[] = [];

  append(fieldName: string, value: unknown) {
    if (typeof value === 'string') {
      this.parts.push({ fieldName, string: value });
      return;
    }
    this.parts.push({ fieldName, ...(value as Record<string, unknown>) });
  }

  getParts(): MockFormDataPart[] {
    return this.parts;
  }
}

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

function rawFilePayload(
  overrides: Partial<ScannerCapturePayload> = {},
): ScannerCapturePayload & { readFileAsBase64: jest.Mock } {
  const readFileAsBase64 = jest.fn(async (fileUri: string) => (
    fileUri === 'file:///source.jpg' ? 'SRCB64' : 'NORMB64'
  ));
  return {
    mode: 'raw',
    width: 630,
    height: 880,
    fileUri: 'file:///normalized.jpg',
    cardLanguage: 'english',
    captureSource: 'camera',
    normalizedImage: { fileUri: 'file:///normalized.jpg', width: 630, height: 880 },
    sourceImage: { fileUri: 'file:///source.jpg', width: 1260, height: 1760 },
    submittedAt: '2026-07-18T00:00:00.000Z',
    readFileAsBase64,
    ...overrides,
  } as ScannerCapturePayload & { readFileAsBase64: jest.Mock };
}

type FetchCall = [string, RequestInit | undefined];

function callsTo(pathFragment: string): FetchCall[] {
  const calls = (global.fetch as jest.Mock).mock.calls as FetchCall[];
  return calls.filter(([url]) => String(url).includes(pathFragment));
}

function partsOf(init: RequestInit | undefined): MockFormDataPart[] {
  expect(init?.body).toBeInstanceOf(MockFormData);
  return (init?.body as unknown as MockFormData).getParts();
}

function payloadPartJson(init: RequestInit | undefined): Record<string, unknown> {
  const part = partsOf(init).find((entry) => entry.fieldName === 'payload');
  expect(part).toBeTruthy();
  return JSON.parse(String(part?.string)) as Record<string, unknown>;
}

describe('scanner multipart transport', () => {
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

  it('posts the raw match + artifacts as multipart by default: payload part without base64, JPEG file parts, no manual Content-Type, no base64 read', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
      }
      return jsonResponse(200, { scanID: 'scan-test', candidates: [], topCandidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const payload = rawFilePayload();

    const artifactDone = new Promise<{ status: string } | null>((resolve) => {
      void repository.matchScannerCapture(payload, {
        onArtifactUploadComplete: (result) => resolve(result),
      });
    });
    const artifactResult = await artifactDone;

    // --- visual-match ---
    const [matchCall] = callsTo('scan/visual-match');
    expect(matchCall).toBeTruthy();
    const matchParts = partsOf(matchCall[1]);
    const matchPayloadJson = payloadPartJson(matchCall[1]);
    // The payload part is today's JSON body MINUS the base64 image field.
    expect(matchPayloadJson.image).toEqual({ width: 630, height: 880 });
    expect(matchPayloadJson.image).not.toHaveProperty('jpegBase64');
    expect(matchPayloadJson.resolverModeHint).toBe('raw_card');
    expect(matchParts.find((part) => part.fieldName === 'normalized_image')).toMatchObject({
      uri: 'file:///normalized.jpg',
      name: 'normalized.jpg',
      type: 'image/jpeg',
    });
    // fetch must generate the multipart boundary itself.
    expect(matchCall[1]?.headers).toBeUndefined();

    // --- scan-artifacts ---
    expect(artifactResult?.status).toBe('uploaded');
    const [artifactCall] = callsTo('scan-artifacts');
    const artifactParts = partsOf(artifactCall[1]);
    const artifactPayloadJson = payloadPartJson(artifactCall[1]);
    expect(artifactPayloadJson.normalizedImage).toEqual({ width: 630, height: 880 });
    expect(artifactPayloadJson.sourceImage).toEqual({ width: 1260, height: 1760 });
    expect(artifactPayloadJson.normalizedImage).not.toHaveProperty('jpegBase64');
    expect(artifactParts.find((part) => part.fieldName === 'normalized_image')).toMatchObject({
      uri: 'file:///normalized.jpg',
      type: 'image/jpeg',
    });
    expect(artifactParts.find((part) => part.fieldName === 'source_image')).toMatchObject({
      uri: 'file:///source.jpg',
      type: 'image/jpeg',
    });

    // The whole default flow never materialized base64.
    expect(payload.readFileAsBase64).not.toHaveBeenCalled();
  });

  it.each([400, 404, 405, 415])('falls back to JSON+base64 for the SAME call on %d and remembers it for the session', async (unsupportedStatus) => {
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const multipart = init?.body instanceof MockFormData;
      if (String(url).includes('scan-artifacts')) {
        return multipart
          ? jsonResponse(unsupportedStatus, { error: 'unsupported' })
          : jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
      }
      return multipart
        ? jsonResponse(unsupportedStatus, { error: 'unsupported' })
        : jsonResponse(200, { scanID: 'scan-test', candidates: [], topCandidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const payload = rawFilePayload();

    const firstArtifactDone = new Promise<{ status: string } | null>((resolve) => {
      void repository.matchScannerCapture(payload, {
        onArtifactUploadComplete: (result) => resolve(result),
      }).then(
        (result) => expect(result.scanID).toBe('scan-test'),
        (error) => { throw error; },
      );
    });
    const firstArtifactResult = await firstArtifactDone;

    // Match: one doomed multipart attempt, then the JSON retry of the SAME call
    // with the LAZILY read base64 — the scan never hard-fails.
    const matchCalls = callsTo('scan/visual-match');
    expect(matchCalls).toHaveLength(2);
    expect(matchCalls[0][1]?.body).toBeInstanceOf(MockFormData);
    expect(typeof matchCalls[1][1]?.body).toBe('string');
    const jsonMatchBody = JSON.parse(String(matchCalls[1][1]?.body)) as {
      image: { jpegBase64?: string; width: number; height: number };
    };
    expect(jsonMatchBody.image).toEqual({ jpegBase64: 'NORMB64', height: 880, width: 630 });
    expect(payload.readFileAsBase64).toHaveBeenCalledWith('file:///normalized.jpg');

    // The artifact upload runs AFTER the match discovered the missing support,
    // so it goes straight to JSON with materialized base64 for BOTH images.
    expect(firstArtifactResult?.status).toBe('uploaded');
    const artifactCalls = callsTo('scan-artifacts');
    expect(artifactCalls).toHaveLength(1);
    expect(typeof artifactCalls[0][1]?.body).toBe('string');
    const artifactBody = JSON.parse(String(artifactCalls[0][1]?.body)) as Record<string, any>;
    expect(artifactBody.normalizedImage).toEqual({ jpegBase64: 'NORMB64', width: 630, height: 880 });
    expect(artifactBody.sourceImage).toEqual({ jpegBase64: 'SRCB64', width: 1260, height: 1760 });

    // A SECOND scan in the same session skips multipart entirely.
    await repository.matchScannerCapture(rawFilePayload());
    const allMatchCalls = callsTo('scan/visual-match');
    expect(allMatchCalls).toHaveLength(3);
    expect(typeof allMatchCalls[2][1]?.body).toBe('string');
  }, 15000);

  it('on a non-negotiation failure (500): retries THIS call over JSON without latching — the next call attempts multipart again', async () => {
    // Belt and braces: a scan must never fail without having tried the JSON
    // transport once. But a 500 is not "multipart unsupported", so the session
    // flag must NOT latch — the next scan attempts multipart again.
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
      }
      return jsonResponse(500, { error: 'boom' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const payload = rawFilePayload();
    await expect(repository.matchScannerCapture(payload)).rejects.toBeTruthy();

    const matchCalls = callsTo('scan/visual-match');
    // Multipart attempts (initial + raw retries) then JSON attempts for the
    // same call — both transports were exercised before surfacing the error.
    const formCalls = matchCalls.filter(([, init]) => init?.body instanceof MockFormData);
    const jsonCalls = matchCalls.filter(([, init]) => !(init?.body instanceof MockFormData));
    expect(formCalls.length).toBeGreaterThan(0);
    expect(jsonCalls.length).toBeGreaterThan(0);
    expect(payload.readFileAsBase64).toHaveBeenCalled();

    // No latch: a fresh call starts on multipart again.
    (global.fetch as jest.Mock).mockClear();
    await expect(repository.matchScannerCapture(rawFilePayload())).rejects.toBeTruthy();
    const secondCalls = callsTo('scan/visual-match');
    expect(secondCalls[0]?.[1]?.body).toBeInstanceOf(MockFormData);
  }, 15000);

  it('keeps the slab match on JSON (multipart is only contracted for /scan/visual-match), reading base64 lazily', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
      }
      return jsonResponse(200, { scanID: 'scan-test', candidates: [], topCandidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const payload = rawFilePayload({ mode: 'slabs' });
    await repository.matchScannerCapture(payload);

    const matchCalls = callsTo('scan/match');
    expect(matchCalls).toHaveLength(1);
    expect(typeof matchCalls[0][1]?.body).toBe('string');
    const body = JSON.parse(String(matchCalls[0][1]?.body)) as {
      image: { jpegBase64?: string };
    };
    expect(body.image.jpegBase64).toBe('NORMB64');
    expect(payload.readFileAsBase64).toHaveBeenCalledWith('file:///normalized.jpg');
  });

  it('full-upload failure on BOTH transports → normalized-only retry starts multipart again without source_image', async () => {
    // Attempt 1: multipart full upload → 500. Attempt 2: same-call JSON
    // belt-and-braces → 500. Outer retry then goes normalized-only, starting
    // on multipart again (no latch from a 500): no source part, sourceImage
    // null in the payload part.
    let artifactAttempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        artifactAttempts += 1;
        if (artifactAttempts <= 2) {
          return jsonResponse(500, { error: 'boom' });
        }
        return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
      }
      return jsonResponse(200, { scanID: 'scan-test', candidates: [], topCandidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const artifactDone = new Promise<{ status: string } | null>((resolve) => {
      void repository.matchScannerCapture(rawFilePayload(), {
        onArtifactUploadComplete: (result) => resolve(result),
      });
    });
    const result = await artifactDone;
    expect(result?.status).toBe('uploaded');

    const artifactCalls = callsTo('scan-artifacts');
    expect(artifactCalls.length).toBeGreaterThanOrEqual(3);
    // First attempt streams both files as multipart...
    const firstParts = partsOf(artifactCalls[0][1]);
    expect(firstParts.some((part) => part.fieldName === 'source_image')).toBe(true);
    // ...second attempt is the same-call JSON fallback carrying both images...
    const secondBody = artifactCalls[1][1]?.body;
    expect(typeof secondBody).toBe('string');
    expect(String(secondBody)).toContain('jpegBase64');
    // ...and the normalized-only retry is multipart again with no source part.
    const retryCall = artifactCalls[artifactCalls.length - 1];
    const retryParts = partsOf(retryCall[1]);
    expect(retryParts.some((part) => part.fieldName === 'source_image')).toBe(false);
    expect(retryParts.some((part) => part.fieldName === 'normalized_image')).toBe(true);
    expect(payloadPartJson(retryCall[1]).sourceImage).toBeNull();
  }, 15000);
});
