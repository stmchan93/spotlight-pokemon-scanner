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

// Build 9 shipped with artifact uploads dead — 103 scans, zero uploaded, zero
// failed — and it took three days and an unrelated matcher complaint to notice,
// because the skip returned a bare `null`. The screen's completion handler bails
// on a null result before capturing anything, so an upload that never ran was
// indistinguishable from one that was never wanted.
describe('scanner artifact upload — a skipped upload is reported, not silent', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function payloadWithoutNormalizedImage(): ScannerCapturePayload {
    const payload = rawPayloadWithSource();
    // Exactly the build-9 shape: the match still has an image to send, but the
    // artifact payload builder has nothing training-critical to upload.
    return { ...payload, normalizedImage: null };
  }

  it('reports a missing normalized image as a failure with a reason, and posts nothing', async () => {
    global.fetch = jest.fn().mockImplementation(async () =>
      jsonResponse(200, { scanID: 'scan-test', candidates: [] }),
    ) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const uploadDone = new Promise<{ status: string; errorKind?: string | null } | null>((resolve) => {
      void repository.matchScannerCapture(payloadWithoutNormalizedImage(), {
        onArtifactUploadComplete: (result) => resolve(result),
      });
    });

    const result = await uploadDone;

    // The screen turns this into `scan_artifact_upload_failed` with
    // `error_kind` — an EXISTING event, so no new taxonomy and no volume on a
    // healthy build, where this never fires.
    expect(result?.status).toBe('failed');
    expect(result?.errorKind).toBe('normalized_image_missing');
    // Nothing was posted: there was no artifact to post.
    expect(artifactBodies()).toHaveLength(0);
  }, 15000);

  it('stays silent for a smoke fixture, which legitimately has no artifact', async () => {
    global.fetch = jest.fn().mockImplementation(async () =>
      jsonResponse(200, { scanID: 'scan-test', candidates: [] }),
    ) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const settled = new Promise<{ status: string } | null>((resolve) => {
      void repository.matchScannerCapture(
        { ...rawPayloadWithSource(), captureSource: 'smoke_fixture' },
        { onArtifactUploadComplete: (result) => resolve(result) },
      );
    });

    // A fixture never had a real capture, so reporting it would be noise —
    // exactly the event bloat this reuse is avoiding.
    expect(await settled).toBeNull();
  }, 15000);
});
