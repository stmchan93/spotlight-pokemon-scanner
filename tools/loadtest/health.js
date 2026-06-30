// Baseline / smoke against the UNAUTHENTICATED health endpoint.
//
// Use this to (a) prove the harness + connectivity work without needing a token,
// and (b) get a baseline for how the server handles concurrency on a cheap read
// (a floor — the real read load is collections.js). Zero side effects: no auth,
// no writes, no Scrydex, no artifacts.
//
//   k6 run --env PROFILE=smoke --env BASE_URL=https://looty.34.59.188.129.sslip.io tools/loadtest/health.js
//   k6 run --env PROFILE=ramp  --env MAX_VUS=20 --env BASE_URL=https://looty.34.59.188.129.sslip.io tools/loadtest/health.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

import { BASE_URL, scenarioFor } from './lib.js';

const PROFILE = __ENV.PROFILE || 'smoke';
const THINK = Number(__ENV.THINK || 1);

const tHealth = new Trend('t_health_ms', true);

export const options = {
  scenarios: { health: scenarioFor(PROFILE) },
  thresholds: {
    t_health_ms: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function health() {
  const res = http.get(`${BASE_URL}/api/v1/health`, { tags: { name: 'health' } });
  tHealth.add(res.timings.duration);
  check(res, {
    'status 200': (r) => r.status === 200,
    'status ok': (r) => {
      try {
        return r.json('status') === 'ok';
      } catch (_e) {
        return false;
      }
    },
  });
  sleep(THINK);
}
