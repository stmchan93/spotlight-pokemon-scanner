import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CatalogSearchResult, InventoryCardEntry } from '@spotlight/api-client';

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockUseLocalSearchParams = jest.fn();
const mockUseLinkingURL = jest.fn();
const mockGetInitialURL = jest.fn();
type MockAuthState = 'loading' | 'signedIn' | 'signedOut' | 'needsProfile';
const mockUseAuth: jest.Mock<{ state: MockAuthState }, []> = jest.fn(() => ({
  state: 'loading',
}));
const mockRestoreSessionFromUrl: jest.Mock<Promise<void>, [string]> = jest.fn(
  async (_url: string) => undefined,
);
const mockRedirect = jest.fn(({ href }: { href: unknown }) => {
  const { Text } = require('react-native');
  return <Text testID="redirect-target">{JSON.stringify(href)}</Text>;
});
const mockSaveCatalogPreview: jest.Mock<string, [CatalogSearchResult]> = jest.fn(
  (_result: CatalogSearchResult) => 'catalog-preview-id',
);
const mockSaveInventoryPreview: jest.Mock<string, [InventoryCardEntry]> = jest.fn(
  (_entry: InventoryCardEntry) => 'inventory-preview-id',
);

jest.mock('expo-router', () => ({
  Redirect: (props: { href: unknown }) => mockRedirect(props),
  Slot: () => {
    const { Text } = require('react-native');
    return <Text testID="slot-screen">slot</Text>;
  },
  Stack: Object.assign(
    ({ screenOptions }: { screenOptions?: object }) => {
      const { Text } = require('react-native');
      return <Text testID="stack-screen-options">{JSON.stringify(screenOptions ?? null)}</Text>;
    },
    {
      Screen: ({ options }: { options?: object }) => {
        const { Text } = require('react-native');
        return <Text testID="stack-screen">{JSON.stringify(options ?? null)}</Text>;
      },
    },
  ),
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({
    back: mockBack,
    push: mockPush,
    replace: mockReplace,
  }),
}));

