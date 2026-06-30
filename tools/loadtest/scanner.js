// Scanner load test — the one that actually decides your production readiness.
//
// Replays a real POST /api/v1/scan/match (or visual-match) against the backend.
// The match path runs the CPU-bound visual encoder, which is guarded by a
// semaphore (SPOTLIGHT_MAX_CONCURRENT_SCAN_INFERENCES, default = vCPUs-1) with a
// 6s acquire timeout. Past capacity the server returns HTTP 503
// "ScannerBusy" — that 503 rate + the latency knee ARE your capacity signal, so
// we track them as first-class metrics rather than treating 503 as a hard error.
//
// One VU ≈ one person scanning, looping with a think-time pause (THINK). Ramp the
// VUs and watch where p95 hockey-sticks / 503s appear. That concurrency is your
// max safe simultaneous scanners — compare it to your real peak (e.g. a card
// show with N people).
//
// Run (smoke first, then ramp):
//   k6 run --env PROFILE=smoke \
//     --env BASE_URL=http://<vm-ip>:8788 --env TOKEN=<jwt> \
//     --env IMAGE_LIST=corpus/card1.jpg,corpus/card2.jpg tools/loadtest/scanner.js
//
//   k6 run --env PROFILE=ramp --env MAX_VUS=40 \
//     --env BASE_URL=http://<vm-ip>:8788 --env TOKEN=<jwt> \
//     --env IMAGE_LIST=corpus/card1.jpg,corpus/card2.jpg tools/loadtest/scanner.js
//
// SAFETY: hits only scan/match — no Scrydex credits, and scan-artifact uploads
// are OFF by default on the backend (SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED).
// Verify artifacts are disabled on the target first (GET /api/v1/health →
// scanArtifactUploads.enabled === false) so the test doesn't write images.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { b64encode } from 'k6/encoding';
import exec from 'k6/execution';

import { BASE_URL, authHeaders, scenarioFor } from './lib.js';

const PROFILE = __ENV.PROFILE || 'smoke';
const ENDPOINT = __ENV.ENDPOINT || '/api/v1/scan/match'; // or /api/v1/scan/visual-match
const THINK = Number(__ENV.THINK || 4); // seconds between a VU's scans
const MODE = __ENV.MODE || 'raw_card'; // resolverModeHint: raw_card | psa_slab
const LANG = __ENV.LANG || 'english';
const IMG_W = Number(__ENV.IMG_W || 1000);
const IMG_H = Number(__ENV.IMG_H || 1400);
// When 1, each iteration also POSTs the image to /api/v1/scan-artifacts (the GCS
// upload path the app calls per scan). Pair this with the backend's artifact
// setting to measure the cost of artifact storage: backend ON → real GCS writes;
// backend OFF → the call short-circuits (skipped), so the delta = storage cost.
const ARTIFACTS = (__ENV.ARTIFACTS || '0') === '1';

// --- corpus (init context) -------------------------------------------------
// Supply your OWN card photos via IMAGE_LIST (comma-separated paths, relative to
// the repo root where you run k6). Do NOT commit them — scan captures are private.
const imagePaths = (__ENV.IMAGE_LIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (imagePaths.length === 0) {
  throw new Error(
    'IMAGE_LIST is required. Put a few real card JPEGs in tools/loadtest/corpus/ ' +
      'and pass --env IMAGE_LIST=corpus/a.jpg,corpus/b.jpg',
  );
}

// Base64-encode each image once at startup (open() is init-context only).
const corpus = imagePaths.map((p) => b64encode(open(p, 'b')));

// --- metrics ---------------------------------------------------------------
const scanLatency = new Trend('scan_latency_ms', true);
const scanOk = new Rate('scan_ok'); // got a 200 with a topCandidates array
const scannerBusy = new Rate('scanner_busy_503'); // backpressure (capacity hit)
const scanError = new Rate('scan_error'); // anything else (real failures)
const artifactLatency = new Trend('artifact_latency_ms', true); // GCS upload call
const artifactUploaded = new Rate('artifact_uploaded'); // true = actually stored
const artifactHttp2xx = new Rate('artifact_http_2xx'); // client saw a 2xx (upload accepted)

export const options = {
  scenarios: { scanner: scenarioFor(PROFILE) },
  thresholds: {
    // Informational targets — breaches mark the run "failed" at the end but do
    // NOT abort, so you still get the full capacity curve. Tune to your SLOs.
    scan_latency_ms: ['p(95)<3000', 'p(99)<6000'],
    scan_ok: ['rate>0.99'],
    scan_error: ['rate<0.01'],
  },
};

export default function scanner() {
  const jpegBase64 = corpus[Math.floor(Math.random() * corpus.length)];
  const scanID = `lt-${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
  const body = JSON.stringify({
    scanID,
    capturedAt: new Date().toISOString(),
    resolverModeHint: MODE,
    cardLanguage: LANG,
    image: { jpegBase64, width: IMG_W, height: IMG_H },
    ocrAnalysis: {
      pipelineVersion: 'loadtest',
      selectedMode: LANG === 'japanese' ? 'raw_japanese' : 'raw_english',
      rawEvidence: {},
    },
  });

  const res = http.post(`${BASE_URL}${ENDPOINT}`, body, {
    headers: authHeaders(),
    timeout: '30s',
    tags: { name: 'scan' },
  });

  scanLatency.add(res.timings.duration);

  const busy = res.status === 503;
  scannerBusy.add(busy);

  let ok = false;
  if (res.status === 200) {
    try {
      ok = Array.isArray(res.json('topCandidates'));
    } catch (_e) {
      ok = false;
    }
  }
  scanOk.add(ok);
  scanError.add(!ok && !busy);

  check(res, {
    'status 200': (r) => r.status === 200,
    'has topCandidates': () => ok,
    'not throttled (503)': () => !busy,
  });

  // Optionally exercise the per-scan artifact upload (the GCS-write path).
  if (ARTIFACTS) {
    const aBody = JSON.stringify({
      scanID,
      normalizedImage: { jpegBase64, width: IMG_W, height: IMG_H },
      sourceImage: { jpegBase64, width: IMG_W, height: IMG_H },
    });
    const ares = http.post(`${BASE_URL}/api/v1/scan-artifacts`, aBody, {
      headers: authHeaders(),
      timeout: '30s',
      tags: { name: 'artifacts' },
    });
    artifactLatency.add(ares.timings.duration);
    // The artifact upload returns 202 Accepted (not 200) on success — accept any 2xx.
    const artifact2xx = ares.status >= 200 && ares.status < 300;
    artifactHttp2xx.add(artifact2xx);
    let uploaded = false;
    if (artifact2xx) {
      try {
        const st = ares.json().uploadStatus;
        uploaded = st === 'uploaded' || st === 'normalized_only';
      } catch (_e) {
        uploaded = false;
      }
    }
    artifactUploaded.add(uploaded);
  }

  sleep(THINK);
}
