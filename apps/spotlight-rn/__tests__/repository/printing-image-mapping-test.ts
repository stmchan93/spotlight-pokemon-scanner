import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

const SAA_URL = 'https://tcgplayer-cdn.tcgplayer.com/product/541670_in_1000x1000.jpg';
const SAA_SMALL_URL = 'https://tcgplayer-cdn.tcgplayer.com/product/541670_400w.jpg';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response;
}

const card = {
  id: 'onepiece~OP05-091',
  name: 'Rebecca',
  setName: 'Awakening of the New Era',
  number: 'OP05-091',
  imageLargeURL: 'https://images.scrydex.com/onepiece/OP05-091/large',
  imageSmallURL: 'https://images.scrydex.com/onepiece/OP05-091/small',
  pricing: { currencyCode: 'USD', market: 148.61 },
};

function mockFetch(routes: Record<string, unknown>) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    const match = Object.keys(routes).find((path) => url.includes(path));
    if (!match) {
      throw new Error(`Unexpected URL: ${url}`);
    }
    return jsonResponse(routes[match]);
  }) as typeof fetch;
}

describe('HttpSpotlightRepository printing image mapping', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('passes an owned alt-art copy\'s printing image through and omits it otherwise', async () => {
    mockFetch({
      '/api/v1/deck/entries': {
        entries: [
          {
            id: 'saa',
            itemKind: 'raw',
            quantity: 1,
            card,
            variantName: 'Special Alt Art',
            printingImageUrl: SAA_URL,
            printingImageSmallUrl: SAA_SMALL_URL,
            addedAt: '2026-09-28T10:00:00Z',
          },
          // Older servers send nothing; newer ones null for base-art printings.
          { id: 'old', itemKind: 'raw', quantity: 1, card, addedAt: '2026-09-27T10:00:00Z' },
          {
            id: 'foil',
            itemKind: 'raw',
            quantity: 1,
            card,
            variantName: 'Foil',
            printingImageUrl: null,
            printingImageSmallUrl: null,
            addedAt: '2026-09-26T10:00:00Z',
          },
        ],
      },
    });

    const entries = await new HttpSpotlightRepository('http://example.test').getInventoryEntries();
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));

    expect(byId.saa.printingImageUrl).toBe(SAA_URL);
    expect(byId.saa.printingImageSmallUrl).toBe(SAA_SMALL_URL);
    // The card image stays the card's own art.
    expect(byId.saa.smallImageUrl).toBe(card.imageSmallURL);
    for (const id of ['old', 'foil']) {
      expect(byId[id].printingImageUrl).toBeUndefined();
      expect(byId[id].printingImageSmallUrl).toBeUndefined();
      expect('printingImageUrl' in byId[id]).toBe(false);
    }
  });

  it('maps the printing image on watchlist rows', async () => {
    mockFetch({
      '/api/v1/card-favorites': {
        entries: [
          {
            card,
            favoritedAt: '2026-09-28T10:00:00Z',
            watchVariant: 'Special Alt Art',
            printingImageUrl: SAA_URL,
            printingImageSmallUrl: SAA_SMALL_URL,
          },
        ],
      },
    });

    const favorites = await new HttpSpotlightRepository('http://example.test').getCardFavorites();

    expect(favorites).toHaveLength(1);
    expect(favorites[0].printingImageSmallUrl).toBe(SAA_SMALL_URL);
  });

  it('maps the printing image on performance rows', async () => {
    mockFetch({
      '/api/v1/portfolio/performance': {
        rows: [
          { entryId: 'saa', cardId: card.id, name: 'Rebecca', printingImageUrl: SAA_URL, printingImageSmallUrl: SAA_SMALL_URL },
          { entryId: 'foil', cardId: card.id, name: 'Rebecca' },
        ],
      },
    });

    const performance = await new HttpSpotlightRepository('http://example.test').getPortfolioPerformance();

    expect(performance.rows[0].printingImageSmallUrl).toBe(SAA_SMALL_URL);
    expect(performance.rows[1].printingImageUrl).toBeUndefined();
  });
});
