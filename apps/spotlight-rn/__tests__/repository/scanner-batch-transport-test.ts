import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
  __resetScanMultipartSupportForTests,
} from '../../../../packages/api-client/src/spotlight/repository';
import type { ScannerCapturePayload } from '../../../../packages/api-client/src/spotlight/types';

// Coverage for the binder-page batch lane: matchScannerCaptureBatch posts ONE
// multipart request (payload part + one normalized_image_{i} part per pocket)
// to /api/v1/scan/visual-match-batch, maps per-pocket results back onto their
// pocketIndex, isolates per-item server errors, falls back to JSON+base64 when
// multipart fails, and surfaces a whole-request failure (older backend 404) as
// a throw so the screen can run its per-pocket fallback.
// Also covers the binder-page STREAMED lane: prepareBinderPage uploads the
// page once (multipart payload+page_image, JSON pageImage fallback, 404 throw
// for the batch fallback), and matchScannerCapture with payload.binderPage
// sends a small JSON body referencing the stored pocket with no image bytes.
// createInventoryEntriesBulk posts the single-create body shape per entry.

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

function pocketPayload(index: number): ScannerCapturePayload {
  return {
    mode: 'raw',
    width: 630,
    height: 880,
    fileUri: `file:///pocket-${index}.jpg`,
    cardLanguage: 'english',
    captureSource: 'camera',
    normalizedImage: { fileUri: `file:///pocket-${index}.jpg`, width: 630, height: 880 },
    submittedAt: '2026-08-30T00:00:00.000Z',
    readFileAsBase64: jest.fn(async () => `B64-${index}`),
  } as ScannerCapturePayload;
}

function batchResponseBody(pocketCount: number, overrides: Record<number, object> = {}) {
  return {
    results: Array.from({ length: pocketCount }, (_, pocketIndex) => ({
      pocketIndex,
      scanID: `scan-${pocketIndex}`,
      topCandidates: [],
      candidatePoolSize: 0,
      reviewDisposition: 'needs_review',
      confidence: 'low',
      ...(overrides[pocketIndex] ?? {}),
    })),
  };
}

type FetchCall = [string, RequestInit | undefined];

function callsTo(pathFragment: string): FetchCall[] {
  const calls = (global.fetch as jest.Mock).mock.calls as FetchCall[];
  return calls.filter(([url]) => String(url).includes(pathFragment));
}

