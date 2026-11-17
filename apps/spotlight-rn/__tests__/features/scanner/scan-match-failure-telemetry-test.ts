import { SpotlightRepositoryRequestError } from '@spotlight/api-client';

import {
  buildScanMatchFailureProperties,
  scanRequestFailureDetails,
} from '@/features/scanner/screens/scanner-screen-helpers';

// scan_match_failed must tell a weak-signal timeout, a dropped connection and a
// server status apart (Hawaii show 2026-10-24 was all `request_failed`).
describe('scan_match_failed transport properties', () => {
  it('carries failure_type, http_status and request_attempt_count', () => {
    const error = new SpotlightRepositoryRequestError('busy', 'request_failed', 503);
    error.failure = 'http';
    error.attemptCount = 3;

    const properties = buildScanMatchFailureProperties({
      ...scanRequestFailureDetails(error),
      errorKind: 'request_failed',
      mode: 'raw',
      endToEndMs: 42000,
    });

    expect(properties).toMatchObject({
      error_kind: 'request_failed',
      failure_type: 'http',
      http_status: 503,
      request_attempt_count: 3,
      end_to_end_ms: 42000,
    });
  });

  it('reports a timeout without an http_status', () => {
    const error = new SpotlightRepositoryRequestError('timed out', 'request_failed');
    error.failure = 'timeout';
    error.attemptCount = 3;

    const properties = buildScanMatchFailureProperties({
      ...scanRequestFailureDetails(error),
      errorKind: 'request_failed',
      mode: 'raw',
    });

    expect(properties.failure_type).toBe('timeout');
    expect(properties).not.toHaveProperty('http_status');
  });

  it('omits transport fields for non-request errors', () => {
    const properties = buildScanMatchFailureProperties({
      ...scanRequestFailureDetails(new Error('guest_session_unavailable')),
      errorKind: 'guest_session_unavailable',
      mode: 'raw',
    });
    expect(properties).not.toHaveProperty('failure_type');
    expect(properties).not.toHaveProperty('request_attempt_count');
  });
});