jest.mock('expo-linking', () => ({
  getInitialURL: () => mockGetInitialURL(),
  useLinkingURL: () => mockUseLinkingURL(),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('@/features/auth/screens/account-screen', () => ({
  AccountScreen: () => {
    const { Text } = require('react-native');
    return <Text testID="account-screen">account</Text>;
  },
}));

jest.mock('@/features/portfolio-import/screens/portfolio-import-screen', () => ({
  PortfolioImportScreen: ({ onClose }: { onClose: () => void }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="portfolio-import-screen">import</Text>
        <Pressable onPress={onClose} testID="portfolio-import-close" />
      </>
    );
  },
}));

jest.mock('@/features/catalog/screens/catalog-search-screen', () => ({
  CatalogSearchScreen: ({
    initialQuery,
    onClose,
    onOpenCard,
  }: {
    initialQuery: string;
    onClose: () => void;
    onOpenCard: (result: { cardId: string }) => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="catalog-search-query">{initialQuery}</Text>
        <Pressable onPress={onClose} testID="catalog-search-close" />
        <Pressable onPress={() => onOpenCard({ cardId: 'base1-4' })} testID="catalog-search-open-card" />
      </>
    );
  },
}));

jest.mock('@/features/cards/card-detail-preview-session', () => ({
  saveCardDetailPreviewFromCatalogResult: (result: CatalogSearchResult) => mockSaveCatalogPreview(result),
  saveCardDetailPreviewFromInventoryEntry: (entry: InventoryCardEntry) => mockSaveInventoryPreview(entry),
}));

jest.mock('@/features/auth/auth-service', () => ({
  restoreSessionFromUrl: (url: string) => mockRestoreSessionFromUrl(url),
}));

jest.mock('@/features/cards/screens/card-detail-screen', () => ({
  CardDetailScreen: ({
    cardId,
    entryId,
    onBack,
    onOpenAddToCollection,
    onOpenScanCandidateReview,
    onOpenSell,
    previewId,
    scanReviewId,
  }: {
    cardId: string;
    entryId?: string;
    onBack: () => void;
    onOpenAddToCollection: (nextCardId: string, nextEntryId?: string) => void;
    onOpenScanCandidateReview: (nextScanReviewId: string) => void;
    onOpenSell: (entryId: string) => void;
    previewId?: string;
    scanReviewId?: string;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="card-detail-card">{cardId}</Text>
        <Text testID="card-detail-entry">{entryId ?? 'none'}</Text>
        <Text testID="card-detail-preview">{previewId ?? 'none'}</Text>
        <Text testID="card-detail-scan-review">{scanReviewId ?? 'none'}</Text>
        <Pressable onPress={onBack} testID="card-detail-back" />
        <Pressable onPress={() => onOpenAddToCollection(cardId, entryId)} testID="card-detail-add" />
        <Pressable onPress={() => onOpenScanCandidateReview('scan-review-1')} testID="card-detail-review" />
        <Pressable onPress={() => onOpenSell(entryId ?? 'entry-1')} testID="card-detail-sell" />
      </>
    );
  },
}));

jest.mock('@/features/design-system/screens/design-system-catalog-screen', () => ({
  DesignSystemCatalogScreen: ({ onBack }: { onBack: () => void }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="design-system-screen">design-system</Text>
        <Pressable onPress={onBack} testID="design-system-back" />
      </>
    );
  },
}));

jest.mock('@/features/inventory/screens/inventory-browser-screen', () => ({
  InventoryBrowserScreen: ({
    initialMode,
    initialSelectedIds,
    onBack,
    onOpenBulkSell,
    onOpenEntry,
  }: {
    initialMode: string;
    initialSelectedIds: string[];
    onBack: () => void;
    onOpenBulkSell: (entryIds: string[]) => void;
    onOpenEntry: (entry: { cardId: string; id: string }) => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="inventory-initial-mode">{initialMode}</Text>
        <Text testID="inventory-selected">{initialSelectedIds.join(',')}</Text>
        <Pressable onPress={onBack} testID="inventory-back" />
        <Pressable onPress={() => onOpenBulkSell([])} testID="inventory-open-empty-bulk" />
        <Pressable onPress={() => onOpenBulkSell(['entry-1', 'entry-2'])} testID="inventory-open-bulk" />
        <Pressable onPress={() => onOpenEntry({ cardId: 'base1-4', id: 'entry-1' })} testID="inventory-open-entry" />
      </>
    );
  },
}));

jest.mock('@/features/collection/screens/add-to-collection-screen', () => ({
  AddToCollectionScreen: ({
    cardId,
    entryId,
    onClose,
  }: {
    cardId: string;
    entryId?: string;
    onClose: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="add-to-collection-card">{cardId}</Text>
        <Text testID="add-to-collection-entry">{entryId ?? 'none'}</Text>
        <Pressable onPress={onClose} testID="add-to-collection-close" />
      </>
    );
  },
}));

jest.mock('@/features/labeling/screens/labeling-session-screen', () => ({
  LabelingSessionScreen: () => {
    const { Text } = require('react-native');
    return <Text testID="labeling-session-screen">labeling</Text>;
  },
}));

jest.mock('@/features/portfolio/screens/sales-history-screen', () => ({
  SalesHistoryScreen: ({ onBack }: { onBack: () => void }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="sales-history-screen">sales-history</Text>
        <Pressable onPress={onBack} testID="sales-history-back" />
      </>
    );
  },
}));

jest.mock('@/features/sell/screens/single-sell-screen', () => ({
  SingleSellScreen: ({
    entryId,
    onClose,
    onComplete,
  }: {
    entryId: string;
    onClose: () => void;
    onComplete: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="single-sell-entry">{entryId}</Text>
        <Pressable onPress={onClose} testID="single-sell-close" />
        <Pressable onPress={onComplete} testID="single-sell-complete" />
      </>
    );
  },
}));

import AccountImportRoute from '@/app/(modal)/account/import';
import ModalLayout from '@/app/(modal)/_layout';
import AccountRoute from '@/app/(modal)/account';
import CatalogSearchRoute from '@/app/(sheet)/catalog/search';
import SheetLayout from '@/app/(sheet)/_layout';
import AddToCollectionRoute from '@/app/(sheet)/collection/add/[cardId]';
import SingleSellRoute from '@/app/(sheet)/sell/[entryId]';
import BrowseStackLayout from '@/app/(stack)/_layout';
import CardDetailRoute from '@/app/(stack)/cards/[cardId]';
import DesignSystemRoute from '@/app/(stack)/design-system';
import InventoryRoute from '@/app/(stack)/inventory/index';
import LabelingSessionRoute from '@/app/(stack)/labeling/session';
import SalesHistoryRoute from '@/app/(stack)/sales-history';
import TabsLayout from '@/app/(tabs)/_layout';
import PortfolioRedirect from '@/app/(tabs)/portfolio';
import ScanRedirect from '@/app/(tabs)/scan';
import LoginCallbackScreen from '@/app/login-callback';

