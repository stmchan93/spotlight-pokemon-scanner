// Mixed-population load test — "what if N users are on the app right now?"
//
// A real population of N concurrent users is NOT N concurrent scanners. At any
// moment most people are browsing (Collection list, dashboard, card detail)
// and a minority are mid-scan. This script models that directly so a run maps
// 1:1 to a product question ("can we survive 300 users?"):
//
//   USERS          total concurrent app users (default 100)
//   SCANNER_SHARE  fraction actively scanning at any moment (default 0.10)
//
// It launches two k6 scenarios side-by-side against the same backend:
//   browsers  = USERS * (1 - SCANNER_SHARE) VUs looping collection/dashboard/
//               card-detail reads with BROWSE_THINK pause (default 8s — people
//               read what they load)
//   scanners  = USERS * SCANNER_SHARE VUs looping POST /api/v1/scan/match with
//               SCAN_THINK pause (default 5s — aim, shutter, review)
//
// Run (after smoke-testing scanner.js + collections.js individually):
//   k6 run --env USERS=300 --env BASE_URL=$BASE --env TOKEN=$TOK \
//     --env IMAGE_LIST=tools/loadtest/corpus/card1.jpg,... tools/loadtest/mixed.js
//
// SAFETY: same rules as the other scripts — DB reads + scan/match only, no
// Scrydex-credit endpoints, verify scanArtifactUploads.enabled=false first.

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { b64encode } from 'k6/encoding';
import exec from 'k6/execution';

import { BASE_URL, authHeaders } from './lib.js';

const USERS = Number(__ENV.USERS || 100);
const SCANNER_SHARE = Number(__ENV.SCANNER_SHARE || 0.1);
const DURATION = __ENV.DURATION || '180s';
const BROWSE_THINK = Number(__ENV.BROWSE_THINK || 8);
const SCAN_THINK = Number(__ENV.SCAN_THINK || 5);
const TZ = __ENV.TZ || 'America/Los_Angeles';
const MODE = __ENV.MODE || 'raw_card';
const LANG = __ENV.LANG || 'english';
const IMG_W = Number(__ENV.IMG_W || 1000);
const IMG_H = Number(__ENV.IMG_H || 1400);

const scannerVus = Math.max(1, Math.round(USERS * SCANNER_SHARE));
const browserVus = Math.max(1, USERS - scannerVus);

// --- corpus ------------------------------------------------------------------
const imagePaths = (__ENV.IMAGE_LIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (imagePaths.length === 0) {
  throw new Error('IMAGE_LIST is required (comma-separated JPEG paths, repo-root relative).');
}
const corpus = imagePaths.map((p) => b64encode(open(p, 'b')));

// --- metrics -------------------------------------------------------------------
const tEntries = new Trend('t_deck_entries_ms', true);
const tDashboard = new Trend('t_portfolio_dashboard_ms', true);
const tCardDetail = new Trend('t_card_detail_ms', true);
const scanLatency = new Trend('scan_latency_ms', true);
const scanOk = new Rate('scan_ok');
const scannerBusy = new Rate('scanner_busy_503');
const scanError = new Rate('scan_error');

export const options = {
  scenarios: {
    browsers: {
      executor: 'constant-vus',
      exec: 'browse',
      vus: browserVus,
      duration: DURATION,
    },
    scanners: {
      executor: 'constant-vus',
      exec: 'scan',
      vus: scannerVus,
      duration: DURATION,
    },
  },
  thresholds: {
    t_deck_entries_ms: ['p(95)<2000'],
    t_portfolio_dashboard_ms: ['p(95)<5000'],
    t_card_detail_ms: ['p(95)<2000'],
    scan_latency_ms: ['p(95)<3000', 'p(99)<6000'],
    scan_error: ['rate<0.01'],
    http_req_failed: ['rate<0.05'],
  },
};

export function setup() {
  console.log(`mixed: ${USERS} users → ${browserVus} browsers + ${scannerVus} scanners for ${DURATION}`);
  const ids = new Set(
    (__ENV.CARD_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const res = http.get(`${BASE_URL}/api/v1/deck/entries?limit=50`, { headers: authHeaders() });
  if (res.status === 200) {
    let entries = [];
    try {
      entries = res.json('entries') || [];
    } catch (_e) {
      entries = [];
    }
    for (const e of entries) {
      const id = e && (e.cardId || e.cardID || e.card_id || (e.card && e.card.id));
      if (id) ids.add(String(id));
      if (ids.size >= 10) break;
    }
  }
  return { cardIds: Array.from(ids) };
}

// A browsing user: each loop does ONE thing (like a real person navigating),
// weighted toward the cheap list read, then pauses.
export function browse(data) {
  const roll = Math.random();
  if (roll < 0.4) {
    group('collection list', () => {
      const res = http.get(`${BASE_URL}/api/v1/deck/entries?limit=200`, {
        headers: authHeaders(),
        tags: { name: 'deck_entries' },
      });
      tEntries.add(res.timings.duration);
      check(res, { 'entries 200': (r) => r.status === 200 });
    });
  } else if (roll < 0.7) {
    group('portfolio dashboard', () => {
      const res = http.get(
        `${BASE_URL}/api/v1/portfolio/dashboard?range=1M&timeZone=${encodeURIComponent(TZ)}`,
        { headers: authHeaders(), tags: { name: 'portfolio_dashboard' } },
      );
      tDashboard.add(res.timings.duration);
      check(res, { 'dashboard 200': (r) => r.status === 200 });
    });
  } else if (data.cardIds && data.cardIds.length > 0) {
    group('card detail', () => {
      const id = data.cardIds[Math.floor(Math.random() * data.cardIds.length)];
      const res = http.get(`${BASE_URL}/api/v1/cards/${encodeURIComponent(id)}`, {
        headers: authHeaders(),
        tags: { name: 'card_detail' },
      });
      tCardDetail.add(res.timings.duration);
      check(res, { 'card detail 200': (r) => r.status === 200 });
    });
  }
  sleep(BROWSE_THINK * (0.5 + Math.random())); // jitter so VUs desynchronize
}

// A scanning user: POST scan/match, then pause (aim/review time).
export function scan() {
  const jpegBase64 = corpus[Math.floor(Math.random() * corpus.length)];
  const scanID = `lt-mixed-${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
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

  const res = http.post(`${BASE_URL}/api/v1/scan/match`, body, {
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
  check(res, { 'scan 200': (r) => r.status === 200 });

  sleep(SCAN_THINK * (0.5 + Math.random()));
}
