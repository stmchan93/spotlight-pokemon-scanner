// Collections / general-browse load test.
//
// Models a user opening the app and browsing: the Collection list, the portfolio
// dashboard + history, and a few card detail pages. These are pure DB reads — NO
// Scrydex credits — but the dashboard/history paths can be disk-I/O bound on a
// cold cache (you've seen 20s+ cold dashboard refreshes), so this surfaces the
// worst case under concurrency.
//
// One VU ≈ one person browsing, looping with a think-time pause.
//
// Run (smoke first, then ramp):
//   k6 run --env PROFILE=smoke \
//     --env BASE_URL=http://<vm-ip>:8788 --env TOKEN=<jwt> tools/loadtest/collections.js
//
//   k6 run --env PROFILE=ramp --env MAX_VUS=60 \
//     --env BASE_URL=http://<vm-ip>:8788 --env TOKEN=<jwt> tools/loadtest/collections.js
//
// SAFETY: only hits DB-backed read endpoints. It deliberately does NOT call
// recent-sales?refresh=true or refresh-pricing — those would burn Scrydex
// credits. Card-detail pricing is served from the cached snapshot (no credits).

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';

import { BASE_URL, authHeaders, scenarioFor } from './lib.js';

const PROFILE = __ENV.PROFILE || 'smoke';
const THINK = Number(__ENV.THINK || 3);
const TZ = __ENV.TZ || 'America/Los_Angeles';

const tEntries = new Trend('t_deck_entries_ms', true);
const tDashboard = new Trend('t_portfolio_dashboard_ms', true);
const tHistory = new Trend('t_portfolio_history_ms', true);
const tCardDetail = new Trend('t_card_detail_ms', true);

export const options = {
  scenarios: { browse: scenarioFor(PROFILE) },
  thresholds: {
    t_deck_entries_ms: ['p(95)<2000'],
    t_portfolio_dashboard_ms: ['p(95)<5000'], // cold-cache disk I/O lives here
    t_card_detail_ms: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

// Discover a few real card IDs once so card-detail hits real rows. Falls back to
// the CARD_IDS env (comma-separated) if the deck is empty.
export function setup() {
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
  } else {
    console.warn(`setup: deck/entries returned ${res.status} (auth/token ok?)`);
  }
  const list = Array.from(ids);
  console.log(`setup: ${list.length} card id(s) for card-detail hits`);
  return { cardIds: list };
}

export default function browse(data) {
  group('collection list', () => {
    const res = http.get(`${BASE_URL}/api/v1/deck/entries?limit=200`, {
      headers: authHeaders(),
      tags: { name: 'deck_entries' },
    });
    tEntries.add(res.timings.duration);
    check(res, { 'entries 200': (r) => r.status === 200 });
  });

  group('portfolio dashboard', () => {
    const res = http.get(`${BASE_URL}/api/v1/portfolio/dashboard?range=1M&timeZone=${encodeURIComponent(TZ)}`, {
      headers: authHeaders(),
      tags: { name: 'portfolio_dashboard' },
    });
    tDashboard.add(res.timings.duration);
    check(res, { 'dashboard 200': (r) => r.status === 200 });
  });

  group('portfolio history', () => {
    const res = http.get(`${BASE_URL}/api/v1/portfolio/history?days=30&timeZone=${encodeURIComponent(TZ)}`, {
      headers: authHeaders(),
      tags: { name: 'portfolio_history' },
    });
    tHistory.add(res.timings.duration);
    check(res, { 'history 200': (r) => r.status === 200 });
  });

  if (data.cardIds && data.cardIds.length > 0) {
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

  sleep(THINK);
}
