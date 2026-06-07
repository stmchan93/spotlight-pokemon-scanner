import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';
import type { ScannerArtifactUploadResult } from '../../../../packages/api-client/src/spotlight/types';

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

describe('HttpSpotlightRepository', () => {
  const originalFetch = global.fetch;

  function dateSequence(startIsoDate: string, count: number) {
    const startDate = new Date(`${startIsoDate}T12:00:00.000Z`);
    return Array.from({ length: count }, (_, index) => {
      const nextDate = new Date(startDate);
      nextDate.setUTCDate(startDate.getUTCDate() + index);
      return nextDate.toISOString().slice(0, 10);
    });
  }

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns an error load state but an empty inventory list when the request fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('backend offline')) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const loadResult = await repository.loadInventoryEntries();

    expect(loadResult.state).toBe('error');
    expect(loadResult.data).toEqual([]);
    await expect(repository.getInventoryEntries()).resolves.toEqual([]);
  });

  it('attaches the bearer token to backend requests when an access token provider is configured', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { entries: [] })) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test', {
      getAccessToken: () => 'test-access-token',
    });

    await repository.getInventoryEntries();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit | undefined];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-access-token');
  });

  it('surfaces not-found for card detail lookups and add-to-collection options', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/missing-card/market-history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          points: [],
          availableVariants: [],
          availableConditions: [],
        });
      }

      if (url.includes('/api/v1/cards/missing-card')) {
        return jsonResponse(404, { error: 'missing' });
      }

      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const loadResult = await repository.loadCardDetail({ cardId: 'missing-card' });

    expect(loadResult.state).toBe('not_found');
    expect(loadResult.data).toBeNull();
    await expect(repository.getCardDetail({ cardId: 'missing-card' })).resolves.toBeNull();
    await expect(repository.getAddToCollectionOptions('missing-card')).rejects.toMatchObject(
      {
        kind: 'not_found',
        status: 404,
      },
    );
  });

  it('sanitizes invalid remote image URLs in card detail payloads', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/sm7-1/market-history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          currentPrice: 0.31,
          points: [],
          availableVariants: [],
          availableConditions: [],
        });
      }

      if (url.includes('/api/v1/cards/sm7-1')) {
        return jsonResponse(200, {
          imageSmallURL: 'javascript:alert(1)',
          imageLargeURL: 'not-a-real-image-url',
          card: {
            id: 'sm7-1',
            name: 'Treecko',
            setName: 'Celestial Storm',
            number: '1',
            imageSmallURL: 'not-a-real-image-url',
            imageLargeURL: 'javascript:alert(1)',
            pricing: {
              currencyCode: 'usd',
              market: 0.31,
            },
          },
        });
      }

      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const detail = await repository.getCardDetail({ cardId: 'sm7-1' });

    expect(detail).not.toBeNull();
    expect(detail?.imageUrl).toBe('');
    expect(detail?.largeImageUrl).toBeNull();
  });

  it('maps recent eBay sales into the recent-sales payload', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/sm7-1/recent-sales')) {
        return jsonResponse(200, {
          status: 'available',
          saleCount: 1,
          source: 'ebay',
          fetchedAt: '2026-05-03T12:00:00Z',
          canRefresh: false,
          sales: [
            {
              id: 'sale-1',
              title: 'Treecko recent sold listing',
              soldAt: '2026-05-02T10:00:00Z',
              price: {
                amount: 1.99,
                currencyCode: 'USD',
              },
              listingURL: 'https://www.ebay.com/itm/123',
            },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const sales = await repository.getCardRecentSales({
      cardId: 'sm7-1',
      slabContext: { grader: 'PSA', grade: '9', certNumber: '1234', variantName: 'PSA 9' },
      source: 'ebay',
    });

    expect(sales).toMatchObject({
      status: 'available',
      saleCount: 1,
      source: 'ebay',
      canRefresh: false,
    });
    expect(sales?.sales[0]).toMatchObject({
      title: 'Treecko recent sold listing',
      priceAmount: 1.99,
      currencyCode: 'USD',
      saleUrl: 'https://www.ebay.com/itm/123',
    });
  });

  it('sorts recent eBay sales from latest sold date to earliest before returning them to the UI', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/sm7-1/recent-sales')) {
        return jsonResponse(200, {
          status: 'available',
          source: 'ebay',
          canRefresh: false,
          sales: [
            {
              id: 'sale-1',
              title: 'Treecko sold 21.99',
              soldAt: '2026-04-25T12:00:00Z',
              price: {
                amount: 21.99,
                currencyCode: 'USD',
              },
              listingURL: 'https://www.ebay.com/itm/123',
            },
            {
              id: 'sale-2',
              title: 'Treecko sold 90.00',
              soldAt: '2026-04-27T12:00:00Z',
              price: {
                amount: 90,
                currencyCode: 'USD',
              },
              listingURL: 'https://www.ebay.com/itm/124',
            },
            {
              id: 'sale-3',
              title: 'Treecko sold 1.00',
              soldAt: '2026-04-20T12:00:00Z',
              price: {
                amount: 1,
                currencyCode: 'USD',
              },
              listingURL: 'https://www.ebay.com/itm/125',
            },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const sales = await repository.getCardRecentSales({
      cardId: 'sm7-1',
      slabContext: { grader: 'PSA', grade: '9', certNumber: '1234', variantName: 'PSA 9' },
      source: 'ebay',
    });

    expect(sales?.sales.map((sale) => sale.id)).toEqual(['sale-2', 'sale-1', 'sale-3']);
  });

  it('loads raw card market history with the near-mint condition by default', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/sv4-199/market-history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          currentPrice: 112.01,
          selectedCondition: 'NM',
          points: [
            { date: '2026-04-27', market: 112.01 },
          ],
          availableVariants: [
            { id: 'Holofoil', label: 'Holofoil', currentPrice: 112.01 },
          ],
          availableConditions: [
            { id: 'NM', label: 'NM', currentPrice: 112.01 },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const history = await repository.getCardMarketHistory({ cardId: 'sv4-199' });
    const requestedUrl = new URL(String((global.fetch as jest.Mock).mock.calls[0]?.[0]));

    expect(requestedUrl?.searchParams.get('days')).toBe('30');
    expect(requestedUrl?.searchParams.get('condition')).toBe('NM');
    expect(history).toMatchObject({
      currentPrice: 112.01,
      selectedCondition: 'NM',
    });
    expect(history?.points).toHaveLength(1);
  });

  it('preserves recent-sales unavailable status when cached sales are not loaded yet', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/sv4-199/recent-sales')) {
        return jsonResponse(200, {
          status: 'unavailable',
          statusReason: 'not_loaded',
          unavailableReason: null,
          canRefresh: false,
          saleCount: 0,
          sales: [],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const listings = await repository.getCardRecentSales({
      cardId: 'sv4-199',
      limit: 5,
      slabContext: { grader: 'PSA', grade: '10', certNumber: '1234', variantName: 'PSA 10' },
    });
    const requestedUrl = new URL(String((global.fetch as jest.Mock).mock.calls[0]?.[0]));

    expect(requestedUrl?.searchParams.get('limit')).toBe('5');
    expect(listings).toMatchObject({
      status: 'unavailable',
      statusReason: 'not_loaded',
      saleCount: 0,
      canRefresh: false,
    });
  });

  it('returns an error load state but still shapes an empty portfolio dashboard on failures', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('backend offline')) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const loadResult = await repository.loadPortfolioDashboard();

    expect(loadResult.state).toBe('error');
    expect(loadResult.data).toMatchObject({
      inventoryCount: 0,
      inventoryItems: [],
      recentSales: [],
    });

    await expect(repository.getPortfolioDashboard()).resolves.toMatchObject({
      inventoryCount: 0,
      inventoryItems: [],
      recentSales: [],
    });
  });

  it('maps generic fetch transport errors to a friendlier backend-reachability message', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed')) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const loadResult = await repository.loadPortfolioDashboard();

    expect(loadResult.state).toBe('error');
    expect(loadResult.errorMessage).toBe('Could not reach the Spotlight backend.');
  });

  it('keeps the dashboard fresh when only secondary ledger ranges fail (partial tolerance)', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
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
                pricing: { currencyCode: 'usd', market: 10, payload: { condition: 'NM' } },
              },
              condition: 'near_mint',
              addedAt: '2026-04-29T18:00:00Z',
            },
          ],
        });
      }
      if (url.includes('/api/v1/portfolio/history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          summary: { currentValue: 10, deltaValue: 0, deltaPercent: 0 },
          points: [],
        });
      }
      // Secondary, slowest endpoints — simulate them failing/timing out.
      if (url.includes('/api/v1/portfolio/ledger')) {
        return jsonResponse(500, { error: 'ledger slow' });
      }
      if (url.includes('/api/v1/portfolio/insights')) {
        return jsonResponse(200, {});
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const loadResult = await repository.loadPortfolioDashboard();

    // A failing secondary ledger range must not blank the screen: the card list
    // and headline value still load, so the refresh succeeds (no spurious
    // "couldn't refresh" banner).
    const data = loadResult.data;
    if (!data) {
      throw new Error('expected a dashboard payload');
    }
    expect(loadResult.state).toBe('success');
    expect(data.inventoryItems).toHaveLength(1);
    expect(data.summary.currentValue).toBe(10);
  });

  it('still reports an error when the critical inventory request fails', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(503, { error: 'inventory unavailable' });
      }
      if (url.includes('/api/v1/portfolio/history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          summary: { currentValue: 0, deltaValue: 0, deltaPercent: 0 },
          points: [],
        });
      }
      if (url.includes('/api/v1/portfolio/ledger')) {
        return jsonResponse(200, { currencyCode: 'USD', transactions: [], dailySeries: [] });
      }
      if (url.includes('/api/v1/portfolio/insights')) {
        return jsonResponse(200, {});
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const loadResult = await repository.loadPortfolioDashboard();

    expect(loadResult.state).toBe('error');
  });

  it('loads the whole dashboard from the single consolidated endpoint when available', async () => {
    const emptyHistory = { summary: { currentValue: 0, deltaValue: 0, deltaPercent: 0 }, points: [], currencyCode: 'USD' };
    const emptyLedger = { transactions: [], dailySeries: [] };
    const ranges = ['1W', '1M', '3M', 'YTD', '1Y', 'ALL'];
    const sections: Record<string, string> = { inventory: 'ok', insights: 'ok' };
    const rangePayload: Record<string, unknown> = {};
    for (const key of ranges) {
      sections[`history.${key}`] = 'ok';
      sections[`ledger.${key}`] = 'ok';
      rangePayload[key] = {
        history: key === '1W'
          ? { summary: { currentValue: 42, deltaValue: 0, deltaPercent: 0 }, currencyCode: 'USD', points: [{ date: '2026-06-01', totalValue: 42 }] }
          : emptyHistory,
        ledger: emptyLedger,
      };
    }

    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/portfolio/dashboard')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          inventory: {
            entries: [
              {
                id: 'entry-1',
                itemKind: 'raw',
                quantity: 1,
                card: { id: 'c1', name: 'Pikachu', setName: 'Base', number: '58/102', pricing: { currencyCode: 'usd', market: 42 } },
                condition: 'near_mint',
                addedAt: '2026-04-29T18:00:00Z',
              },
            ],
          },
          insights: null,
          ranges: rangePayload,
          sections,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const loadResult = await repository.loadPortfolioDashboard();

    const data = loadResult.data;
    if (!data) {
      throw new Error('expected a dashboard payload');
    }
    expect(loadResult.state).toBe('success');
    expect(data.inventoryItems).toHaveLength(1);
    expect(data.summary.currentValue).toBe(42);

    // It must NOT fan out to the per-section endpoints when the consolidated
    // call succeeds.
    const fetchedUrls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(fetchedUrls.some((url) => url.includes('/api/v1/portfolio/dashboard'))).toBe(true);
    expect(fetchedUrls.some((url) => url.includes('/api/v1/deck/entries'))).toBe(false);
    expect(fetchedUrls.some((url) => url.includes('/api/v1/portfolio/history'))).toBe(false);
  });

  it('falls back to the per-section fan-out when the consolidated endpoint is missing (404)', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/portfolio/dashboard')) {
        return jsonResponse(404, { error: 'not found' });
      }
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, {
          entries: [
            {
              id: 'entry-1',
              itemKind: 'raw',
              quantity: 1,
              card: { id: 'c1', name: 'Pikachu', setName: 'Base', number: '58/102', pricing: { currencyCode: 'usd', market: 42 } },
              condition: 'near_mint',
              addedAt: '2026-04-29T18:00:00Z',
            },
          ],
        });
      }
      if (url.includes('/api/v1/portfolio/history')) {
        return jsonResponse(200, { currencyCode: 'USD', summary: { currentValue: 42, deltaValue: 0, deltaPercent: 0 }, points: [{ date: '2026-06-01', totalValue: 42 }] });
      }
      if (url.includes('/api/v1/portfolio/ledger')) {
        return jsonResponse(200, { currencyCode: 'USD', transactions: [], dailySeries: [] });
      }
      if (url.includes('/api/v1/portfolio/insights')) {
        return jsonResponse(200, {});
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const loadResult = await repository.loadPortfolioDashboard();

    expect(loadResult.state).toBe('success');
    const fetchedUrls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    // Tried the consolidated endpoint, then fell back to the per-section calls.
    expect(fetchedUrls.some((url) => url.includes('/api/v1/portfolio/dashboard'))).toBe(true);
    expect(fetchedUrls.some((url) => url.includes('/api/v1/deck/entries'))).toBe(true);
  });

  it('prefers small image URLs for portfolio thumbnails while preserving large image URLs for detail previews', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, {
          entries: [
            {
              id: 'entry-oshawott',
              itemKind: 'raw',
              quantity: 1,
              card: {
                id: 'catalog-oshawott-real',
                name: 'Oshawott',
                setName: "McDonald's Collection 2021",
                number: '21/25',
                imageSmallURL: 'https://cdn.example/oshawott-small.png',
                imageLargeURL: 'https://cdn.example/oshawott-large.png',
                pricing: {
                  currencyCode: 'usd',
                  market: 1.23,
                  payload: {
                    condition: 'NM',
                  },
                },
              },
              condition: 'near_mint',
              addedAt: '2026-04-29T18:00:00Z',
            },
          ],
        });
      }

      if (url.includes('/api/v1/portfolio/history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          summary: {
            currentValue: 1.23,
            deltaValue: 0,
            deltaPercent: 0,
          },
          points: [],
        });
      }

      if (url.includes('/api/v1/portfolio/ledger')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          transactions: [
            {
              id: 'sale-oshawott',
              kind: 'sell',
              quantity: 1,
              unitPrice: 2.5,
              totalPrice: 2.5,
              currencyCode: 'USD',
              occurredAt: '2026-04-29T19:00:00Z',
              card: {
                id: 'catalog-oshawott-real',
                name: 'Oshawott',
                setName: "McDonald's Collection 2021",
                number: '21/25',
                imageSmallURL: 'https://cdn.example/oshawott-small.png',
                imageLargeURL: 'https://cdn.example/oshawott-large.png',
              },
            },
          ],
          dailySeries: [],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const dashboard = await repository.getPortfolioDashboard();

    expect(dashboard.inventoryItems[0]).toMatchObject({
      imageUrl: 'https://cdn.example/oshawott-small.png',
      smallImageUrl: 'https://cdn.example/oshawott-small.png',
      largeImageUrl: 'https://cdn.example/oshawott-large.png',
    });
    expect(dashboard.recentSales[0]).toMatchObject({
      imageUrl: 'https://cdn.example/oshawott-small.png',
      smallImageUrl: 'https://cdn.example/oshawott-small.png',
      largeImageUrl: 'https://cdn.example/oshawott-large.png',
    });
  });

  it('treats backend raw condition codes as priced inventory matches for the fast portfolio fallback', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, {
          entries: [
            {
              id: 'entry-oshawott',
              itemKind: 'raw',
              quantity: 1,
              card: {
                id: 'catalog-oshawott-real',
                name: 'Oshawott',
                setName: "McDonald's Collection 2021",
                number: '21/25',
                imageSmallURL: 'https://cdn.example/oshawott-small.png',
                imageLargeURL: 'https://cdn.example/oshawott-large.png',
                pricing: {
                  currencyCode: 'usd',
                  market: 1.23,
                  payload: {
                    condition: 'near_mint',
                  },
                },
              },
              condition: 'near_mint',
              addedAt: '2026-04-29T18:00:00Z',
            },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const entries = await repository.getInventoryEntries();

    expect(entries[0]).toMatchObject({
      conditionCode: 'near_mint',
      hasMarketPrice: true,
      marketPrice: 1.23,
    });
  });

  it('matches raw scanner captures through the backend visual-only endpoint and exposes real candidate ids', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    let requestBody: Record<string, unknown> | null = null;
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    try {
      global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/v1/scan/visual-match')) {
          requestBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
          return jsonResponse(200, {
            scanID: 'scan-oshawott',
            performance: {
              serverProcessingMs: 52.5,
            },
            topCandidates: [
              {
                rank: 1,
                candidate: {
                  id: 'catalog-oshawott-real',
                  name: 'Oshawott',
                  setName: "McDonald's Collection 2021",
                  number: '21/25',
                  imageSmallURL: 'https://cdn.example/oshawott-small.png',
                  imageLargeURL: 'https://cdn.example/oshawott-large.png',
                  pricing: {
                    currencyCode: 'usd',
                    market: 1.23,
                  },
                },
              },
            ],
          });
        }

        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const repository = new HttpSpotlightRepository('http://example.test', {
        clientContext: {
          appVersion: '1.0.0',
          buildNumber: '11',
        },
      });
      const result = await repository.matchScannerCapture({
        jpegBase64: 'bW9jay1zY2Fu',
        height: 1620,
        mode: 'raw',
        width: 1080,
      });
      const [candidate] = result.candidates;

      expect(candidate).toMatchObject({
        cardId: 'catalog-oshawott-real',
        id: 'catalog-oshawott-real',
        imageUrl: 'https://cdn.example/oshawott-large.png',
        marketPrice: 1.23,
      });
      expect(requestBody).toMatchObject({
        clientContext: {
          appVersion: '1.0.0',
          buildNumber: '11',
          platform: 'react_native',
        },
        resolverModeHint: 'raw_card',
        rawResolverMode: 'visual',
        recognizedTokens: [],
        ocrAnalysis: null,
      });
      expect(result.requestAttemptCount).toBe(1);
      expect(result.requestUrl).toBe('http://example.test/api/v1/scan/visual-match');
      expect(result.scanID).toBe('scan-oshawott');
      expect(result.endpointPath).toBe('api/v1/scan/visual-match');
      expect(result.serverProcessingMs).toBe(52.5);
      expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('[SPOTLIGHT API] api/v1/scan/visual-match'));
      expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('strategy=single_active'));
    } finally {
      if (previousNodeEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).NODE_ENV;
      } else {
        (process.env as Record<string, string | undefined>).NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('does not retry scanner match requests across fallback base URLs', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('http://bad.local:8788/api/v1/scan/visual-match')) {
        throw new Error('backend offline');
      }

      if (url.startsWith('http://192.168.1.146:8788/api/v1/scan/visual-match')) {
        return jsonResponse(200, {
          scanID: 'scan-should-not-succeed',
          topCandidates: [],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository([
      'http://bad.local:8788',
      'http://192.168.1.146:8788',
    ]);

    await expect(repository.matchScannerCapture({
      height: 1620,
      jpegBase64: 'bW9jay1zY2Fu',
      mode: 'raw',
      width: 1080,
    })).rejects.toMatchObject({
      kind: 'request_failed',
      message: 'backend offline',
    });

    expect((global.fetch as jest.Mock).mock.calls).toEqual([
      [
        'http://bad.local:8788/api/v1/scan/visual-match',
        expect.objectContaining({
          method: 'POST',
        }),
      ],
    ]);
  });

  it('preserves slab review reasons when scan match returns unsupported without candidates', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('http://example.test/api/v1/scan/match')) {
        return jsonResponse(200, {
          scanID: 'scan-slab-empty',
          reviewDisposition: 'unsupported',
          reviewReason: 'Could not extract a confident slab grader and grade.',
          topCandidates: [],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.matchScannerCapture({
      height: 880,
      jpegBase64: 'c2xhYi1zY2Fu',
      mode: 'slabs',
      width: 630,
    });

    expect(result.scanID).toBe('scan-slab-empty');
    expect(result.candidates).toEqual([]);
    expect(result.endpointPath).toBe('api/v1/scan/match');
    expect(result.reviewDisposition).toBe('unsupported');
    expect(result.reviewReason).toBe('Could not extract a confident slab grader and grade.');
  });

  it('sends populated slab evidence and uploads source plus label artifacts after slab matches', async () => {
    let matchRequestBody: any = null;
    let artifactRequestBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://example.test/api/v1/scan/match')) {
        matchRequestBody = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse(200, {
          // Backend echoes the client-supplied scanID.
          scanID: matchRequestBody.scanID,
          resolverMode: 'psa_slab',
          slabContext: {
            grader: 'PSA',
            grade: '9',
            certNumber: '12345678',
            variantName: 'PSA 9',
          },
          topCandidates: [
            {
              candidate: {
                id: 'm2a-232',
                name: 'Mega Dragonite ex',
                setName: 'Mega 2A',
                number: '232/193',
                imageLargeURL: 'https://cdn.example/m2a-232-large.png',
                pricing: {
                  currencyCode: 'USD',
                  market: 30.83,
                  variant: 'PSA 9',
                },
              },
            },
          ],
        });
      }

      if (url.startsWith('http://example.test/api/v1/scan-artifacts')) {
        artifactRequestBody = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse(202, {
          scanID: artifactRequestBody.scanID,
          enabled: true,
          storage: 'filesystem',
          sourceObjectPath: `scans/2026/05/03/${artifactRequestBody.scanID}/source_capture.jpg`,
          normalizedObjectPath: `scans/2026/05/03/${artifactRequestBody.scanID}/normalized_target.jpg`,
          uploadedAt: '2026-05-03T12:00:00Z',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test', {
      clientContext: {
        appVersion: '1.0.0',
        buildNumber: '11',
      },
    });
    let resolveUpload: (value: ScannerArtifactUploadResult | null) => void = () => {};
    const uploadComplete = new Promise<ScannerArtifactUploadResult | null>((resolve) => {
      resolveUpload = resolve;
    });

    const result = await repository.matchScannerCapture({
      mode: 'slabs',
      jpegBase64: 'bGFiZWwtY3JvcA==',
      width: 630,
      height: 280,
      captureSource: 'camera',
      submittedAt: '2026-05-03T12:00:00Z',
      sourceImage: {
        jpegBase64: 'ZnVsbC1zb3VyY2U=',
        width: 1920,
        height: 1080,
      },
      normalizedImage: {
        jpegBase64: 'bGFiZWwtY3JvcA==',
        width: 630,
        height: 280,
      },
      slabAnalysis: {
        slabGrader: 'PSA',
        slabGrade: '9',
        slabCertNumber: '12345678',
        slabBarcodePayloads: ['12345678'],
        slabParsedLabelText: ['PSA 9 Mega Dragonite ex 232/193 M2a'],
        slabCardNumberRaw: '232/193',
        slabGraderConfidence: 0.98,
        slabGradeConfidence: 0.94,
        slabCertConfidence: 0.99,
        slabClassifierReasons: ['barcode_cert_match', 'psa_label_detected'],
        slabRecommendedLookupPath: 'psa_cert',
        ocrAnalysis: {
          slabEvidence: {
            titleTextPrimary: 'Mega Dragonite ex',
            cardNumber: '232/193',
            setHints: ['m2a'],
            grader: 'PSA',
            grade: '9',
            cert: '12345678',
            labelWideText: 'PSA 9 Mega Dragonite ex 232/193 M2a',
          },
        },
      },
    }, {
      onArtifactUploadComplete: resolveUpload,
    });

    expect(matchRequestBody).toMatchObject({
      clientContext: {
        appVersion: '1.0.0',
        buildNumber: '11',
        platform: 'react_native',
      },
      resolverModeHint: 'psa_slab',
      slabGrader: 'PSA',
      slabGrade: '9',
      slabCertNumber: '12345678',
      slabBarcodePayloads: ['12345678'],
      slabParsedLabelText: ['PSA 9 Mega Dragonite ex 232/193 M2a'],
      slabCardNumberRaw: '232/193',
      slabRecommendedLookupPath: 'psa_cert',
      ocrAnalysis: {
        slabEvidence: {
          grader: 'PSA',
          grade: '9',
          cert: '12345678',
        },
      },
    });
    // The scanID is generated client-side so artifact uploads can fire in parallel with
    // the slow slab match. The backend echoes the same ID back.
    expect(typeof matchRequestBody.scanID).toBe('string');
    expect(matchRequestBody.scanID).toMatch(/[0-9a-f-]{36}/i);
    expect(result.scanID).toBe(matchRequestBody.scanID);
    expect(result.resolverMode).toBe('psa_slab');
    expect(result.slabContext).toEqual({
      grader: 'PSA',
      grade: '9',
      certNumber: '12345678',
      variantName: 'PSA 9',
    });

    const artifactUpload = await uploadComplete;
    expect(artifactRequestBody).toEqual({
      scanID: matchRequestBody.scanID,
      submittedAt: '2026-05-03T12:00:00Z',
      captureSource: 'camera',
      sourceImage: {
        jpegBase64: 'ZnVsbC1zb3VyY2U=',
        width: 1920,
        height: 1080,
      },
      normalizedImage: {
        jpegBase64: 'bGFiZWwtY3JvcA==',
        width: 630,
        height: 280,
      },
    });
    // Two distinct blobs must be uploaded for slabs: the full source capture and the
    // narrow label crop. If these collapse to the same base64 payload, GCS ends up with
    // duplicate artifacts instead of capture + normalized.
    expect(artifactRequestBody.sourceImage.jpegBase64).not.toBe(artifactRequestBody.normalizedImage.jpegBase64);
    expect(artifactUpload).toMatchObject({
      status: 'uploaded',
      storage: 'filesystem',
      sourceObjectPath: `scans/2026/05/03/${matchRequestBody.scanID}/source_capture.jpg`,
      normalizedObjectPath: `scans/2026/05/03/${matchRequestBody.scanID}/normalized_target.jpg`,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('fires the slab scan-artifact upload in parallel with the match request', async () => {
    // Reproduces the staging bug where 40-50s slab match latency means the chained
    // upload never fires before the user backgrounds the app. The upload must kick off
    // independently of (and not wait on) the match response.
    let resolveMatchHold: () => void = () => {};
    const matchHold = new Promise<void>((resolve) => {
      resolveMatchHold = resolve;
    });

    let artifactCalledAt: number | null = null;
    let matchResponseSentAt: number | null = null;

    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://example.test/api/v1/scan/match')) {
        const matchRequestBody = JSON.parse(String(init?.body ?? '{}'));
        // Block the match response until we explicitly resolve it. This simulates the
        // slow slab match path on staging. The artifact upload must NOT depend on this.
        await matchHold;
        matchResponseSentAt = Date.now();
        return jsonResponse(200, {
          scanID: matchRequestBody.scanID,
          resolverMode: 'psa_slab',
          topCandidates: [],
        });
      }

      if (url.startsWith('http://example.test/api/v1/scan-artifacts')) {
        artifactCalledAt = Date.now();
        const artifactRequestBody = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse(202, {
          scanID: artifactRequestBody.scanID,
          enabled: true,
          storage: 'filesystem',
          uploadedAt: '2026-05-03T12:00:00Z',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    let resolveUpload: (value: ScannerArtifactUploadResult | null) => void = () => {};
    const uploadComplete = new Promise<ScannerArtifactUploadResult | null>((resolve) => {
      resolveUpload = resolve;
    });

    const matchPromise = repository.matchScannerCapture({
      mode: 'slabs',
      jpegBase64: 'bGFiZWwtY3JvcA==',
      width: 630,
      height: 280,
      captureSource: 'camera',
      submittedAt: '2026-05-03T12:00:00Z',
      sourceImage: {
        jpegBase64: 'ZnVsbC1zb3VyY2U=',
        width: 1920,
        height: 1080,
      },
      normalizedImage: {
        jpegBase64: 'bGFiZWwtY3JvcA==',
        width: 630,
        height: 280,
      },
    }, {
      onArtifactUploadComplete: resolveUpload,
    });

    // The upload must complete while the match request is still pending - that's the
    // whole point of the parallel-firing fix.
    await uploadComplete;
    const observedArtifactAt = artifactCalledAt;
    if (observedArtifactAt === null) {
      throw new Error('artifact upload was not fired before the match resolved');
    }
    expect(matchResponseSentAt).toBeNull();

    // Unblock the match response and complete the call.
    resolveMatchHold();
    await matchPromise;
    const observedMatchAt = matchResponseSentAt;
    if (observedMatchAt === null) {
      throw new Error('match request never resolved');
    }
    expect(observedArtifactAt).toBeLessThanOrEqual(observedMatchAt);
  });

  it('times out unreachable backend requests instead of hanging forever', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const abort = () => {
          const error = new Error('Request aborted');
          error.name = 'AbortError';
          reject(error);
        };

        if (signal?.aborted) {
          abort();
          return;
        }

        signal?.addEventListener('abort', abort, { once: true });
      });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const loadPromise = repository.loadInventoryEntries();

    await jest.advanceTimersByTimeAsync(12000);

    await expect(loadPromise).resolves.toMatchObject({
      state: 'error',
      data: [],
      errorMessage: 'Request timed out while contacting the Spotlight backend.',
    });
  });

  it('uses a longer timeout budget for scanner match requests', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const abort = () => {
          const error = new Error('Request aborted');
          error.name = 'AbortError';
          reject(error);
        };

        if (signal?.aborted) {
          abort();
          return;
        }

        signal?.addEventListener('abort', abort, { once: true });
      });
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const matchPromise = repository.matchScannerCapture({
      height: 880,
      jpegBase64: 'bW9jay1zY2Fu',
      mode: 'raw',
      width: 630,
    });
    const capturedRejection = matchPromise.catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(19000);
    await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);

    await expect(capturedRejection).resolves.toMatchObject({
      kind: 'request_failed',
      message: 'Request timed out while contacting the Spotlight backend.',
    });
  });

  it('falls back to a secondary backend base URL and promotes it after a successful retry', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('http://bad.local:8788')) {
        throw new Error('backend offline');
      }

      if (url.startsWith('http://192.168.1.146:8788/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }

      if (url.startsWith('http://192.168.1.146:8788/api/v1/portfolio/history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          summary: {
            currentValue: 0,
            deltaValue: 0,
            deltaPercent: 0,
          },
          points: [],
        });
      }

      if (url.startsWith('http://192.168.1.146:8788/api/v1/portfolio/ledger')) {
        return jsonResponse(200, {
          transactions: [],
          dailySeries: [],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository([
      'http://bad.local:8788',
      'http://192.168.1.146:8788',
    ]);

    await expect(repository.getPortfolioDashboard()).resolves.toMatchObject({
      inventoryCount: 0,
      inventoryItems: [],
      recentSales: [],
    });

    const fetchCallsAfterDashboard = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));
    expect(fetchCallsAfterDashboard.some((url) => url.startsWith('http://bad.local:8788/api/v1/deck/entries'))).toBe(true);
    expect(fetchCallsAfterDashboard.some((url) => url.startsWith('http://192.168.1.146:8788/api/v1/deck/entries'))).toBe(true);

    (global.fetch as jest.Mock).mockClear();

    await repository.getInventoryEntries();

    expect((global.fetch as jest.Mock).mock.calls[0]?.[0]).toBe('http://192.168.1.146:8788/api/v1/deck/entries');
  });

  it('keeps date-only dashboard labels aligned to the actual range endpoints and slices 1Y separately from ALL', async () => {
    const allDates = dateSequence('2025-04-22', 370);
    const historyPointsByRange = {
      '1W': dateSequence('2026-04-20', 7),
      '30D': dateSequence('2026-03-28', 30),
      '90D': dateSequence('2026-01-27', 90),
      '1Y': dateSequence('2025-04-27', 365),
      ALL: allDates,
    } as const;

    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }

      if (url.includes('/api/v1/portfolio/history')) {
        const parsedUrl = new URL(url);
        const range = parsedUrl.searchParams.get('range') as keyof typeof historyPointsByRange;
        const dates = historyPointsByRange[range];
        return jsonResponse(200, {
          currencyCode: 'USD',
          summary: {
            currentValue: dates.length,
            deltaValue: 0,
            deltaPercent: 0,
          },
          points: dates.map((date, index) => ({
            date,
            totalValue: index + 1,
          })),
        });
      }

      if (url.includes('/api/v1/portfolio/ledger')) {
        const parsedUrl = new URL(url);
        const range = parsedUrl.searchParams.get('range') as keyof typeof historyPointsByRange;
        const dates = historyPointsByRange[range];
        return jsonResponse(200, {
          currencyCode: 'USD',
          transactions: [],
          dailySeries: dates.map((date, index) => ({
            date,
            revenue: index % 7 === 0 ? 10 : 0,
            sellCount: index % 7 === 0 ? 2 : 0,
          })),
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const dashboard = await repository.getPortfolioDashboard();

    expect(dashboard.ranges['1W'].portfolio[0]?.shortLabel).toBe('Apr 20');
    expect(dashboard.ranges['1W'].portfolio[dashboard.ranges['1W'].portfolio.length - 1]?.shortLabel).toBe('Apr 26');
    expect(dashboard.ranges['1W'].sales[0]?.shortLabel).toBe('Apr 20');
    expect(dashboard.ranges['1W'].sales[dashboard.ranges['1W'].sales.length - 1]?.shortLabel).toBe('Apr 26');
    expect(dashboard.ranges['1W'].sales[0]?.salesCount).toBe(2);
    expect(dashboard.ranges['1W'].sales[1]?.salesCount).toBe(0);
    expect(dashboard.ranges['1M'].sales).toHaveLength(30);
    expect(dashboard.ranges['1M'].sales[0]?.shortLabel).toBe('Mar 28');
    expect(dashboard.ranges['1M'].sales[dashboard.ranges['1M'].sales.length - 1]?.shortLabel).toBe('Apr 26');
    expect(dashboard.ranges['3M'].sales).toHaveLength(13);
    expect(dashboard.ranges['3M'].sales[0]?.shortLabel).toBe('Jan 27 - Feb 1');
    expect(dashboard.ranges['3M'].sales[dashboard.ranges['3M'].sales.length - 1]?.shortLabel).toBe('Apr 20 - Apr 26');

    expect(dashboard.ranges.ALL.portfolio).toHaveLength(370);
    expect(dashboard.ranges['1Y'].portfolio).toHaveLength(365);
    expect(dashboard.ranges['1Y'].portfolio[0]?.isoDate).toBe('2025-04-27');
    expect(dashboard.ranges['1Y'].portfolio[dashboard.ranges['1Y'].portfolio.length - 1]?.isoDate).toBe('2026-04-26');
    expect(dashboard.ranges['1Y'].sales).toHaveLength(13);
    expect(dashboard.ranges['1Y'].sales[0]?.shortLabel).toBe('Apr 2025');
    expect(dashboard.ranges['1Y'].sales[dashboard.ranges['1Y'].sales.length - 1]?.shortLabel).toBe('Apr 2026');
    expect(dashboard.ranges['1Y'].sales[0]?.salesCount).toBe(2);
    expect(dashboard.ranges.ALL.sales).toHaveLength(13);
    expect(dashboard.ranges.ALL.sales[0]?.shortLabel).toBe('Apr 2025');
    expect(dashboard.ranges.ALL.sales[dashboard.ranges.ALL.sales.length - 1]?.shortLabel).toBe('Apr 2026');
  });

  describe('getCardMarketHistory condition encoding', () => {
    function captureMarketHistoryCalls() {
      const calls: string[] = [];
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        calls.push(url);
        return jsonResponse(200, {
          currencyCode: 'USD',
          currentPrice: 1.0,
          points: [],
          availableVariants: [],
          availableConditions: [],
        });
      }) as typeof fetch;
      return calls;
    }

    it.each([
      ['near_mint', 'NM'],
      ['lightly_played', 'LP'],
      ['moderately_played', 'MP'],
      ['heavily_played', 'HP'],
      ['damaged', 'DM'],
    ])('translates frontend condition code %s to backend short code %s', async (input, expected) => {
      const calls = captureMarketHistoryCalls();
      const repository = new HttpSpotlightRepository('http://example.test');

      await repository.getCardMarketHistory({ cardId: 'sm7-1', condition: input });

      expect(calls).toHaveLength(1);
      const queryString = calls[0]?.split('?')[1] ?? '';
      const params = new URLSearchParams(queryString);
      expect(params.get('condition')).toBe(expected);
    });

    it('passes already-short condition codes through unchanged', async () => {
      const calls = captureMarketHistoryCalls();
      const repository = new HttpSpotlightRepository('http://example.test');

      await repository.getCardMarketHistory({ cardId: 'sm7-1', condition: 'LP' });

      const params = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
      expect(params.get('condition')).toBe('LP');
    });

    it('omits the condition param when none is provided for a slab query', async () => {
      const calls = captureMarketHistoryCalls();
      const repository = new HttpSpotlightRepository('http://example.test');

      await repository.getCardMarketHistory({
        cardId: 'sm7-1',
        slabContext: { grader: 'PSA', grade: '9' },
      });

      const params = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
      expect(params.get('condition')).toBeNull();
    });

    it('falls back to NM when no condition is provided for a raw query', async () => {
      const calls = captureMarketHistoryCalls();
      const repository = new HttpSpotlightRepository('http://example.test');

      await repository.getCardMarketHistory({ cardId: 'sm7-1' });

      const params = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
      expect(params.get('condition')).toBe('NM');
    });
  });

  describe('markSalePaid', () => {
    it('POSTs to /api/v1/sales/{saleID}/mark-paid and returns the parsed lifecycle payload', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(200, {
          saleID: 'sale:abc',
          paidAt: '2026-05-17T12:00:00Z',
          voidedAt: null,
          status: 'paid',
          remainingQuantity: 0,
        }),
      ) as typeof fetch;
      global.fetch = fetchMock;
      const repository = new HttpSpotlightRepository('http://example.test');

      const result = await repository.markSalePaid('sale:abc');

      const [url, init] = (fetchMock as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://example.test/api/v1/sales/sale%3Aabc/mark-paid');
      expect(init.method).toBe('POST');
      expect(result.status).toBe('paid');
      expect(result.paidAt).toBe('2026-05-17T12:00:00Z');
    });
  });

  describe('voidSale', () => {
    it('POSTs to /api/v1/sales/{saleID}/void and returns the parsed lifecycle payload', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(200, {
          saleID: 'sale:abc',
          paidAt: null,
          voidedAt: '2026-05-17T12:00:00Z',
          status: 'voided',
        }),
      ) as typeof fetch;
      global.fetch = fetchMock;
      const repository = new HttpSpotlightRepository('http://example.test');

      const result = await repository.voidSale('sale:abc');

      const [url, init] = (fetchMock as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://example.test/api/v1/sales/sale%3Aabc/void');
      expect(init.method).toBe('POST');
      expect(result.status).toBe('voided');
      expect(result.voidedAt).toBe('2026-05-17T12:00:00Z');
    });
  });

  describe('vendor wallet handles', () => {
    const handlesFixture = {
      venmoHandle: 'stephen-chan',
      cashappHandle: null,
      paypalMeSlug: null,
      zelleEmailOrPhone: null,
      updatedAt: '2026-05-17T12:00:00Z',
    };

    it('GETs /api/v1/vendor/wallet-handles', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, handlesFixture)) as typeof fetch;
      global.fetch = fetchMock;
      const repository = new HttpSpotlightRepository('http://example.test');

      const result = await repository.getVendorWalletHandles();

      const [url] = (fetchMock as jest.Mock).mock.calls[0] as [string, RequestInit | undefined];
      expect(url).toBe('http://example.test/api/v1/vendor/wallet-handles');
      expect(result.venmoHandle).toBe('stephen-chan');
    });

    it('POSTs partial updates to /api/v1/vendor/wallet-handles', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, handlesFixture)) as typeof fetch;
      global.fetch = fetchMock;
      const repository = new HttpSpotlightRepository('http://example.test');

      const result = await repository.updateVendorWalletHandles({
        venmoHandle: 'stephen-chan',
      });

      const [url, init] = (fetchMock as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://example.test/api/v1/vendor/wallet-handles');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ venmoHandle: 'stephen-chan' });
      expect(result.venmoHandle).toBe('stephen-chan');
    });
  });
});
