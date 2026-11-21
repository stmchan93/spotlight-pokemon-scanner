import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

/*
  The request timeout must cover the BODY, not just the headers. It used to be
  cleared the moment headers arrived, so a response whose body stalled
  mid-download hung forever — "Loading sets…" and "Loading your collection"
  spinners that never ended.
*/

type StalledFetch = {
  fetch: jest.Mock;
  signals: AbortSignal[];
};

// Headers arrive at once; the body never does (and ignores abort, like some fetch impls).
function stalledBodyFetch(): StalledFetch {
  const signals: AbortSignal[] = [];
  const fetchMock = jest.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.signal) {
      signals.push(init.signal);
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => new Promise<string>(() => undefined),
    } as unknown as Response;
  });
  return { fetch: fetchMock, signals };
}

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

describe('request timeout covers the response body', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('rejects a stalled body with the timeout error at the default 12 s, and aborts the request', async () => {
    const stalled = stalledBodyFetch();
    global.fetch = stalled.fetch as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    let settled: unknown = 'pending';
    const pending = repository.listExpansions('pokemon').then(
      (value) => { settled = value; },
      (error: unknown) => { settled = error; },
    );

    await jest.advanceTimersByTimeAsync(11_999);
    expect(settled).toBe('pending');

    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).message).toBe('Request timed out while contacting the Spotlight backend.');
    expect((settled as { failure?: string }).failure).toBe('timeout');
    expect(stalled.signals).toHaveLength(1);
    expect(stalled.signals[0].aborted).toBe(true);
  });

  it('keeps a per-endpoint timeout: the watchlist read waits its own 30 s for a stalled body', async () => {
    const stalled = stalledBodyFetch();
    global.fetch = stalled.fetch as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    let settled: unknown = 'pending';
    const pending = repository.getCardFavorites().then(
      (value) => { settled = value; },
      (error: unknown) => { settled = error; },
    );

    // Not stricter than before: still pending past the 12 s default.
    await jest.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe('pending');

    await jest.advanceTimersByTimeAsync(1);
    // 503-only backoff does not apply to a timeout, so it settles right away.
    await pending;
    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).message).toBe('Request timed out while contacting the Spotlight backend.');
  });

  it('times out a stalled body on the text transport (CSV export)', async () => {
    const stalled = stalledBodyFetch();
    global.fetch = stalled.fetch as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const pending = repository.exportDeckEntriesCsv().then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(12_000);
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('Request timed out while contacting the Spotlight backend.');
  });

  it('times out a stalled body on the assistant transport', async () => {
    const stalled = stalledBodyFetch();
    global.fetch = stalled.fetch as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const pending = repository.getAssistantUsage().then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(12_000);
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('Request timed out while contacting the Spotlight backend.');
  });

  it('a body that arrives in time still parses, and leaves no timer behind', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { expansions: [{ id: 'sv1', name: 'Scarlet & Violet', series: null, code: null, releaseDate: null, imageUrl: '' }] }),
    ) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const expansions = await repository.listExpansions('pokemon');
    expect(expansions.map((expansion) => expansion.id)).toEqual(['sv1']);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('listExpansions / listCardsInExpansion surface failures', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('listExpansions rejects on a server error instead of returning []', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.listExpansions('pokemon')).rejects.toThrow('boom');
  });

  it('listExpansions rejects when the backend is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.listExpansions('pokemon')).rejects.toThrow('offline');
  });

  it('listCardsInExpansion rejects on a server error instead of an empty set', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => (
      String(url).includes('/expansions/')
        ? jsonResponse(500, { error: 'cards down' })
        : jsonResponse(200, { entries: [] })
    )) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.listCardsInExpansion('sv1')).rejects.toThrow('cards down');
  });
});
