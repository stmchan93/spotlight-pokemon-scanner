import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';
import {
  cardHasGradedData,
  pricedGradersForCard,
} from '../../../../packages/api-client/src/spotlight/types';

/**
 * TCGplayer-only cards (Scrydex does not list them) arrive with
 * `catalogSource: 'tcgplayer'`. That field decides whether a card page offers
 * graded lanes and what a slab of the card is worth, so it has to survive every
 * mapper — and an absent field (older server) must read as the normal Scrydex
 * catalog, never as TCGplayer.
 */

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

const luffy = {
  id: 'onepiece~tcgplayer-552137',
  game: 'onepiece',
  catalogSource: 'tcgplayer',
  canonicalCardId: null,
  name: 'Monkey.D.Luffy (Sealed Battle 2024 Vol. 2)',
  setName: 'Sealed Battle 2024',
  number: '',
  imageLargeURL: 'https://tcgplayer-cdn.tcgplayer.com/product/552137_in_1000x1000.jpg',
  pricing: { currencyCode: 'USD', market: 250 },
};

describe('catalogSource carried off the wire', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('parses catalogSource on search results, and reads an absent one as scrydex', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/search')) {
        return jsonResponse(200, {
          results: [
            luffy,
            { id: 'sv1-201', name: 'Skwovet', setName: 'Scarlet & Violet', number: '201/198' },
            { id: 'sv1-202', name: 'Greedent', setName: 'Scarlet & Violet', number: '202/198', catalogSource: 'somethingnew' },
          ],
        });
      }
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.loadCatalogCards('luffy', 20, 0);

    expect(result.data?.map((row) => row.catalogSource)).toEqual(['tcgplayer', 'scrydex', 'scrydex']);
    // Empty number → no "#--" placeholder anywhere downstream.
    expect(result.data?.[0].cardNumber).toBe('');
    expect(result.data?.[0].canonicalCardId).toBeNull();
  });

  it('falls back to the tcgplayer id pattern when the field is missing', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/scan/visual-match')) {
        return jsonResponse(200, {
          scanID: 'scan-tcgp',
          topCandidates: [
            { rank: 1, candidate: { ...luffy, catalogSource: undefined } },
            // `tcgp-` is Scrydex's TCG Pocket, NOT a TCGplayer-only card.
            { rank: 2, candidate: { id: 'tcgp-A1-001', name: 'Bulbasaur', setName: 'Genetic Apex', number: '1' } },
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
      game: 'onepiece',
    });

    expect(result.candidates.map((candidate) => candidate.catalogSource)).toEqual(['tcgplayer', 'scrydex']);
  });

  it('parses catalogSource + canonicalCardId on card detail and hides an empty number', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/market-history')) {
        return jsonResponse(200, { currencyCode: 'USD', currentPrice: 250, points: [], availableVariants: [] });
      }
      if (url.includes('/api/v1/cards/')) {
        return jsonResponse(200, { card: { ...luffy, canonicalCardId: 'op-p-001' } });
      }
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const detail = await repository.getCardDetail({ cardId: luffy.id });

    expect(detail?.catalogSource).toBe('tcgplayer');
    expect(detail?.canonicalCardId).toBe('op-p-001');
    expect(detail?.cardNumber).toBe('');
  });

  it('values a graded holding of a TCGplayer-only card as unpriced, and a raw one normally', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, {
          entries: [
            {
              id: 'entry-slab',
              itemKind: 'slab',
              quantity: 1,
              addedAt: '2026-09-28T18:00:00Z',
              slabContext: { grader: 'PSA', grade: '10' },
              sinceAddedChangeAmount: 10,
              card: pokemonTcgplayerOnly,
            },
            {
              id: 'entry-raw',
              itemKind: 'raw',
              quantity: 1,
              condition: 'near_mint',
              addedAt: '2026-09-28T18:00:00Z',
              card: pokemonTcgplayerOnly,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const [slab, raw] = await repository.getInventoryEntries();

    expect(slab.kind).toBe('graded');
    expect(slab.catalogSource).toBe('tcgplayer');
    expect(slab.hasMarketPrice).toBe(false);
    expect(slab.marketPrice).toBe(0);
    expect(slab.sinceAddedChangeAmount).toBeNull();

    expect(raw.kind).toBe('raw');
    expect(raw.hasMarketPrice).toBe(true);
    expect(raw.marketPrice).toBe(42);
  });
});

const pokemonTcgplayerOnly = {
  id: 'tcgplayer-600001',
  catalogSource: 'tcgplayer',
  name: 'Pikachu (Staff Prerelease)',
  setName: 'Prerelease Promos',
  number: '',
  pricing: { currencyCode: 'USD', market: 42 },
};

describe('graded capability for a TCGplayer-only card', () => {
  it('drops graded lanes whatever the game, and keeps them for Scrydex cards', () => {
    expect(cardHasGradedData('pokemon', 'tcgplayer')).toBe(false);
    expect(pricedGradersForCard('pokemon', 'tcgplayer')).toEqual(['Raw']);
    expect(cardHasGradedData('pokemon', undefined)).toBe(true);
    expect(pricedGradersForCard('pokemon', 'scrydex')).toEqual(['Raw', 'PSA', 'BGS', 'CGC']);
  });
});
