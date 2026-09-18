import { act, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  Collection,
  CollectionsSnapshot,
  InventoryCardEntry,
  PortfolioDashboard,
} from '@spotlight/api-client';

import { TabsPageContext } from '@/contexts/tabs-page-context';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { __resetPortfolioSummaryVisibilityForTests } from '@/features/portfolio/use-portfolio-summary-visibility';
import { __resetPortfolioViewModeForTests } from '@/features/portfolio/hooks/use-portfolio-view-mode';

import * as mockApiClient from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

/*
  WHAT THE USER SEES IN THE FIRST SECOND OF OPENING COLLECTION.

  The dashboard read is the slow call on this screen — seconds, and slower on a
  cold backend cache — so what fills the headline until it lands is the whole
  experience. Two things went wrong there, and both are pinned here:

    1. the saved snapshot that is supposed to paint the real balance instantly
       was read for the wrong collection and thrown away, leaving a dash; and
    2. simply returning to the tab re-ran that slow read, over and over.

  Both were invisible to the existing suite because both need the collection
  scope to RESOLVE — the active collection starts as the aggregate placeholder
  and is restored from disk a beat later, and that gap is where the bugs lived.
*/

// In-memory AsyncStorage: both persisted envelopes this test seeds are read
// through it, and the real module is a native bridge in this environment.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
    },
  };
});

jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() })),
  useFocusEffect: jest.fn(),
}));

jest.mock('@/features/social/social-service', () => ({
  ...jest.requireActual('@/features/social/social-service'),
  fetchAuthorActivity: jest.fn(async () => []),
  fetchLikedPostIds: jest.fn(async () => new Set()),
  fetchUnreadNotificationCount: jest.fn(async () => 0),
}));

// `AppProviders` falls back to this when no session owner is supplied, which is
// every test render — and it is the key both persisted envelopes are stamped
// with, so a snapshot seeded under anything else is correctly refused.
const OWNER_KEY = 'anonymous';
const COLLECTION_ID = 'collection-main';
const DASHBOARD_STORAGE_KEY = '@spotlight/portfolio/dashboard-cache';
const ACTIVE_COLLECTION_STORAGE_KEY = '@spotlight/portfolio/active-collection';

function buildEntry(id: string, marketPrice: number): InventoryCardEntry {
  return {
    cardId: `card-${id}`,
    cardNumber: '#001/100',
    setName: 'Test Set',
    imageUrl: 'https://example.com/card.png',
    marketPrice,
    hasMarketPrice: true,
    quantity: 1,
    id,
    name: `Card ${id}`,
  } as InventoryCardEntry;
}

function buildDashboard(currentValue: number, items: InventoryCardEntry[]): PortfolioDashboard {
  return {
    summary: { currentValue, changeAmount: 0, changePercent: 0, asOfLabel: 'Today' },
    inventoryCount: items.length,
    inventoryItems: items,
    recentSales: [],
    ranges: {
      // A hydrated open range, so the snapshot counts as a real chart rather
      // than an empty shell the model would rather replace.
      '1W': { portfolio: [{ isoDate: '2026-09-01', shortLabel: 'Sep 1', value: currentValue }], sales: [] },
      '1M': { portfolio: [], sales: [] },
      '3M': { portfolio: [], sales: [] },
      YTD: { portfolio: [], sales: [] },
      '1Y': { portfolio: [], sales: [] },
      ALL: { portfolio: [], sales: [] },
    },
  };
}

const MAIN_COLLECTION: Collection = {
  id: COLLECTION_ID,
  name: 'Main Collection',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  cardCount: 1,
  totalValue: 424_000,
  isDefault: true,
  hidden: false,
};

const COLLECTIONS_SNAPSHOT: CollectionsSnapshot = {
  collections: [MAIN_COLLECTION],
  defaultCollectionID: COLLECTION_ID,
  all: { cardCount: 1, totalValue: 424_000 },
};

const SAVED_ITEMS = [buildEntry('saved-1', 424_000)];
const SAVED_DASHBOARD = buildDashboard(424_000, SAVED_ITEMS);

