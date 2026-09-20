import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
} from '../../../../packages/api-client/src/spotlight/repository';

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

function mockFetch(...responses: Response[]) {
  const fetchMock = jest.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const alertPayload = {
  id: 'a1b2',
  cardID: 'gym1-60',
  cardName: "Sabrina's Slowbro",
  imageUrl: 'https://img.test/small.png',
  listingID: 'v1|1|0',
  kind: 'under_added',
  totalCents: 7000,
  baselineCents: 9000,
  marketCents: 9000,
  discountPct: 22.22,
  savingsCents: 2000,
  url: 'https://www.ebay.com/itm/1',
  verificationTier: 'title',
  createdAt: '2026-09-18T00:00:00.000Z',
  seenAt: null,
  tappedAt: null,
};

describe('HttpSpotlightRepository deal alerts', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('normalizes a deal-alerts page and maps the wire ID casing', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { alerts: [alertPayload], limit: 50, unseenCount: 7 }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const page = await repository.listDealAlerts();

    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/deal-alerts?limit=50');
    expect(page.limit).toBe(50);
    // ALL-TIME unseen count, not a count of the page.
    expect(page.unseenCount).toBe(7);
    expect(page.alerts).toEqual([
      {
        id: 'a1b2',
        cardId: 'gym1-60',
        cardName: "Sabrina's Slowbro",
        imageUrl: 'https://img.test/small.png',
        listingId: 'v1|1|0',
        kind: 'under_added',
        totalCents: 7000,
        baselineCents: 9000,
        marketCents: 9000,
        discountPct: 22.22,
        savingsCents: 2000,
        url: 'https://www.ebay.com/itm/1',
        verificationTier: 'title',
        createdAt: '2026-09-18T00:00:00.000Z',
        seenAt: null,
        tappedAt: null,
      },
    ]);
  });

  it('clamps the requested limit to the backend range', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { alerts: [], limit: 200, unseenCount: 0 }));
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.listDealAlerts(9999);

    expect(fetchMock.mock.calls[0][0]).toContain('limit=200');
  });

  it('drops malformed alert rows instead of throwing', async () => {
    mockFetch(
      jsonResponse(200, {
        alerts: [
          null,
          'nope',
          { cardID: 'gym1-60' }, // no id → unstampable, dropped
          { ...alertPayload, id: 'keeps-me', kind: 'a_kind_we_never_shipped' },
        ],
        limit: 'not-a-number',
        unseenCount: null,
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const page = await repository.listDealAlerts(25);

    expect(page.alerts).toHaveLength(1);
    expect(page.alerts[0].id).toBe('keeps-me');
    // An unknown kind still renders, generically.
    expect(page.alerts[0].kind).toBe('under_added');
    expect(page.limit).toBe(25);
    expect(page.unseenCount).toBe(0);
  });

  it('degrades a partial alert to safe defaults', async () => {
    mockFetch(jsonResponse(200, { alerts: [{ id: 'bare' }] }));
    const repository = new HttpSpotlightRepository('http://example.test');

    const page = await repository.listDealAlerts();

    expect(page.alerts[0]).toEqual({
      id: 'bare',
      cardId: '',
      // Both nullable: an older server, or a card row the join could not resolve.
      cardName: null,
      imageUrl: null,
      listingId: '',
      kind: 'under_added',
      totalCents: 0,
      baselineCents: 0,
      marketCents: null,
      discountPct: null,
      savingsCents: null,
      url: null,
      verificationTier: null,
      createdAt: null,
      seenAt: null,
      tappedAt: null,
    });
  });

  it('returns an empty page when the request fails', async () => {
    mockFetch(jsonResponse(500, { error: 'boom' }));
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.listDealAlerts(10)).resolves.toEqual({
      alerts: [],
      limit: 10,
      unseenCount: 0,
    });
  });

  it('stamps seen and tapped on the right routes', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { ...alertPayload, seenAt: '2026-09-18T01:00:00.000Z' }),
      jsonResponse(200, { ...alertPayload, tappedAt: '2026-09-18T02:00:00.000Z' }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const seen = await repository.markDealAlertSeen('a1b2');
    const tapped = await repository.markDealAlertTapped('a1b2');

    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/deal-alerts/a1b2/seen');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/v1/deal-alerts/a1b2/tapped');
    expect(seen?.seenAt).toBe('2026-09-18T01:00:00.000Z');
    expect(tapped?.tappedAt).toBe('2026-09-18T02:00:00.000Z');
  });

  it('returns null for an unknown (or another owner\'s) alert id', async () => {
    mockFetch(jsonResponse(404, { error: 'Alert not found' }));
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.markDealAlertSeen('nope')).resolves.toBeNull();
  });

  it('does not call the backend for a blank alert id', async () => {
    const fetchMock = mockFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.markDealAlertTapped('   ')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HttpSpotlightRepository watchlist target', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('PUTs integer cents and normalizes the response', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, {
        cardID: 'gym1-60',
        targetPriceCents: 8000,
        targetCurrency: 'USD',
        targetSetAt: '2026-09-18T00:00:00.000Z',
        targetTriggeredAt: null,
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.setCardFavoriteTarget('gym1-60', 8000.4);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/card-favorites/gym1-60/target');
    expect(init.method).toBe('PUT');
    // Rounded to an integer: the server rejects anything that isn't an int.
    expect(JSON.parse(String(init.body))).toEqual({ targetPriceCents: 8000 });
    expect(result).toEqual({
      status: 'ok',
      target: {
        cardId: 'gym1-60',
        targetPriceCents: 8000,
        targetCurrency: 'USD',
        targetSetAt: '2026-09-18T00:00:00.000Z',
        targetTriggeredAt: null,
      },
    });
  });

  it('sends null to clear a target', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, {
        cardID: 'gym1-60',
        targetPriceCents: null,
        targetCurrency: null,
        targetSetAt: null,
        targetTriggeredAt: null,
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.setCardFavoriteTarget('gym1-60', null);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ targetPriceCents: null });
    expect(result.target?.targetPriceCents).toBeNull();
  });

  it('surfaces the "not on the watchlist" 404 distinctly from a failure', async () => {
    mockFetch(jsonResponse(404, { error: 'Watchlist card not found' }));
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.setCardFavoriteTarget('gym1-60', 8000)).resolves.toEqual({
      status: 'not_watchlisted',
      target: null,
    });
  });

  it('reports a transport failure as failed, not as not_watchlisted', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.setCardFavoriteTarget('gym1-60', 8000)).resolves.toEqual({
      status: 'failed',
      target: null,
    });
  });
});

