import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
} from '../../../../packages/api-client/src/spotlight/repository';
import {
  mockMetaPulse,
  mockSetSpotlight,
} from '../../../../packages/api-client/src/spotlight/meta-feed-mock-data';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

function mockFetch(...responses: Response[]) {
  const fetchMock = jest.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('HttpSpotlightRepository meta feed reads', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // The flag-off 404 hides the block; it is not an error.
  it('resolves null for every read when the feature is disabled', async () => {
    const disabled = () => jsonResponse(404, { error: 'disabled' });
    mockFetch(disabled(), disabled(), disabled(), disabled());
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.fetchMetaPulse()).resolves.toBeNull();
    await expect(repository.fetchHotCards()).resolves.toBeNull();
    await expect(repository.fetchSetSpotlight()).resolves.toBeNull();
    await expect(repository.fetchNewsFeed()).resolves.toBeNull();
  });

  // Any other failure throws so the hook keeps its last-good payload.
  it('throws on a server error', async () => {
    mockFetch(jsonResponse(500, { error: 'boom' }));
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.fetchHotCards()).rejects.toThrow('meta feed read failed');
  });

  it('builds the contract query strings and routes', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, mockMetaPulse),
      jsonResponse(200, { items: [], nextCursor: null }),
      jsonResponse(200, mockSetSpotlight),
      jsonResponse(200, mockSetSpotlight),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.fetchMetaPulse({ game: 'pokemon', windowDays: 30, lane: 'graded' });
    await repository.fetchNewsFeed({ game: 'onepiece', kind: 'video', limit: 3, cursor: null });
    await repository.fetchSetSpotlight();
    await repository.fetchSetSpotlight({ setId: 'cel25' });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe('http://example.test/api/v1/market/meta?game=pokemon&window=30&lane=graded');
    expect(urls[1]).toBe('http://example.test/api/v1/feed/news?game=onepiece&kind=video&limit=3');
    expect(urls[2]).toBe('http://example.test/api/v1/market/set-spotlight');
    expect(urls[3]).toBe('http://example.test/api/v1/market/sets/cel25/spotlight');
  });

  it('maps a payload defensively: bad numbers, missing lists, unknown enums', async () => {
    mockFetch(
      jsonResponse(200, {
        game: 'not-a-game',
        windowDays: '30',
        lane: 'bogus',
        headline: { title: 'Up', body: 'Body' },
        summary: { gradedValueChangePercent: null, risingCount: '2' },
        groups: [
          {
            groupKey: 'g1',
            label: 'Vintage',
            lane: 'graded',
            description: 'pre-2003',
            medianChangePercent: 'NaN',
            sparkPoints: [1, 'x', 3],
          },
        ],
      }),
      jsonResponse(200, { eligible: false, items: [{ cardId: 'a' }] }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const pulse = await repository.fetchMetaPulse();
    expect(pulse).not.toBeNull();
    expect(pulse?.game).toBe('pokemon');
    expect(pulse?.windowDays).toBe(30);
    expect(pulse?.lane).toBe('all');
    expect(pulse?.ladders).toEqual([]);
    expect(pulse?.summary.gradedValueChangePercent).toBeNull();
    expect(pulse?.summary.risingCount).toBe(2);
    expect(pulse?.groups[0]).toMatchObject({
      lane: 'graded',
      medianChangePercent: 0,
      sparkPoints: [1, 3],
      topCards: [],
    });

    // Ineligible = not enough traffic: always empty, whatever the rows say.
    const hot = await repository.fetchHotCards();
    expect(hot?.eligible).toBe(false);
    expect(hot?.items).toEqual([]);
  });
});

describe('MockSpotlightRepository meta feed reads', () => {
  it('narrows the fixed payloads by query', async () => {
    const repository = new MockSpotlightRepository();

    const graded = await repository.fetchMetaPulse({ lane: 'graded', windowDays: 30 });
    expect(graded?.windowDays).toBe(30);
    expect(graded?.groups.every((group) => group.lane === 'graded')).toBe(true);

    const hot = await repository.fetchHotCards({ game: 'onepiece' });
    expect(hot?.items.map((item) => item.cardId)).toEqual(['op09-119']);

    expect(await repository.fetchSetSpotlight({ setId: 'unknown' })).toBeNull();

    const page = await repository.fetchNewsFeed({ limit: 2 });
    expect(page?.items).toHaveLength(2);
    expect(page?.nextCursor).toBe('2');
    const videos = await repository.fetchNewsFeed({ kind: 'video' });
    expect(videos?.items.every((item) => item.kind === 'video')).toBe(true);
  });
});
