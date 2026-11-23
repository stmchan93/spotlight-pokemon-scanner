import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
} from '../../../../packages/api-client/src/spotlight/repository';
import {
  mockCardPricePosition,
  mockMarketAnalytics,
  mockMarketHeatmapSet,
} from '../../../../packages/api-client/src/spotlight/market-analytics-mock-data';

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

describe('HttpSpotlightRepository market analytics reads', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('builds the contract routes and query strings', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, mockMarketAnalytics),
      jsonResponse(200, mockMarketHeatmapSet),
      jsonResponse(200, mockCardPricePosition),
      jsonResponse(200, mockCardPricePosition),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.getMarketAnalytics({ game: 'onepiece', window: '7d' });
    await repository.getMarketHeatmapSet({ game: 'pokemon', setId: 'sv3pt5', window: '90d' });
    await repository.getCardPricePosition({ cardId: 'sv3pt5-199' });
    await repository.getCardPricePosition({
      cardId: 'base1/4', variant: 'Holofoil', condition: null, grader: 'PSA', grade: '10',
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'http://example.test/api/v1/market/analytics?game=onepiece&window=7d',
      'http://example.test/api/v1/market/heatmap/set?game=pokemon&setId=sv3pt5&window=90d',
      'http://example.test/api/v1/cards/sv3pt5-199/price-position',
      'http://example.test/api/v1/cards/base1%2F4/price-position?variant=Holofoil&grader=PSA&grade=10',
    ]);
  });

  it('round-trips the mock payloads unchanged', async () => {
    mockFetch(
      jsonResponse(200, mockMarketAnalytics),
      jsonResponse(200, mockMarketHeatmapSet),
      jsonResponse(200, mockCardPricePosition),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getMarketAnalytics({ game: 'pokemon', window: '30d' })).resolves.toEqual(mockMarketAnalytics);
    await expect(
      repository.getMarketHeatmapSet({ game: 'pokemon', setId: 'sv3pt5', window: '30d' }),
    ).resolves.toEqual(mockMarketHeatmapSet);
    await expect(repository.getCardPricePosition({ cardId: 'sv3pt5-199' })).resolves.toEqual(mockCardPricePosition);
  });

  it('maps thin or malformed payloads defensively', async () => {
    mockFetch(jsonResponse(200, {
      game: 'lorcana',
      window: 'bogus',
      pulse: { changePct: 'NaN', breadth: {} },
      you: null,
      heatmap: [{ setId: 'x', totalValueUsd: '12.5', changePct: null, cardCount: 3 }, { name: 'no id' }],
      bargains: [{ cardId: 'a', priceUsd: 10 }],
      breakingOut: 'nope',
      grading: [{ cardId: 'g', rawUsd: 5, psa10Usd: 60, feeUsd: 30, netGainUsd: 25, owned: 'yes' }],
    }));
    const repository = new HttpSpotlightRepository('http://example.test');

    const payload = await repository.getMarketAnalytics({ game: 'lorcana', window: '90d' });
    expect(payload.game).toBe('lorcana');
    expect(payload.window).toBe('90d');
    expect(payload.windowLabel).toBe('recently');
    expect(payload.pulse).toEqual({
      changePct: null,
      indexValueUsd: null,
      breadth: { up: 0, down: 0, flat: 0, upPct: null },
      sparkline: [],
      index: null,
    });
    expect(payload.you).toBeNull();
    expect(payload.heatmap).toEqual([
      { setId: 'x', name: 'x', logoUrl: null, game: 'lorcana', totalValueUsd: 12.5, changePct: null, cardCount: 3 },
    ]);
    // A bargain without its range is not a bargain.
    expect(payload.bargains).toEqual([]);
    expect(payload.breakingOut).toEqual([]);
    expect(payload.setsRising).toEqual([]);
    expect(payload.grading[0].owned).toBe(false);
  });

  it('maps the market index and the 1y window; a broken index reads null', async () => {
    mockFetch(
      jsonResponse(200, {
        game: 'pokemon',
        window: '1y',
        pulse: {
          breadth: {},
          index: {
            name: 'Pokémon Market Index',
            points: [{ date: '2025-11-22', value: '108.1' }, { date: 'bad' }, { date: '2026-11-22', value: 218.6 }],
            value: 218.6,
            changePct: 102.3,
            rangeLow: 103.9,
            rangeHigh: 218.6,
            basketSize: 100,
            rebalancedOn: '2026-11-01',
          },
        },
      }),
      jsonResponse(200, { game: 'pokemon', window: '1y', pulse: { index: { value: 'x', points: [] } } }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const payload = await repository.getMarketAnalytics({ game: 'pokemon', window: '1y' });
    expect(payload.window).toBe('1y');
    expect(payload.pulse.index).toEqual({
      name: 'Pokémon Market Index',
      points: [{ date: '2025-11-22', value: 108.1 }, { date: '2026-11-22', value: 218.6 }],
      value: 218.6,
      changePct: 102.3,
      rangeLow: 103.9,
      rangeHigh: 218.6,
      basketSize: 100,
      rebalancedOn: '2026-11-01',
    });
    const broken = await repository.getMarketAnalytics({ game: 'pokemon', window: '1y' });
    expect(broken.pulse.index).toBeNull();
  });

  it('resolves null for 204 / 404 and throws on other failures', async () => {
    mockFetch(
      jsonResponse(204),
      jsonResponse(404, { error: 'Card not found' }),
      jsonResponse(404, { error: 'not_found' }),
      jsonResponse(500, { error: 'boom' }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getCardPricePosition({ cardId: 'thin' })).resolves.toBeNull();
    await expect(repository.getCardPricePosition({ cardId: 'unknown' })).resolves.toBeNull();
    await expect(
      repository.getMarketHeatmapSet({ game: 'pokemon', setId: 'nope', window: '30d' }),
    ).resolves.toBeNull();
    await expect(repository.getMarketAnalytics({ game: 'pokemon', window: '30d' })).rejects.toThrow(
      'market analytics read failed',
    );
  });
});

describe('MockSpotlightRepository market analytics', () => {
  it('serves the Pokémon payload per window and the thin shape for other games', async () => {
    const repository = new MockSpotlightRepository();

    const week = await repository.getMarketAnalytics({ game: 'pokemon', window: '7d' });
    expect(week.window).toBe('7d');
    expect(week.windowLabel).toBe('past week');
    expect(week.heatmap.length).toBeGreaterThan(0);

    const thin = await repository.getMarketAnalytics({ game: 'gundam', window: '30d' });
    expect(thin.game).toBe('gundam');
    expect(thin.heatmap).toEqual([]);
    expect(thin.you).toBeNull();

    const zoom = await repository.getMarketHeatmapSet({ game: 'pokemon', setId: 'base1', window: '30d' });
    expect(zoom?.name).toBe('Base');
    await expect(repository.getMarketHeatmapSet({ game: 'pokemon', setId: 'nope', window: '30d' })).resolves.toBeNull();
    await expect(repository.getCardPricePosition({ cardId: 'sv3pt5-199' })).resolves.toEqual(mockCardPricePosition);
  });
});