function tabsContext(activePage: 'portfolio' | 'scanner') {
  return {
    activePage,
    chartScrubLockRef: { current: false },
    collectionEditing: false,
    setCollectionEditing: () => {},
  };
}

function renderPortfolio(
  repository: mockApiClient.SpotlightRepository,
  activePage: 'portfolio' | 'scanner' = 'portfolio',
) {
  return renderWithProviders(
    <TabsPageContext.Provider value={tabsContext(activePage)}>
      <PortfolioScreen onOpenInventoryEntry={() => {}} />
    </TabsPageContext.Provider>,
    { spotlightRepository: repository },
  );
}

function totalValueText(): string {
  const node = screen.getByTestId('collection-search-row-total-value');
  return String(node.props.children);
}

beforeEach(async () => {
  __resetPortfolioSummaryVisibilityForTests();
  __resetPortfolioViewModeForTests();
  await AsyncStorage.clear();
  // The state a returning user is actually in: a collection chosen last session,
  // and that collection's dashboard saved next to it.
  await AsyncStorage.setItem(
    ACTIVE_COLLECTION_STORAGE_KEY,
    JSON.stringify({ collectionID: COLLECTION_ID, ownerKey: OWNER_KEY }),
  );
  await AsyncStorage.setItem(
    DASHBOARD_STORAGE_KEY,
    JSON.stringify({
      dashboard: SAVED_DASHBOARD,
      savedAt: '2026-09-10T12:00:00.000Z',
      ownerKey: OWNER_KEY,
      collectionID: COLLECTION_ID,
    }),
  );
});

describe('opening Collection before the live dashboard lands', () => {
  it('paints the saved balance instead of a dash, once the collection scope resolves', async () => {
    /*
      THE BUG THIS REPLACES: the hydration effect ran mount-only, so it asked
      storage for the ALL_COLLECTIONS placeholder's snapshot, was correctly
      refused, and never ran again after the real collection was restored. The
      snapshot below sat on disk, valid, while the headline showed "—" for as
      long as the backend took.
    */
    const repository = createTestSpotlightRepository({
      listCollections: async () => COLLECTIONS_SNAPSHOT,
      // The slow call. It never resolves here, which is the point: everything
      // asserted below has to come from disk.
      loadPortfolioDashboard: () => new Promise(() => {}),
      loadInventoryEntries: () => new Promise(() => {}),
    });

    renderPortfolio(repository);

    await waitFor(() => {
      expect(totalValueText()).toContain('424');
    });
    expect(totalValueText()).not.toContain('—');
  });

  it('does not re-read the slow dashboard just because the tab regained focus', async () => {
    /*
      Focus goes false whenever Collection loses it — Wishlist and Social, not
      only the Scanner — and it is a dependency of the refresh effect, so every
      trip away and back paid for the dashboard again with nothing changed.
    */
    let dashboardLoads = 0;
    const repository = createTestSpotlightRepository({
      listCollections: async () => COLLECTIONS_SNAPSHOT,
      loadPortfolioDashboard: async () => {
        dashboardLoads += 1;
        return { state: 'success' as const, data: SAVED_DASHBOARD, errorMessage: null };
      },
      loadInventoryEntries: async () => ({
        state: 'success' as const,
        data: SAVED_ITEMS,
        errorMessage: null,
      }),
    });

    const view = renderPortfolio(repository);
    await waitFor(() => {
      expect(dashboardLoads).toBeGreaterThan(0);
    });
    const afterFirstLoad = dashboardLoads;

    // Leave for another tab, then come back.
    for (const page of ['scanner', 'portfolio'] as const) {
      await act(async () => {
        view.rerender(
          <TabsPageContext.Provider value={tabsContext(page)}>
            <PortfolioScreen onOpenInventoryEntry={() => {}} />
          </TabsPageContext.Provider>,
        );
      });
    }

    expect(dashboardLoads).toBe(afterFirstLoad);
    // And the balance the user came back to look at is still on screen.
    expect(totalValueText()).toContain('424');
  });
});
