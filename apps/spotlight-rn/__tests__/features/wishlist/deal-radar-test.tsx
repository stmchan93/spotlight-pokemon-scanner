import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry, DealAlert, DealAlertsPage } from '@spotlight/api-client';

import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

let mockIsFocused = true;
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => mockIsFocused,
}));

jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({
    ensureGuestSession: jest.fn(),
    gate: (fn: () => void) => fn,
    isGuest: false,
    openLogin: jest.fn(),
  }),
}));

// The deal radar is gated on an access-gate flag that FAILS OPEN. The provider
// wraps the whole app at runtime; here the status is supplied directly.
let mockAccessStatus: { watchDealRadarEnabled?: boolean } | null = null;
jest.mock('@/features/auth/access-gate-provider', () => ({
  useAccessGate: () => ({ refresh: jest.fn(), state: 'allowed', status: mockAccessStatus }),
}));

jest.mock('@/features/social/dm-service', () => ({
  fetchConversations: jest.fn(async () => [
    {
      id: 'conversation-1',
      isGroup: false,
      lastMessageAt: null,
      lastMessagePreview: null,
      otherUser: {
        avatarUrl: null,
        displayName: 'Misty',
        handle: 'misty',
        isVerified: false,
      },
      otherUserId: 'recipient-1',
    },
  ]),
  findOrCreateDm: jest.fn(async () => 'conversation-1'),
  sendMessage: jest.fn(async () => true),
}));
jest.mock('@/features/profile/profile-service', () => ({
  searchUsers: jest.fn(async () => []),
}));

// The shared iconoir mock covers a fixed icon list; the band and header pull
// names outside it, which would otherwise render as `undefined`.
jest.mock('iconoir-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');

  const make = (name: string) => {
    const Component = (props: Record<string, unknown>) =>
      React.createElement(View, { ...props, testID: props.testID ?? `iconoir-${name}` });
    Component.displayName = `MockIconoir(${name})`;
    return Component;
  };

  return new Proxy({}, { get: (_target, prop: string) => make(String(prop)) });
});

function buildFavoriteEntry(
  overrides: Partial<CardFavoriteEntry> & Pick<CardFavoriteEntry, 'cardId' | 'name'>,
): CardFavoriteEntry {
  return {
    cardNumber: '#004/102',
    currencyCode: 'USD',
    favoritedAt: '2026-05-01T00:00:00.000Z',
    imageUrl: 'https://example.com/card.png',
    isOwned: false,
    largeImageUrl: null,
    marketPrice: 46,
    setName: 'Base Set',
    smallImageUrl: null,
    ...overrides,
  };
}

function buildDealAlert(overrides: Partial<DealAlert> = {}): DealAlert {
  return {
    baselineCents: 4600,
    cardId: 'charizard',
    createdAt: '2026-09-18T00:00:00.000Z',
    discountPct: 26,
    id: 'deal-1',
    kind: 'under_added',
    listingId: 'listing-1',
    marketCents: 4600,
    savingsCents: 1200,
    seenAt: null,
    tappedAt: null,
    totalCents: 3400,
    url: 'https://www.ebay.com/itm/123',
    verificationTier: 'scrydex',
    ...overrides,
  };
}

type DealRadarMocks = {
  listDealAlerts: jest.Mock;
  markDealAlertSeen: jest.Mock;
  markDealAlertTapped: jest.Mock;
  setCardFavoriteTarget: jest.Mock;
};

/**
 * A repository whose deal-radar methods are jest mocks.
 *
 * The four methods never throw in the real client (a failure is an empty page /
 * a null stamp / a `failed` status), so the mocks answer in those shapes rather
 * than rejecting.
 */