describe('HttpSpotlightRepository raw eBay listing candidates', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const candidatePayload = {
    itemID: 'v1|1|0',
    title: 'Blaine\'s Charizard 2/132 Gym Challenge',
    itemURL: 'https://www.ebay.com/itm/1',
    imageURL: 'https://i.ebayimg.com/1.jpg',
    priceAmount: 70.0,
    shippingAmount: 0.0,
    shippingKnown: true,
    totalAmount: 70.0,
    currencyCode: 'usd',
    buyingOption: 'fixed_price',
    auctionEndAt: null,
    auctionMinutesRemaining: null,
    verification: 'title',
    isGraded: false,
  };

  it('normalizes candidates and forwards limit + variant', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, {
        cardID: 'gym1-60',
        source: 'ebay',
        lane: 'raw',
        status: 'available',
        statusReason: null,
        cached: true,
        variant: '1st Edition',
        listings: [{}, {}, {}],
        listingCount: 3,
        candidates: [candidatePayload],
        candidateCount: 1,
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.getRawEbayListingCandidates({
      cardId: 'gym1-60',
      limit: 5,
      variant: '1st Edition',
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v1/cards/gym1-60/ebay/raw-listings');
    expect(url).toContain('limit=5');
    expect(url).toContain('variant=1st+Edition');
    expect(result.status).toBe('available');
    expect(result.cached).toBe(true);
    expect(result.listingCount).toBe(3);
    expect(result.candidateCount).toBe(1);
    expect(result.candidates).toEqual([
      {
        itemId: 'v1|1|0',
        title: 'Blaine\'s Charizard 2/132 Gym Challenge',
        itemUrl: 'https://www.ebay.com/itm/1',
        imageUrl: 'https://i.ebayimg.com/1.jpg',
        priceDollars: 70,
        shippingDollars: 0,
        shippingKnown: true,
        totalDollars: 70,
        currencyCode: 'USD',
        buyingOption: 'fixed_price',
        auctionEndAt: null,
        auctionMinutesRemaining: null,
        verification: 'title',
        isGraded: false,
      },
    ]);
    // The unvalidated `listings` page is deliberately not exposed.
    expect(result).not.toHaveProperty('listings');
  });

  it('drops malformed candidates and falls back on missing counts', async () => {
    mockFetch(
      jsonResponse(200, {
        cardID: 'gym1-60',
        status: 'available',
        candidates: [null, { itemID: 'no-title' }, candidatePayload],
        listings: [{}, {}],
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.getRawEbayListingCandidates({ cardId: 'gym1-60' });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidateCount).toBe(1);
    expect(result.listingCount).toBe(2);
  });

  it('reads an auction candidate without inventing a fixed price', async () => {
    mockFetch(
      jsonResponse(200, {
        cardID: 'gym1-60',
        status: 'available',
        candidates: [
          {
            ...candidatePayload,
            buyingOption: 'AUCTION',
            auctionEndAt: '2026-09-18T03:00:00.000Z',
            auctionMinutesRemaining: 12.5,
            shippingAmount: null,
            shippingKnown: false,
            totalAmount: 70,
          },
        ],
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.getRawEbayListingCandidates({ cardId: 'gym1-60' });

    expect(result.candidates[0].buyingOption).toBe('auction');
    expect(result.candidates[0].auctionMinutesRemaining).toBe(12.5);
    // Shipping unknown → the total is the item price alone, and says so.
    expect(result.candidates[0].shippingKnown).toBe(false);
    expect(result.candidates[0].shippingDollars).toBeNull();
  });

  it('turns an unavailable lane into an empty, non-error response', async () => {
    mockFetch(
      jsonResponse(200, {
        cardID: 'gym1-60',
        status: 'unavailable',
        statusReason: 'ebay_disabled',
        unavailableReason: 'ebay_disabled',
        listings: [],
        listingCount: 0,
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.getRawEbayListingCandidates({ cardId: 'gym1-60' });

    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBe('ebay_disabled');
    expect(result.candidates).toEqual([]);
  });

  it('never throws on a transport failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.getRawEbayListingCandidates({ cardId: 'gym1-60' });

    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBe('request_failed');
    expect(result.candidates).toEqual([]);
  });

  it('reports a 404 card distinctly in the unavailable reason', async () => {
    mockFetch(jsonResponse(404, { error: 'Card not found' }));
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.getRawEbayListingCandidates({ cardId: 'gym1-60' });

    expect(result.unavailableReason).toBe('card_not_found');
  });
});

describe('HttpSpotlightRepository access status deal-radar flag', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('fails OPEN when the backend omits watchDealRadarEnabled', async () => {
    mockFetch(
      jsonResponse(200, {
        accessOpen: true,
        allowed: true,
        isAdmin: false,
        showMode: { active: false, until: null, remainingSeconds: 0 },
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getAccessStatus()).resolves.toMatchObject({
      watchDealRadarEnabled: true,
    });
  });

  it('fails OPEN when the access request errors', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getAccessStatus()).resolves.toMatchObject({
      watchDealRadarEnabled: true,
    });
  });

  it('honours an explicit false, and a non-boolean still fails open', async () => {
    mockFetch(
      jsonResponse(200, {
        accessOpen: true,
        allowed: true,
        isAdmin: false,
        showMode: { active: false, until: null, remainingSeconds: 0 },
        watchDealRadarEnabled: false,
      }),
      jsonResponse(200, {
        accessOpen: true,
        allowed: true,
        isAdmin: false,
        showMode: { active: false, until: null, remainingSeconds: 0 },
        watchDealRadarEnabled: 'nope',
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getAccessStatus()).resolves.toMatchObject({
      watchDealRadarEnabled: false,
    });
    await expect(repository.getAccessStatus()).resolves.toMatchObject({
      watchDealRadarEnabled: true,
    });
  });
});

describe('HttpSpotlightRepository card favorites target field', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('carries targetPriceCents through, and nulls a malformed one', async () => {
    mockFetch(
      jsonResponse(200, {
        entries: [
          { card: { id: 'gym1-60', name: 'Charizard' }, targetPriceCents: 8000 },
          { card: { id: 'gym1-61', name: 'Blastoise' }, targetPriceCents: 'soon' },
          { card: { id: 'gym1-62', name: 'Venusaur' } },
        ],
      }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    const entries = await repository.getCardFavorites();

    expect(entries.map((entry) => entry.targetPriceCents)).toEqual([8000, null, null]);
  });
});

describe('MockSpotlightRepository deal radar', () => {
  it('serves the seeded alerts newest first with an all-time unseen count', async () => {
    const repository = new MockSpotlightRepository();

    const page = await repository.listDealAlerts();

    expect(page.alerts.length).toBeGreaterThan(1);
    expect(page.alerts[0].createdAt! >= page.alerts[1].createdAt!).toBe(true);
    expect(page.unseenCount).toBe(1);
  });

  it('counts unseen across ALL alerts, not just the returned page', async () => {
    const repository = new MockSpotlightRepository();

    const page = await repository.listDealAlerts(1);

    expect(page.alerts).toHaveLength(1);
    expect(page.limit).toBe(1);
    expect(page.unseenCount).toBe(1);
  });

  it('stamps seen/tapped once and never moves the first timestamp', async () => {
    const repository = new MockSpotlightRepository();
    const [alert] = (await repository.listDealAlerts()).alerts;

    const first = await repository.markDealAlertSeen(alert.id);
    const second = await repository.markDealAlertSeen(alert.id);
    const tappedFirst = await repository.markDealAlertTapped(alert.id);
    const tappedSecond = await repository.markDealAlertTapped(alert.id);

    expect(first?.seenAt).not.toBeNull();
    expect(second?.seenAt).toBe(first?.seenAt);
    expect(tappedSecond?.tappedAt).toBe(tappedFirst?.tappedAt);
    expect((await repository.listDealAlerts()).unseenCount).toBe(0);
  });

  it('returns null for an unknown alert id', async () => {
    const repository = new MockSpotlightRepository();

    await expect(repository.markDealAlertSeen('nope')).resolves.toBeNull();
  });

  it('refuses a target on a card that is not watchlisted', async () => {
    const repository = new MockSpotlightRepository();

    await expect(repository.setCardFavoriteTarget('mcdonalds25-21', 8000)).resolves.toEqual({
      status: 'not_watchlisted',
      target: null,
    });
  });

  it('keeps targetTriggeredAt on a re-send and clears it on a change', async () => {
    const repository = new MockSpotlightRepository();
    await repository.setCardFavorite('mcdonalds25-21', true);

    const set = await repository.setCardFavoriteTarget('mcdonalds25-21', 8000);
    expect(set.status).toBe('ok');
    expect(set.target?.targetCurrency).toBe('USD');

    const resent = await repository.setCardFavoriteTarget('mcdonalds25-21', 8000);
    expect(resent.target?.targetTriggeredAt).toBeNull();

    const changed = await repository.setCardFavoriteTarget('mcdonalds25-21', 7000);
    expect(changed.target?.targetPriceCents).toBe(7000);
    expect(changed.target?.targetTriggeredAt).toBeNull();

    const cleared = await repository.setCardFavoriteTarget('mcdonalds25-21', null);
    expect(cleared.target).toEqual({
      cardId: 'mcdonalds25-21',
      targetPriceCents: null,
      targetCurrency: null,
      targetSetAt: null,
      targetTriggeredAt: null,
    });
  });

  it('exposes the target on the favorites list', async () => {
    const repository = new MockSpotlightRepository();
    await repository.setCardFavorite('mcdonalds25-21', true);
    await repository.setCardFavoriteTarget('mcdonalds25-21', 8000);

    const entries = await repository.getCardFavorites();

    expect(entries.find((entry) => entry.cardId === 'mcdonalds25-21')?.targetPriceCents).toBe(8000);
  });

  it('serves cheapest-total-first candidates for a known card', async () => {
    const repository = new MockSpotlightRepository();

    const result = await repository.getRawEbayListingCandidates({ cardId: 'mcdonalds25-21' });

    expect(result.status).toBe('available');
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidateCount).toBe(result.candidates.length);
    const totals = result.candidates.map((candidate) => candidate.totalDollars ?? 0);
    expect([...totals].sort((left, right) => left - right)).toEqual(totals);
  });

  it('reports an unknown card as unavailable rather than throwing', async () => {
    const repository = new MockSpotlightRepository();

    const result = await repository.getRawEbayListingCandidates({ cardId: 'not-a-card' });

    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBe('card_not_found');
    expect(result.candidates).toEqual([]);
  });

  it('reports the deal radar as enabled', async () => {
    const repository = new MockSpotlightRepository();

    await expect(repository.getAccessStatus()).resolves.toMatchObject({
      watchDealRadarEnabled: true,
    });
  });
});
