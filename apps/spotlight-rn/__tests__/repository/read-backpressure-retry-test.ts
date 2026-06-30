import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

// Coverage for the read-backpressure client retry: when the backend sheds a heavy
// read under load it returns a fast retryable 503 ("ServerBusy"). The heavy GET
// reads (deck entries / portfolio history / ledger) must retry that silently with
// backoff so a traffic spike is invisible to the user — but a non-503 error must
// pass straight through (no masking real failures), and the retry must be bounded.

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

describe('heavy-read backpressure 503 — silent client retry', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('retries a deck/entries read after a 503 ServerBusy, then succeeds', async () => {
    let attempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/deck/entries')) {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(503, { error: 'busy', errorType: 'ServerBusy', retryable: true });
        }
        return jsonResponse(200, { entries: [] });
      }
      return jsonResponse(200, {});
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.loadInventoryEntries();

    expect(attempts).toBe(2); // sheds once, retried, landed
    expect(result.state).not.toBe('error');
  }, 15000);

  it('gives up after a bounded number of retries when the 503 persists', async () => {
    let attempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/deck/entries')) {
        attempts += 1;
        return jsonResponse(503, { error: 'busy' });
      }
      return jsonResponse(200, {});
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.loadInventoryEntries();

    expect(attempts).toBe(4); // 1 initial + 3 retries, then surfaces the error (no infinite loop)
    expect(result.state).toBe('error');
  }, 15000);

  it('does NOT retry a non-503 error (real failures pass straight through)', async () => {
    let attempts = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/deck/entries')) {
        attempts += 1;
        return jsonResponse(500, { error: 'boom' });
      }
      return jsonResponse(200, {});
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.loadInventoryEntries();

    expect(attempts).toBe(1);
  });
});