describe('matchScannerCaptureBatch transport', () => {
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

  it('posts one multipart request with a payload part and one normalized_image_{i} part per pocket', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
      }
      return jsonResponse(200, batchResponseBody(3));
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const items = [pocketPayload(0), pocketPayload(1), pocketPayload(2)];
    const batch = await repository.matchScannerCaptureBatch(items);

    const batchCalls = callsTo('scan/visual-match-batch');
    expect(batchCalls).toHaveLength(1);
    const [, init] = batchCalls[0];
    expect(init?.body).toBeInstanceOf(MockFormData);
    const parts = (init?.body as unknown as MockFormData).getParts();
    const payloadPart = parts.find((part) => part.fieldName === 'payload');
    expect(payloadPart).toBeTruthy();
    const payloadJson = JSON.parse(String(payloadPart?.string)) as Record<string, unknown>;
    // Shared fields ride once; scanID/image live per item.
    expect(payloadJson.resolverModeHint).toBe('raw_card');
    expect(payloadJson.scanID).toBeUndefined();
    const payloadItems = payloadJson.items as Record<string, unknown>[];
    expect(payloadItems).toHaveLength(3);
    payloadItems.forEach((item, index) => {
      expect(item.pocketIndex).toBe(index);
      expect(typeof item.scanID).toBe('string');
      expect((item.image as Record<string, unknown>).jpegBase64).toBeUndefined();
    });
    // One JPEG file part per pocket, indexed by pocket.
    [0, 1, 2].forEach((index) => {
      const filePart = parts.find((part) => part.fieldName === `normalized_image_${index}`);
      expect(filePart).toBeTruthy();
      expect(filePart?.uri).toBe(`file:///pocket-${index}.jpg`);
    });
    // No base64 was materialized on the multipart path.
    items.forEach((item) => expect(item.readFileAsBase64).not.toHaveBeenCalled());

    expect(batch.results.map((result) => result.pocketIndex)).toEqual([0, 1, 2]);
    batch.results.forEach((result) => {
      expect(result.errorMessage).toBeNull();
      expect(result.result?.scanID).toMatch(/^scan-\d$/);
      expect(result.result?.confidence).toBe('low');
    });
  });

  it('surfaces a per-item server error without failing the batch', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, {});
      }
      return jsonResponse(
        200,
        batchResponseBody(2, { 1: { error: 'Visual scan match failed', topCandidates: undefined } }),
      );
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const batch = await repository.matchScannerCaptureBatch([pocketPayload(0), pocketPayload(1)]);

    expect(batch.results[0].result).toBeTruthy();
    expect(batch.results[0].errorMessage).toBeNull();
    expect(batch.results[1].result).toBeNull();
    expect(batch.results[1].errorMessage).toBe('Visual scan match failed');
  });

  it('falls back to JSON+base64 items when multipart is rejected', async () => {
    let sawMultipart = 0;
    let sawJson = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, {});
      }
      if (init?.body instanceof MockFormData) {
        sawMultipart += 1;
        return jsonResponse(400, { error: 'Invalid JSON body' });
      }
      sawJson += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const items = body.items as Record<string, unknown>[];
      expect(items).toHaveLength(2);
      items.forEach((item, index) => {
        expect((item.image as Record<string, unknown>).jpegBase64).toBe(`B64-${index}`);
      });
      return jsonResponse(200, batchResponseBody(2));
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const batch = await repository.matchScannerCaptureBatch([pocketPayload(0), pocketPayload(1)]);

    expect(sawMultipart).toBe(1);
    expect(sawJson).toBe(1);
    expect(batch.results).toHaveLength(2);
    expect(batch.results.every((result) => result.result)).toBe(true);
  });

  it('does NOT re-send the batch over JSON after a multipart 503 — the server may still be processing it', async () => {
    let sawMultipart = 0;
    let sawJson = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.body instanceof MockFormData) {
        sawMultipart += 1;
        return jsonResponse(503, { error: 'Scanner is busy right now. Please try again.', errorType: 'ScannerBusy' });
      }
      sawJson += 1;
      return jsonResponse(200, batchResponseBody(1));
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await expect(
      repository.matchScannerCaptureBatch([pocketPayload(0)]),
    ).rejects.toMatchObject({ status: 503 });
    expect(sawMultipart).toBe(1);
    expect(sawJson).toBe(0);
  });

  it('throws on a whole-request failure (older backend 404) so callers can fall back per-pocket', async () => {
    global.fetch = jest.fn().mockImplementation(async () => jsonResponse(404, { error: 'Not found' })) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await expect(
      repository.matchScannerCaptureBatch([pocketPayload(0)]),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('prepareBinderPage transport', () => {
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

  it('posts one multipart request: image-metadata payload part + page_image file part, no manual Content-Type', async () => {
    global.fetch = jest.fn().mockImplementation(async () => (
      jsonResponse(200, { pageToken: 'tok-1', pocketCount: 9, expiresInSeconds: 600 })
    )) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const prepared = await repository.prepareBinderPage(
      { fileUri: 'file:///page.jpg', width: 3024, height: 3024 },
    );

    const prepareCalls = callsTo('scan/binder-page/prepare');
    expect(prepareCalls).toHaveLength(1);
    const [, init] = prepareCalls[0];
    expect(init?.body).toBeInstanceOf(MockFormData);
    const parts = (init?.body as unknown as MockFormData).getParts();
    const payloadPart = parts.find((part) => part.fieldName === 'payload');
    expect(JSON.parse(String(payloadPart?.string))).toEqual({ image: { width: 3024, height: 3024 } });
    const filePart = parts.find((part) => part.fieldName === 'page_image');
    expect(filePart?.uri).toBe('file:///page.jpg');
    // fetch must generate the multipart boundary itself.
    expect((init?.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined();

    expect(prepared).toEqual({ pageToken: 'tok-1', pocketCount: 9, expiresInSeconds: 600 });
  });

  it('falls back to the JSON pageImage body when multipart is rejected', async () => {
    let sawMultipart = 0;
    let sawJson = 0;
    global.fetch = jest.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.body instanceof MockFormData) {
        sawMultipart += 1;
        return jsonResponse(400, { error: 'Invalid JSON body' });
      }
      sawJson += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({ pageImage: { jpegBase64: 'PAGE64', width: 3024, height: 3024 } });
      return jsonResponse(200, { pageToken: 'tok-json', pocketCount: 9, expiresInSeconds: 600 });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const readFileAsBase64 = jest.fn(async () => 'PAGE64');
    const prepared = await repository.prepareBinderPage(
      { fileUri: 'file:///page.jpg', width: 3024, height: 3024 },
      { readFileAsBase64 },
    );

    expect(sawMultipart).toBe(1);
    expect(sawJson).toBe(1);
    expect(readFileAsBase64).toHaveBeenCalledWith('file:///page.jpg');
    expect(prepared.pageToken).toBe('tok-json');
  });

  it('throws with status 404 on older backends so callers can fall back to the batch lane', async () => {
    global.fetch = jest.fn().mockImplementation(async () => jsonResponse(404, { error: 'Not found' })) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await expect(
      repository.prepareBinderPage(
        { fileUri: 'file:///page.jpg', width: 3024, height: 3024 },
        { readFileAsBase64: async () => 'PAGE64' },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('matchScannerCapture with a binderPage reference', () => {
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

  it('sends one small JSON body carrying binderPage and NO image bytes, and still maps the response', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs' });
      }
      expect(String(url)).toContain('scan/visual-match');
      // Never multipart on the token lane — a plain JSON body.
      expect(init?.body).not.toBeInstanceOf(MockFormData);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.binderPage).toEqual({ pageToken: 'tok-1', pocketIndex: 4 });
      expect(body.image).toBeUndefined();
      expect(String(init?.body)).not.toContain('jpegBase64');
      return jsonResponse(200, {
        scanID: 'scan-4',
        topCandidates: [],
        candidatePoolSize: 0,
        reviewDisposition: 'needs_review',
        confidence: 'low',
      });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const payload = {
      ...pocketPayload(4),
      binderPage: { pageToken: 'tok-1', pocketIndex: 4 },
    };
    let resolveArtifact: (value: unknown) => void = () => {};
    const artifactDone = new Promise((resolve) => {
      resolveArtifact = resolve;
    });
    const result = await repository.matchScannerCapture(payload, {
      onArtifactUploadComplete: (artifactResult) => resolveArtifact(artifactResult),
    });
    await artifactDone;

    expect(callsTo('scan/visual-match')).toHaveLength(1);
    expect(result.scanID).toBe('scan-4');
    expect(result.confidence).toBe('low');
    // The local crop rode ONLY in the deferred artifact upload (multipart from
    // disk), never in the match request and never as base64.
    expect(callsTo('scan-artifacts')).toHaveLength(1);
    expect(payload.readFileAsBase64).not.toHaveBeenCalled();
  });

  it('surfaces a BinderPageTokenUnknown 400 with the errorType readable in the message', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, {});
      }
      return jsonResponse(400, { error: 'Unknown binder page token.', errorType: 'BinderPageTokenUnknown' });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await expect(
      repository.matchScannerCapture({
        ...pocketPayload(0),
        binderPage: { pageToken: 'tok-dead', pocketIndex: 0 },
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('BinderPageTokenUnknown'),
    });
  }, 15000);
});

describe('createInventoryEntriesBulk transport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('posts the single-create body shape per entry and returns per-entry results', async () => {
    global.fetch = jest.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const entries = body.entries as Record<string, unknown>[];
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        cardID: 'obf-223',
        condition: 'near_mint',
        quantity: 1,
        selectionSource: 'top',
        collectionID: null,
      });
      return jsonResponse(200, {
        results: [
          { index: 0, deckEntryID: 'entry-0', cardID: 'obf-223', addedAt: '2026-08-30T00:00:00Z' },
          { index: 1, error: 'cardID is required', errorType: 'ValueError' },
        ],
        createdCount: 1,
        failedCount: 1,
      });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const entry = {
      cardID: 'obf-223',
      slabContext: null,
      condition: 'near_mint' as const,
      quantity: 1,
      sourceScanID: 'scan-0',
      selectionSource: 'top' as const,
      addedAt: '2026-08-30T00:00:00Z',
    };
    const response = await repository.createInventoryEntriesBulk([entry, { ...entry, cardID: '' }]);

    const calls = (global.fetch as jest.Mock).mock.calls as FetchCall[];
    expect(String(calls[0][0])).toContain('/api/v1/deck/entries/create-bulk');
    expect(response.createdCount).toBe(1);
    expect(response.results[0].deckEntryID).toBe('entry-0');
    expect(response.results[1].errorType).toBe('ValueError');
  });
});

