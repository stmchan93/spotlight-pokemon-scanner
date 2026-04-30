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

      if (url.includes('/api/v1/cards/sm7-1/ebay-comps')) {
        return jsonResponse(200, {
          status: 'available',
          transactions: [],
          transactionCount: 0,
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

  it('maps eBay listings into the card detail payload', async () => {
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

      if (url.includes('/api/v1/cards/sm7-1/ebay-comps')) {
        return jsonResponse(200, {
          status: 'available',
          statusReason: null,
          transactionCount: 1,
          searchURL: 'https://www.ebay.com/sch/i.html?_nkw=Treecko',
          transactions: [
            {
              id: 'ebay:v1|123|0',
              title: 'Treecko raw Pokemon card',
              saleType: 'fixed_price',
              listingDate: '2026-04-25',
              price: {
                amount: 1.99,
                currencyCode: 'USD',
              },
              listingURL: 'https://www.ebay.com/itm/123',
            },
          ],
        });
      }

      if (url.includes('/api/v1/cards/sm7-1')) {
        return jsonResponse(200, {
          imageSmallURL: 'https://cdn.example/sm7-1-small.png',
          imageLargeURL: 'https://cdn.example/sm7-1-large.png',
          card: {
            id: 'sm7-1',
            name: 'Treecko',
            setName: 'Celestial Storm',
            number: '1',
            imageSmallURL: 'https://cdn.example/sm7-1-small.png',
            imageLargeURL: 'https://cdn.example/sm7-1-large.png',
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

    expect(detail?.ebayListings).toMatchObject({
      status: 'available',
      listingCount: 1,
      searchUrl: 'https://www.ebay.com/sch/i.html?_nkw=Treecko',
    });
    expect(detail?.ebayListings?.listings[0]).toMatchObject({
      title: 'Treecko raw Pokemon card',
      saleType: 'fixed_price',
      priceAmount: 1.99,
      currencyCode: 'USD',
      listingUrl: 'https://www.ebay.com/itm/123',
    });
  });

  it('sorts eBay listings by ascending price before returning them to the UI', async () => {
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

      if (url.includes('/api/v1/cards/sm7-1/ebay-comps')) {
        return jsonResponse(200, {
          status: 'available',
          transactions: [
            {
              id: 'ebay:v1|123|0',
              title: 'Treecko listing 21.99',
              listingDate: '2026-04-25',
              price: {
                amount: 21.99,
                currencyCode: 'USD',
              },
              listingURL: 'https://www.ebay.com/itm/123',
            },
            {
              id: 'ebay:v1|124|0',
              title: 'Treecko listing 90.00',
              listingDate: '2026-04-25',
              price: {
                amount: 90,
                currencyCode: 'USD',
              },
              listingURL: 'https://www.ebay.com/itm/124',
            },
            {
              id: 'ebay:v1|125|0',
              title: 'Treecko listing 1.00',
              listingDate: '2026-04-25',
              price: {
                amount: 1,
                currencyCode: 'USD',
              },
              listingURL: 'https://www.ebay.com/itm/125',
            },
          ],
        });
      }

      if (url.includes('/api/v1/cards/sm7-1')) {
        return jsonResponse(200, {
          imageSmallURL: 'https://cdn.example/sm7-1-small.png',
          imageLargeURL: 'https://cdn.example/sm7-1-large.png',
          card: {
            id: 'sm7-1',
            name: 'Treecko',
            setName: 'Celestial Storm',
            number: '1',
            imageSmallURL: 'https://cdn.example/sm7-1-small.png',
            imageLargeURL: 'https://cdn.example/sm7-1-large.png',
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

    expect(detail?.ebayListings?.listings.map((listing) => listing.priceAmount)).toEqual([1, 21.99, 90]);
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

  it('preserves the eBay search URL when active listings are disabled by the backend', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/sv4-199/ebay-comps')) {
        return jsonResponse(200, {
          status: 'unavailable',
          statusReason: 'browse_disabled',
          unavailableReason: 'eBay active listings are disabled in this environment.',
          transactions: [],
          transactionCount: 0,
          searchURL: 'https://www.ebay.com/sch/i.html?_nkw=Groudon+Paradox+Rift+199%2F182',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const listings = await repository.getCardEbayListings({ cardId: 'sv4-199', limit: 5 });
    const requestedUrl = new URL(String((global.fetch as jest.Mock).mock.calls[0]?.[0]));

    expect(requestedUrl?.searchParams.get('limit')).toBe('5');
    expect(listings).toMatchObject({
      status: 'unavailable',
      statusReason: 'browse_disabled',
      listingCount: 0,
      searchUrl: 'https://www.ebay.com/sch/i.html?_nkw=Groudon+Paradox+Rift+199%2F182',
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

    await jest.advanceTimersByTimeAsync(6000);

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

    await jest.advanceTimersByTimeAsync(9000);
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
      '7D': dateSequence('2026-04-20', 7),
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

    expect(dashboard.ranges['7D'].portfolio[0]?.shortLabel).toBe('Apr 20');
    expect(dashboard.ranges['7D'].portfolio[dashboard.ranges['7D'].portfolio.length - 1]?.shortLabel).toBe('Apr 26');
    expect(dashboard.ranges['7D'].sales[0]?.shortLabel).toBe('Apr 20');
    expect(dashboard.ranges['7D'].sales[dashboard.ranges['7D'].sales.length - 1]?.shortLabel).toBe('Apr 26');
    expect(dashboard.ranges['7D'].sales[0]?.salesCount).toBe(2);
    expect(dashboard.ranges['7D'].sales[1]?.salesCount).toBe(0);
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
});