describe('misc route wrappers', () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockPush.mockReset();
    mockReplace.mockReset();
    mockGetInitialURL.mockReset();
    mockGetInitialURL.mockResolvedValue(null);
    mockUseAuth.mockReset();
    mockUseAuth.mockReturnValue({ state: 'loading' });
    mockUseLinkingURL.mockReset();
    mockRestoreSessionFromUrl.mockReset();
    mockRedirect.mockClear();
    mockSaveCatalogPreview.mockClear();
    mockSaveInventoryPreview.mockClear();
    mockUseLocalSearchParams.mockReset();
  });

  it('renders the modal stack layout with the expected screen options', () => {
    render(<ModalLayout />);

    expect(screen.getByTestId('stack-screen-options').props.children).toContain('"headerShown":false');
    expect(screen.getByTestId('stack-screen-options').props.children).toContain('"backgroundColor":"transparent"');
  });

  it('renders the sheet and browse stack layouts plus the tabs slot wrapper', () => {
    const sheet = render(<SheetLayout />);
    expect(screen.getByTestId('stack-screen-options').props.children).toContain('"headerShown":false');
    sheet.unmount();

    const browse = render(<BrowseStackLayout />);
    expect(screen.getByTestId('stack-screen-options').props.children).toContain('"backgroundColor":"transparent"');
    browse.unmount();

    render(<TabsLayout />);
    expect(screen.getByTestId('slot-screen')).toBeTruthy();
  });

  it('renders the account route screen', () => {
    render(<AccountRoute />);
    expect(screen.getByTestId('account-screen')).toBeTruthy();
  });

  it('wires account import close back to the router', () => {
    render(<AccountImportRoute />);

    fireEvent.press(screen.getByTestId('portfolio-import-close'));

    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('hydrates the catalog search route and pushes card detail with a saved preview', () => {
    mockUseLocalSearchParams.mockReturnValue({ q: ['charizard', 'ignored'] });

    render(<CatalogSearchRoute />);

    expect(screen.getByTestId('catalog-search-query').props.children).toBe('charizard');

    fireEvent.press(screen.getByTestId('catalog-search-close'));
    expect(mockBack).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('catalog-search-open-card'));
    expect(mockSaveCatalogPreview).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/cards/[cardId]',
      params: {
        cardId: 'base1-4',
        previewId: 'catalog-preview-id',
      },
    });
  });

  it('wires the design-system route back action', () => {
    render(<DesignSystemRoute />);
    fireEvent.press(screen.getByTestId('design-system-back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('renders the labeling session and sales history routes', () => {
    const view = render(<LabelingSessionRoute />);
    expect(screen.getByTestId('labeling-session-screen')).toBeTruthy();
    view.unmount();

    render(<SalesHistoryRoute />);
    expect(screen.getByTestId('sales-history-screen')).toBeTruthy();
    fireEvent.press(screen.getByTestId('sales-history-back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('renders the portfolio and scan redirects', () => {
    const first = render(<PortfolioRedirect />);
    expect(screen.getByTestId('redirect-target').props.children).toBe(
      JSON.stringify({ pathname: '/', params: { page: 'portfolio' } }),
    );

    first.unmount();
    render(<ScanRedirect />);
    expect(screen.getByTestId('redirect-target').props.children).toBe(
      JSON.stringify({ pathname: '/', params: { page: 'scanner' } }),
    );
  });

  it('parses inventory route params and opens bulk sell and card detail routes', () => {
    mockUseLocalSearchParams.mockReturnValue({
      mode: ['select'],
      selected: ['entry-1,entry-2', 'entry-1'],
    });

    render(<InventoryRoute />);

    expect(screen.getByTestId('inventory-initial-mode').props.children).toBe('select');
    expect(screen.getByTestId('inventory-selected').props.children).toBe('entry-1,entry-2');

    fireEvent.press(screen.getByTestId('inventory-back'));
    expect(mockBack).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('inventory-open-empty-bulk'));
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('inventory-open-bulk'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/sell/batch',
      params: {
        entryIds: 'entry-1,entry-2',
      },
    });

    fireEvent.press(screen.getByTestId('inventory-open-entry'));
    expect(mockSaveInventoryPreview).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/cards/[cardId]',
      params: {
        cardId: 'base1-4',
        entryId: 'entry-1',
        previewId: 'inventory-preview-id',
      },
    });
  });

  it('returns null for add-to-collection when cardId is missing and closes when present', () => {
    mockUseLocalSearchParams.mockReturnValue({ cardId: '' });
    const { rerender } = render(<AddToCollectionRoute />);

    expect(screen.queryByTestId('add-to-collection-card')).toBeNull();

    mockUseLocalSearchParams.mockReturnValue({ cardId: ['base1-4'], entryId: ['entry-9'] });
    rerender(<AddToCollectionRoute />);

    expect(screen.getByTestId('add-to-collection-card').props.children).toBe('base1-4');
    expect(screen.getByTestId('add-to-collection-entry').props.children).toBe('entry-9');

    fireEvent.press(screen.getByTestId('add-to-collection-close'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('returns null for single-sell when entryId is missing and wires close and complete actions', () => {
    mockUseLocalSearchParams.mockReturnValue({ entryId: '' });
    const { rerender } = render(<SingleSellRoute />);

    expect(screen.queryByTestId('single-sell-entry')).toBeNull();

    mockUseLocalSearchParams.mockReturnValue({ entryId: ['entry-7'] });
    rerender(<SingleSellRoute />);

    expect(screen.getByTestId('single-sell-entry').props.children).toBe('entry-7');
    fireEvent.press(screen.getByTestId('single-sell-close'));
    fireEvent.press(screen.getByTestId('single-sell-complete'));

    expect(mockBack).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/portfolio');
  });

  it('returns null for card-detail when cardId is missing and wires nested navigation when present', () => {
    mockUseLocalSearchParams.mockReturnValue({ cardId: '' });
    const { rerender } = render(<CardDetailRoute />);

    expect(screen.queryByTestId('card-detail-card')).toBeNull();

    mockUseLocalSearchParams.mockReturnValue({
      cardId: ['base1-4'],
      entryId: ['entry-7'],
      previewId: ['preview-1'],
      scanReviewId: ['review-1'],
    });
    rerender(<CardDetailRoute />);

    expect(screen.getByTestId('card-detail-card').props.children).toBe('base1-4');
    expect(screen.getByTestId('card-detail-entry').props.children).toBe('entry-7');
    expect(screen.getByTestId('card-detail-preview').props.children).toBe('preview-1');
    expect(screen.getByTestId('card-detail-scan-review').props.children).toBe('review-1');

    fireEvent.press(screen.getByTestId('card-detail-back'));
    fireEvent.press(screen.getByTestId('card-detail-add'));
    fireEvent.press(screen.getByTestId('card-detail-review'));
    fireEvent.press(screen.getByTestId('card-detail-sell'));

    expect(mockBack).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/collection/add/[cardId]',
      params: {
        cardId: 'base1-4',
        entryId: 'entry-7',
      },
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/cards/[cardId]/scan-review',
      params: {
        cardId: 'base1-4',
        scanReviewId: 'scan-review-1',
      },
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/sell/[entryId]',
      params: {
        entryId: 'entry-7',
      },
    });
  });

  it('restores the session from the login callback URL exactly once and then redirects', async () => {
    mockUseLinkingURL.mockReturnValue('spotlight://login-callback#access_token=token');

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      expect(mockRestoreSessionFromUrl).toHaveBeenCalledWith('spotlight://login-callback#access_token=token');
      expect(mockReplace).toHaveBeenCalledWith('/(tabs)/portfolio');
    });
  });

  it('falls back to the initial callback URL when the linking hook is empty', async () => {
    mockUseLinkingURL.mockReturnValue(null);
    mockGetInitialURL.mockResolvedValue('spotlight://login-callback#access_token=token');

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      expect(mockRestoreSessionFromUrl).toHaveBeenCalledWith('spotlight://login-callback#access_token=token');
      expect(mockReplace).toHaveBeenCalledWith('/(tabs)/portfolio');
    });
  });

  it('redirects away from the callback screen as soon as auth becomes signed in', async () => {
    mockUseLinkingURL.mockReturnValue(null);
    mockUseAuth.mockReturnValue({ state: 'signedIn' });

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/(tabs)/portfolio');
    });
    expect(mockRestoreSessionFromUrl).not.toHaveBeenCalled();
  });

  it('ignores non-callback login URLs', () => {
    mockUseLinkingURL.mockReturnValue('spotlight://open/settings');

    render(<LoginCallbackScreen />);

    expect(mockRestoreSessionFromUrl).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