function buildRepository(options: {
  favorites?: CardFavoriteEntry[];
  page?: DealAlertsPage;
  setCardFavoriteTarget?: jest.Mock;
}) {
  const favorites = options.favorites
    ?? [buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' })];
  const page: DealAlertsPage = options.page ?? { alerts: [], limit: 5, unseenCount: 0 };
  const mocks: DealRadarMocks = {
    listDealAlerts: jest.fn(async () => page),
    // The real methods return the stamped alert; null means "unknown id".
    markDealAlertSeen: jest.fn(async (id: string) => ({
      ...(page.alerts.find((alert) => alert.id === id) ?? buildDealAlert({ id })),
      seenAt: '2026-09-19T00:00:00.000Z',
    })),
    markDealAlertTapped: jest.fn(async (id: string) => ({
      ...(page.alerts.find((alert) => alert.id === id) ?? buildDealAlert({ id })),
      tappedAt: '2026-09-19T00:00:00.000Z',
    })),
    setCardFavoriteTarget: options.setCardFavoriteTarget
      ?? jest.fn(async (cardId: string, targetPriceCents: number | null) => ({
        status: 'ok',
        target: {
          cardId,
          targetPriceCents,
          targetCurrency: targetPriceCents === null ? null : 'USD',
          targetSetAt: targetPriceCents === null ? null : '2026-09-19T00:00:00.000Z',
          targetTriggeredAt: null,
        },
      })),
  };

  const repository = createTestSpotlightRepository({
    getCardFavorites: async () => favorites,
    listDealAlerts: mocks.listDealAlerts,
    markDealAlertSeen: mocks.markDealAlertSeen,
    markDealAlertTapped: mocks.markDealAlertTapped,
    setCardFavoriteTarget: mocks.setCardFavoriteTarget,
  });

  return { mocks, repository };
}

function renderScreen(repository: ReturnType<typeof buildRepository>['repository']) {
  return renderWithProviders(<WishlistScreen />, { spotlightRepository: repository });
}

describe('Watchlist deal radar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFocused = true;
    mockAccessStatus = null;
    (useRouter as jest.Mock).mockReturnValue({
      back: jest.fn(),
      push: jest.fn(),
      replace: jest.fn(),
    });
  });

  describe('the band', () => {
    it('renders nothing at all when there are no deals', async () => {
      const { repository } = buildRepository({ page: { alerts: [], limit: 5, unseenCount: 0 } });
      renderScreen(repository);
      await screen.findByText('Charizard');

      // No empty card, no "no deals yet" box — the band appears only when it
      // has something to say.
      expect(screen.queryByTestId('wishlist-deal-band')).not.toBeOnTheScreen();
    });

    it('renders nothing when the radar flag is off, deals or not', async () => {
      mockAccessStatus = { watchDealRadarEnabled: false };
      const { mocks, repository } = buildRepository({
        page: { alerts: [buildDealAlert()], limit: 5, unseenCount: 1 },
      });
      renderScreen(repository);
      await screen.findByText('Charizard');

      expect(screen.queryByTestId('wishlist-deal-band')).not.toBeOnTheScreen();
      // And it does not even ask.
      expect(mocks.listDealAlerts).not.toHaveBeenCalled();
    });

    it('fails OPEN: a status with no flag on it still shows the band', async () => {
      mockAccessStatus = {};
      const { repository } = buildRepository({
        page: { alerts: [buildDealAlert()], limit: 5, unseenCount: 1 },
      });
      renderScreen(repository);

      expect(await screen.findByTestId('wishlist-deal-band')).toBeTruthy();
    });

    it('says what the listing beat, in the card\'s own currency', async () => {
      const { repository } = buildRepository({
        page: { alerts: [buildDealAlert()], limit: 5, unseenCount: 1 },
      });
      renderScreen(repository);

      const headline = await screen.findByTestId('wishlist-deal-headline-deal-1');
      expect(headline).toHaveTextContent('$34.00 listed — you added it at $46.00');
      expect(screen.getByTestId('wishlist-deal-discount-deal-1')).toHaveTextContent('26% off');
      // The unread state lives on the band, not on the social notification bell.
      expect(screen.getByTestId('wishlist-deal-band-unseen-dot')).toBeTruthy();
    });

    it('drops a deal whose card has left the watchlist rather than naming it nothing', async () => {
      const { repository } = buildRepository({
        favorites: [buildFavoriteEntry({ cardId: 'gengar', name: 'Gengar ex' })],
        page: { alerts: [buildDealAlert({ cardId: 'charizard' })], limit: 5, unseenCount: 1 },
      });
      renderScreen(repository);
      await screen.findByText('Gengar ex');

      expect(screen.queryByTestId('wishlist-deal-band')).not.toBeOnTheScreen();
    });

    it('stays silent when the radar returns an empty page', async () => {
      // `listDealAlerts` never throws — a failed request IS an empty page — so
      // the empty page is the only failure shape the band has to handle.
      const repository = createTestSpotlightRepository({
        getCardFavorites: async () => [buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' })],
        listDealAlerts: async () => ({ alerts: [], limit: 5, unseenCount: 0 }),
      });
      renderScreen(repository);
      await screen.findByText('Charizard');

      expect(screen.queryByTestId('wishlist-deal-band')).not.toBeOnTheScreen();
    });
  });

  describe('seenAt and tappedAt', () => {
    it('marks a deal seen once when it first renders, and not again', async () => {
      const { mocks, repository } = buildRepository({
        page: { alerts: [buildDealAlert()], limit: 5, unseenCount: 1 },
      });
      renderScreen(repository);
      await screen.findByTestId('wishlist-deal-band');

      await waitFor(() => {
        expect(mocks.markDealAlertSeen).toHaveBeenCalledWith('deal-1');
      });

      // Re-render the band (a filter change re-renders the whole list header):
      // the mark is per-alert, not per-render.
      await act(async () => {
        fireEvent.press(screen.getByTestId('wishlist-filter-az'));
      });
      expect(mocks.markDealAlertSeen).toHaveBeenCalledTimes(1);
    });

    it('does not re-mark a deal the backend already recorded as seen', async () => {
      const { mocks, repository } = buildRepository({
        page: {
          alerts: [buildDealAlert({ seenAt: '2026-09-18T01:00:00.000Z' })],
          limit: 5,
          unseenCount: 0,
        },
      });
      renderScreen(repository);
      await screen.findByTestId('wishlist-deal-band');

      expect(mocks.markDealAlertSeen).not.toHaveBeenCalled();
      expect(screen.queryByTestId('wishlist-deal-band-unseen-dot')).not.toBeOnTheScreen();
    });

    it('writes tappedAt on every tap, and only then opens the listing', async () => {
      const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
      const { mocks, repository } = buildRepository({
        page: { alerts: [buildDealAlert()], limit: 5, unseenCount: 1 },
      });
      renderScreen(repository);

      const row = await screen.findByTestId('wishlist-deal-row-deal-1');
      await act(async () => {
        fireEvent.press(row);
      });

      /*
        `tappedAt` is what the deal radar's whole product decision is computed
        from, so the write is a requirement of the tap: it has to land BEFORE
        the listing URL takes the app out to the browser.
      */
      expect(mocks.markDealAlertTapped).toHaveBeenCalledWith('deal-1');
      expect(mocks.markDealAlertTapped.mock.invocationCallOrder[0])
        .toBeLessThan(openURL.mock.invocationCallOrder[0]);
      expect(openURL).toHaveBeenCalledWith('https://www.ebay.com/itm/123');

      openURL.mockRestore();
    });

    it('still opens the listing when the tap write does not land', async () => {
      const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
      const { mocks, repository } = buildRepository({
        page: { alerts: [buildDealAlert()], limit: 5, unseenCount: 1 },
      });
      // null = unknown id or a failed request.
      mocks.markDealAlertTapped.mockResolvedValue(null);
      renderScreen(repository);

      const row = await screen.findByTestId('wishlist-deal-row-deal-1');
      await act(async () => {
        fireEvent.press(row);
      });

      expect(openURL).toHaveBeenCalledWith('https://www.ebay.com/itm/123');
      openURL.mockRestore();
    });
  });

  describe('sharing a caught deal', () => {
    it('sends the savings and the listing link through the in-app share sheet', async () => {
      const { repository } = buildRepository({
        page: { alerts: [buildDealAlert()], limit: 5, unseenCount: 1 },
      });
      renderScreen(repository);

      const shareButton = await screen.findByTestId('wishlist-deal-share-deal-1');
      await act(async () => {
        fireEvent.press(shareButton);
      });

      expect(await screen.findByTestId('wishlist-deal-share-sheet')).toBeTruthy();
      expect(screen.getByText('Send deal to')).toBeTruthy();

      const recipient = await screen.findByText('Misty');
      await act(async () => {
        fireEvent.press(recipient);
      });

      const { sendMessage } = jest.requireMock('@/features/social/dm-service');
      await waitFor(() => {
        expect(sendMessage).toHaveBeenCalledTimes(1);
      });

      /*
        TEXT, not a profile reference: the listing URL is the payload, and it
        has to be openable by the recipient outside the app. "$12.00 under" is
        the sentence that actually travels.
      */
      const [, body] = (sendMessage as jest.Mock).mock.calls[0];
      expect(body).toContain('Charizard');
      expect(body).toContain('$34.00');
      expect(body).toContain('$12.00 under what I added it at');
      expect(body).toContain('https://www.ebay.com/itm/123');
    });
  });

  describe('target price', () => {
    it('sets a target from a long-press on the row, and shows it once saved', async () => {
      const { mocks, repository } = buildRepository({});
      renderScreen(repository);

      const row = await screen.findByTestId('wishlist-row-charizard');
      await act(async () => {
        fireEvent(row, 'longPress');
      });

      const input = await screen.findByTestId('wishlist-target-input');
      fireEvent.changeText(input, '40');
      await act(async () => {
        fireEvent.press(screen.getByTestId('wishlist-target-save'));
      });

      // Whole cents over the wire — `targetPriceCents`, not the dollars the
      // row's market price is in.
      expect(mocks.setCardFavoriteTarget).toHaveBeenCalledWith('charizard', 4000);
      // Sheet closes, and the row now carries the target.
      await waitFor(() => {
        expect(screen.queryByTestId('wishlist-target-sheet')).not.toBeOnTheScreen();
      });
      expect(await screen.findByText(/Target \$40\.00/)).toBeTruthy();
    });

    it('clears a target by sending null', async () => {
      const { mocks, repository } = buildRepository({});
      renderScreen(repository);

      const row = await screen.findByTestId('wishlist-row-charizard');
      await act(async () => {
        fireEvent(row, 'longPress');
      });
      const clearButton = await screen.findByTestId('wishlist-target-clear');
      await act(async () => {
        fireEvent.press(clearButton);
      });

      expect(mocks.setCardFavoriteTarget).toHaveBeenCalledWith('charizard', null);
    });

    it('explains the server 404 as "not on your watchlist", never as an error', async () => {
      // The write does not throw: `not_watchlisted` IS the 404.
      const setCardFavoriteTarget = jest.fn(async () => ({
        status: 'not_watchlisted',
        target: null,
      }));
      const { repository } = buildRepository({ setCardFavoriteTarget });
      renderScreen(repository);

      const row = await screen.findByTestId('wishlist-row-charizard');
      await act(async () => {
        fireEvent(row, 'longPress');
      });
      fireEvent.changeText(await screen.findByTestId('wishlist-target-input'), '40');
      await act(async () => {
        fireEvent.press(screen.getByTestId('wishlist-target-save'));
      });

      const message = await screen.findByTestId('wishlist-target-message');
      expect(message).toHaveTextContent(
        "Charizard isn't on your watchlist any more, so there's nothing to set a target on.",
      );
      // The sheet stays open on a failure, so the user sees why.
      expect(screen.getByTestId('wishlist-target-sheet')).toBeTruthy();
    });

    it('refuses a non-price instead of sending garbage cents', async () => {
      const { mocks, repository } = buildRepository({});
      renderScreen(repository);

      const row = await screen.findByTestId('wishlist-row-charizard');
      await act(async () => {
        fireEvent(row, 'longPress');
      });
      fireEvent.changeText(await screen.findByTestId('wishlist-target-input'), 'soon');
      await act(async () => {
        fireEvent.press(screen.getByTestId('wishlist-target-save'));
      });

      expect(mocks.setCardFavoriteTarget).not.toHaveBeenCalled();
      expect(await screen.findByTestId('wishlist-target-message')).toBeTruthy();
    });
  });
});
