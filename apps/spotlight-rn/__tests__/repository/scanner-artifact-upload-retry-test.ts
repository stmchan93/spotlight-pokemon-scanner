import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';
import type { ScannerCapturePayload } from '../../../../packages/api-client/src/spotlight/types';

// Regression coverage for the 2026-06 artifact-upload hardening: the upload is
// retried with backoff, and every attempt AFTER the first posts a
// normalized-only payload (source image stripped) to shrink the body. The
// normalized image is the training-critical one, so dropping source on retry
// has no training-data cost but improves landing odds on weak uplinks.

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

function rawPayloadWithSource(): ScannerCapturePayload {
  return {
    mode: 'raw',
    jpegBase64: 'NORM',
    width: 630,
    height: 880,
    cardLanguage: 'english',
    captureSource: 'camera',
    normalizedImage: { jpegBase64: 'NORM', width: 630, height: 880 },
    sourceImage: { jpegBase64: 'SRC', width: 1260, height: 1760 },
    submittedAt: '2026-05-27T00:00:00.000Z',
  };
}

function artifactBodies(): Array<Record<string, unknown>> {
  const calls = (global.fetch as jest.Mock).mock.calls as Array<[string, RequestInit | undefined]>;
  return calls
    .filter(([url]) => String(url).includes('scan-artifacts'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe('scanner artifact upload — retry + normalized-only payload', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('retries after a failure and drops the source image on the retry (first attempt keeps it)', async () => {
    let artifactAttempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        artifactAttempts += 1;
        // Fail the first attempt so exactly one retry fires, then succeed.
        if (artifactAttempts === 1) {
          return jsonResponse(500, { error: 'boom' });
        }
        return jsonResponse(200, { normalizedObjectPath: 'n', storage: 'gcs', uploadedAt: '2026-05-27T00:00:01.000Z' });
      }
      return jsonResponse(200, { scanID: 'scan-test', candidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');

    const uploadDone = new Promise<{ status: string } | null>((resolve) => {
      void repository.matchScannerCapture(rawPayloadWithSource(), {
        onArtifactUploadComplete: (result) => resolve(result),
      });
    });

    const result = await uploadDone;

    const bodies = artifactBodies();
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    // First attempt carries the full source image...
    expect(bodies[0].sourceImage).toMatchObject({ jpegBase64: 'SRC' });
    expect((bodies[0].normalizedImage as Record<string, unknown>).jpegBase64).toBe('NORM');
    // ...the retry strips it to normalized-only.
    expect(bodies[bodies.length - 1].sourceImage).toBeNull();
    expect((bodies[bodies.length - 1].normalizedImage as Record<string, unknown>).jpegBase64).toBe('NORM');
    expect(result?.status).toBe('uploaded');
  }, 15000);

  it('does not retry when the first upload succeeds (source image preserved)', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('scan-artifacts')) {
        return jsonResponse(200, { normalizedObjectPath: 'n', sourceObjectPath: 's', storage: 'gcs' });
      }
      return jsonResponse(200, { scanID: 'scan-test', candidates: [] });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');

    const uploadDone = new Promise<{ status: string } | null>((resolve) => {
      void repository.matchScannerCapture(rawPayloadWithSource(), {
        onArtifactUploadComplete: (result) => resolve(result),
      });
    });

    const result = await uploadDone;

    const bodies = artifactBodies();
    expect(bodies.length).toBe(1);
    expect(bodies[0].sourceImage).toMatchObject({ jpegBase64: 'SRC' });
    expect(result?.status).toBe('uploaded');
  });
});
