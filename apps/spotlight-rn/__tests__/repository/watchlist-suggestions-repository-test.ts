import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
} from '../../../../packages/api-client/src/spotlight/repository';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

describe('getWatchlistSuggestions', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('hits the suggestions route and parses items, dropping rows without a card id', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse(200, {
      items: [
        { cardId: 'base1-4', name: 'Charizard', number: '4/102', setName: 'Base Set', language: 'English',
          imageUrl: 'https://img/c.png', game: 'pokemon', priceNow: 412.5, currencyCode: 'USD',
          lastScannedAt: '2026-09-23T00:00:00+00:00' },
        { cardId: 'op01-1', name: 'Luffy', game: 'not-a-game', priceNow: 'x' },
        { name: 'no id' },
      ],
      limit: 4,
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const items = await repository.getWatchlistSuggestions(4);

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://example.test/api/v1/watchlist/suggestions?limit=4');
    expect(items).toEqual([
      {
        cardId: 'base1-4', name: 'Charizard', cardNumber: '4/102', setName: 'Base Set',
        imageUrl: 'https://img/c.png', game: 'pokemon', language: 'English', marketPrice: 412.5,
        currencyCode: 'USD', lastScannedAt: '2026-09-23T00:00:00+00:00',
      },
      expect.objectContaining({ cardId: 'op01-1', game: undefined, marketPrice: null, setName: '' }),
    ]);
  });

  it('throws on a failed read so the screen can tell "none" from "error"', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getWatchlistSuggestions()).rejects.toBeTruthy();
  });

  it('mock repository skips watched and sealed cards and clamps the limit', async () => {
    const repository = new MockSpotlightRepository();
    const first = await repository.getWatchlistSuggestions(2);
    expect(first).toHaveLength(2);

    await repository.setCardFavorite(first[0].cardId, true);
    const after = await repository.getWatchlistSuggestions(50);
    expect(after.length).toBeLessThanOrEqual(12);
    expect(after.map((item) => item.cardId)).not.toContain(first[0].cardId);
  });
});
