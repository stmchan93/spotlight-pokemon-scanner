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

const sealedResult = {
  id: 'tcgp-sealed-593355',
  name: 'Prismatic Evolutions Elite Trainer Box',
  setName: 'SV: Prismatic Evolutions',
  number: '',
  rarity: '',
  supertype: 'Sealed',
  subtypes: ['Elite Trainer Box'],
  game: 'pokemon',
  imageSmallURL: 'https://example.test/etb-small.jpg',
  imageLargeURL: 'https://example.test/etb.jpg',
  pricing: { currencyCode: 'USD', market: 89.99 },
};

const cardResult = {
  id: 'sv1-201',
  name: 'Skwovet',
  setName: 'Scarlet & Violet',
  number: '201/198',
  supertype: 'Pokémon',
  subtypes: ['Basic'],
  pricing: { currencyCode: 'USD', market: 4.2 },
};

function mockFetch(results: unknown[]) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (url.includes('/api/v1/cards/search')) {
      return jsonResponse(200, { results });
    }
    if (url.includes('/api/v1/deck/entries')) {
      return jsonResponse(200, { entries: [] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
}

function searchUrl() {
  return (global.fetch as jest.Mock).mock.calls
    .map(([url]) => String(url))
    .find((url) => url.includes('/api/v1/cards/search'))!;
}

describe('HttpSpotlightRepository sealed product search', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends kind=sealed and maps supertype Sealed to a sealed result with its product type', async () => {
    mockFetch([sealedResult]);

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.loadCatalogCards('prismatic', 20, 0, { game: 'all', kind: 'sealed' });

    const url = new URL(searchUrl());
    expect(url.searchParams.get('kind')).toBe('sealed');
    expect(url.searchParams.get('q')).toBe('prismatic');
    expect(result.data?.[0]).toMatchObject({
      cardId: 'tcgp-sealed-593355',
      productKind: 'sealed',
      sealedProductType: 'Elite Trainer Box',
      cardNumber: '',
      setName: 'SV: Prismatic Evolutions',
      marketPrice: 89.99,
    });
  });

  it('allows a Sealed-only browse: empty text still issues the request, with no q', async () => {
    mockFetch([]);

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.loadCatalogCards('', 20, 0, { kind: 'sealed' });

    const url = new URL(searchUrl());
    expect(url.searchParams.get('q')).toBeNull();
    expect(url.searchParams.get('kind')).toBe('sealed');
  });

  it('keeps the default card search URL byte-identical and maps results as cards', async () => {
    mockFetch([cardResult]);

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.loadCatalogCards('skwovet', 20, 0, { game: 'all' });
    await repository.loadCatalogCards('skwovet', 20, 0, { game: 'all', kind: 'cards' });

    const urls = (global.fetch as jest.Mock).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/api/v1/cards/search'));
    expect(urls).toEqual([
      'http://example.test/api/v1/cards/search?limit=20&offset=0&q=skwovet&game=all',
      'http://example.test/api/v1/cards/search?limit=20&offset=0&q=skwovet&game=all',
    ]);
    expect(result.data?.[0]).toMatchObject({
      productKind: 'card',
      sealedProductType: null,
      cardNumber: '#201/198',
    });
  });

  it('maps productKind/sealedProductType on card detail, defaulting to a card', async () => {
    const detailFor = (card: Record<string, unknown>) => jsonResponse(200, { card });
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/market-history')) {
        return jsonResponse(200, { points: [] });
      }
      if (url.includes('/api/v1/cards/tcgp-sealed-593355')) {
        return detailFor({
          ...sealedResult,
          supertype: undefined,
          subtypes: undefined,
          productKind: 'sealed',
          sealedProductType: 'Elite Trainer Box',
        });
      }
      if (url.includes('/api/v1/cards/sv1-201')) {
        return detailFor(cardResult);
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const sealed = await repository.getCardDetail({ cardId: 'tcgp-sealed-593355' }, { includeOwnedEntries: false });
    const card = await repository.getCardDetail({ cardId: 'sv1-201' }, { includeOwnedEntries: false });

    expect(sealed).toMatchObject({ productKind: 'sealed', sealedProductType: 'Elite Trainer Box', cardNumber: '' });
    expect(card).toMatchObject({ productKind: 'card', sealedProductType: null, cardNumber: '#201/198' });
  });
});

describe('MockSpotlightRepository sealed product search', () => {
  it('returns sealed products only for kind sealed, including a text-less browse', async () => {
    const repository = new MockSpotlightRepository();

    const browse = await repository.searchCatalogCardsPage('', 20, 0, { game: 'all', kind: 'sealed' });
    expect(browse.cards.length).toBeGreaterThan(0);
    expect(browse.cards.every((card) => card.productKind === 'sealed')).toBe(true);

    const byType = await repository.searchCatalogCardsPage('elite trainer', 20, 0, { kind: 'sealed' });
    expect(byType.cards.map((card) => card.sealedProductType)).toEqual(['Elite Trainer Box']);

    const cards = await repository.searchCatalogCardsPage('prismatic', 20, 0, { game: 'all' });
    expect(cards.cards).toHaveLength(0);
  });
});
