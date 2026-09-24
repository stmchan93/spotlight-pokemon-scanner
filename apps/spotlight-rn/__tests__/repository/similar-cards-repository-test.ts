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

describe('fetchSimilarCards', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('resolves null when the feature is disabled (404)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(404, { error: 'disabled' })) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.fetchSimilarCards('ex8-106')).resolves.toBeNull();
  });

  it('hits the card route and parses rows, dropping malformed tiles', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse(200, {
      cardId: 'ex8-106',
      baseName: 'Latios',
      goesWith: { cardId: 'ex8-105', name: 'Latias ☆', setName: 'Deoxys', number: '105/107',
        language: 'English', imageUrl: 'https://img/a.png', priceNow: 1700, currencyCode: 'USD' },
      sameName: [{ cardId: 'pcg2_ja-66', name: 'Latios ☆', priceNow: null }, { name: 'no id' }],
      sameLookCheaper: 'garbage',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const payload = await repository.fetchSimilarCards('ex8 106');

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://example.test/api/v1/cards/ex8%20106/similar');
    expect(payload?.goesWith?.cardId).toBe('ex8-105');
    expect(payload?.sameName).toEqual([expect.objectContaining({
      cardId: 'pcg2_ja-66', priceNow: null, setName: null, currencyCode: 'USD',
    })]);
    expect(payload?.sameLookCheaper).toEqual([]);
  });

  it('mock repository returns same-name rows for a known card and empty rows otherwise', async () => {
    const repository = new MockSpotlightRepository();

    const known = await repository.fetchSimilarCards('sm7-1');
    expect(known?.sameName.length).toBeGreaterThan(0);
    expect(known?.sameName.every((card) => card.name === 'Treecko' && card.cardId !== 'sm7-1')).toBe(true);

    await expect(repository.fetchSimilarCards('nope')).resolves.toEqual({
      cardId: 'nope', baseName: null, goesWith: null, sameName: [], sameLookCheaper: [],
    });
  });
});
