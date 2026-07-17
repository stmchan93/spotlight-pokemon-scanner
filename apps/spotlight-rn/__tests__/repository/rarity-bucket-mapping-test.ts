import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

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

function deckEntriesResponse(cardExtras: Record<string, unknown>) {
  return jsonResponse(200, {
    entries: [
      {
        id: 'entry-1',
        itemKind: 'raw',
        quantity: 1,
        card: {
          id: 'c1',
          name: 'Pikachu',
          setName: 'Base',
          number: '58/102',
          pricing: { currencyCode: 'usd', market: 10 },
          ...cardExtras,
        },
        condition: 'near_mint',
        addedAt: '2026-04-29T18:00:00Z',
      },
    ],
  });
}

describe('HttpSpotlightRepository rarityBucket mapping', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('passes a served rarityBucket through the deck-entry mapper', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return deckEntriesResponse({ rarityBucket: 'sir' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const entries = await repository.getInventoryEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0].rarityBucket).toBe('sir');
  });

  it('drops invalid or missing rarityBucket values to undefined without dropping the entry', async () => {
    // The client never re-implements the rarity→bucket mapping — unknown
    // values (and old cached payloads with none) must degrade to undefined.
    for (const extras of [{ rarityBucket: 'legendary' }, { rarityBucket: 42 }, {}]) {
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/deck/entries')) {
          return deckEntriesResponse(extras);
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const repository = new HttpSpotlightRepository('http://example.test');
      const entries = await repository.getInventoryEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0].rarityBucket).toBeUndefined();
    }
  });

  it('passes rarityBucket through the wishlist favorites mapper (and nulls invalid values)', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/card-favorites')) {
        return jsonResponse(200, {
          entries: [
            {
              card: {
                id: 'fav-1',
                name: 'Umbreon VMAX',
                setName: 'Evolving Skies',
                number: '215/203',
                pricing: { currencyCode: 'USD', market: 1300 },
                rarityBucket: 'shiny',
              },
              favoritedAt: '2026-05-01T00:00:00Z',
              isOwned: false,
            },
            {
              card: {
                id: 'fav-2',
                name: 'Sylveon VMAX',
                setName: 'Evolving Skies',
                number: '212/203',
                pricing: { currencyCode: 'USD', market: 300 },
                rarityBucket: 'not-a-bucket',
              },
              favoritedAt: '2026-05-02T00:00:00Z',
              isOwned: false,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const favorites = await repository.getCardFavorites();

    expect(favorites).toHaveLength(2);
    expect(favorites[0].rarityBucket).toBe('shiny');
    expect(favorites[1].rarityBucket).toBeUndefined();
  });

  it('passes rarityBucket through catalog search results and sends the rarityBucket query param', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/search')) {
        return jsonResponse(200, {
          results: [
            {
              id: 'sv1-201',
              name: 'Skwovet',
              setName: 'Scarlet & Violet',
              number: '201/198',
              pricing: { currencyCode: 'USD', market: 4.2 },
              rarityBucket: 'illustration',
            },
          ],
        });
      }
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.loadCatalogCards('skwovet', 20, 0, { rarityBucket: 'illustration' });

    const searchUrl = new URL(
      (global.fetch as jest.Mock).mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes('/api/v1/cards/search'))!,
    );
    expect(searchUrl.searchParams.get('q')).toBe('skwovet');
    expect(searchUrl.searchParams.get('rarityBucket')).toBe('illustration');
    expect(result.data?.[0].rarityBucket).toBe('illustration');
  });

  it('allows a chip-only search: empty text + rarityBucket issues the request without a q param', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/search')) {
        return jsonResponse(200, { results: [] });
      }
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.loadCatalogCards('', 20, 0, { rarityBucket: 'secret' });

    const searchUrl = new URL(
      (global.fetch as jest.Mock).mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes('/api/v1/cards/search'))!,
    );
    expect(searchUrl.searchParams.get('q')).toBeNull();
    expect(searchUrl.searchParams.get('rarityBucket')).toBe('secret');
  });

  it('still short-circuits to empty when there is neither text nor a rarity filter', async () => {
    global.fetch = jest.fn() as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.loadCatalogCards('a', 20, 0);

    expect(result.state).toBe('empty');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps rarityBucket on scanner match candidates (persisted tray rows carry full candidates[])', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/scan/visual-match')) {
        return jsonResponse(200, {
          scanID: 'scan-rarity',
          topCandidates: [
            {
              rank: 1,
              candidate: {
                id: 'sv4pt5-234',
                name: 'Charizard ex',
                setName: 'Paldean Fates',
                number: '234/091',
                pricing: { currencyCode: 'usd', market: 120 },
                rarityBucket: 'sir',
              },
            },
            {
              rank: 2,
              candidate: {
                id: 'sv4pt5-054',
                name: 'Charizard ex',
                setName: 'Paldean Fates',
                number: '054/091',
                pricing: { currencyCode: 'usd', market: 3 },
                // Unknown bucket → undefined, never a crash or a dropped row.
                rarityBucket: 'mystery',
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.matchScannerCapture({
      jpegBase64: 'bW9jay1zY2Fu',
      height: 1620,
      mode: 'raw',
      width: 1080,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].rarityBucket).toBe('sir');
    expect(result.candidates[1].rarityBucket).toBeUndefined();
  });
});
