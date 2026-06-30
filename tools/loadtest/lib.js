// Shared helpers for the Ekalight backend k6 load tests.
//
// Config comes from `--env KEY=value` flags (k6 reads them as __ENV.KEY):
//   BASE_URL  base of the backend, e.g. http://34.59.188.129:8788 (default local)
//   TOKEN     a Supabase JWT (the value after "Bearer "). Required when the
//             target has SPOTLIGHT_AUTH_REQUIRED=true (staging/prod). For a local
//             instance with auth off you can omit it (server falls back to a
//             dev user).

export const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');
export const TOKEN = (__ENV.TOKEN || '').replace(/^Bearer\s+/i, '').trim();

export function authHeaders(extra) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }
  return headers;
}

// Build a ramping-VUs stage ladder. One VU ≈ one concurrent user (scanner /
// browser) that loops with a think-time pause, so `target` reads directly as
// "concurrent users". Holds at each step are long enough for percentiles to
// settle before the next ramp, so you can read the latency knee per step.
export function rampStages(maxVus, stepSecs, holdSecs) {
  const max = Number(maxVus) || 40;
  const step = Number(stepSecs) || 20;
  const hold = Number(holdSecs) || 45;
  const ladder = [5, 10, 20, 30, 40, 60, 80].filter((n) => n < max).concat([max]);
  const stages = [];
  for (const target of ladder) {
    stages.push({ duration: `${step}s`, target });
    stages.push({ duration: `${hold}s`, target });
  }
  stages.push({ duration: '15s', target: 0 });
  return stages;
}

// Pick the executor config for a PROFILE:
//   smoke — a few VUs for a short burst, just to prove the harness + auth + the
//           request shape work end-to-end. ALWAYS run this first.
//   ramp  — the capacity curve (ramping VUs up to MAX_VUS).
export function scenarioFor(profile, opts) {
  const o = opts || {};
  if (profile === 'smoke') {
    return {
      executor: 'constant-vus',
      vus: Number(__ENV.SMOKE_VUS || 2),
      duration: __ENV.SMOKE_DURATION || '30s',
    };
  }
  return {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: rampStages(__ENV.MAX_VUS, __ENV.STEP_SECS, __ENV.HOLD_SECS),
    gracefulRampDown: '10s',
  };
}