describe('mock repository batch methods', () => {
  it('matchScannerCaptureBatch resolves one result per pocket', async () => {
    const repository = new MockSpotlightRepository();
    const batch = await repository.matchScannerCaptureBatch([pocketPayload(0), pocketPayload(1)]);
    expect(batch.results.map((result) => result.pocketIndex)).toEqual([0, 1]);
    batch.results.forEach((result) => {
      expect(result.errorMessage).toBeNull();
      expect(result.result?.candidates.length).toBeGreaterThan(0);
    });
  });

  it('prepareBinderPage resolves a token for nine pockets', async () => {
    const repository = new MockSpotlightRepository();
    const prepared = await repository.prepareBinderPage({ fileUri: 'file:///page.jpg', width: 100, height: 100 });
    expect(prepared.pageToken).toBeTruthy();
    expect(prepared.pocketCount).toBe(9);
    expect(prepared.expiresInSeconds).toBeGreaterThan(0);
  });

  it('createInventoryEntriesBulk resolves per-entry results with indexes', async () => {
    const repository = new MockSpotlightRepository();
    const entry = {
      cardID: 'swsh12pt5gg-GG44',
      slabContext: null,
      condition: 'near_mint' as const,
      quantity: 1,
      sourceScanID: null,
      addedAt: '2026-08-30T00:00:00Z',
    };
    const response = await repository.createInventoryEntriesBulk([entry, entry]);
    expect(response.results.map((result) => result.index)).toEqual([0, 1]);
    expect(response.createdCount + response.failedCount).toBe(2);
  });
});
