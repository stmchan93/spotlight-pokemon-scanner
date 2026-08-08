import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CatalogSearchResult, InventoryCardEntry } from '@spotlight/api-client';

const mockBack = jest.fn();
const mockDismissTo = jest.fn();
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

// Drives the tabs layout's `hidden` decision (the bar is hidden on /scan).
const mockPathname = jest.fn(() => '/');

jest.mock('expo-router/unstable-native-tabs', () => {
  const { Text, View } = require('react-native');
  const Trigger = Object.assign(
    ({ name }: { name?: string }) => <Text testID={`native-tab-${name}`}>{name}</Text>,
    { Icon: () => null, Label: ({ children }: { children?: unknown }) => <Text>{children}</Text> },
  );
  return {
    NativeTabs: Object.assign(
      ({ children, hidden, minimizeBehavior }: { children?: React.ReactNode; hidden?: boolean; minimizeBehavior?: string }) => (
        <View>
          <Text testID="native-tabs-hidden">{String(hidden)}</Text>
          <Text testID="native-tabs-minimize">{String(minimizeBehavior)}</Text>
          {children}
        </View>
      ),
      { Trigger },
    ),
  };
});

jest.mock('expo-router', () => ({
  Redirect: (props: { href: unknown }) => mockRedirect(props),
  usePathname: () => mockPathname(),
  Slot: () => {
    const { Text } = require('react-native');
    return <Text testID="slot-screen">slot</Text>;
  },
  Stack: Object.assign(
    // Children are rendered too, so per-route `<Stack.Screen options>` (e.g. the
    // New Post form-sheet presentation) is assertable and not silently dropped.
    ({ children, screenOptions }: { children?: React.ReactNode; screenOptions?: object }) => {
      const { Text, View } = require('react-native');
      return (
        <View>
          <Text testID="stack-screen-options">{JSON.stringify(screenOptions ?? null)}</Text>
          {children}
        </View>
      );
    },
    {
      Screen: ({ name, options }: { name?: string; options?: object }) => {
        const { Text } = require('react-native');
        return <Text testID={`stack-screen-${name ?? 'unnamed'}`}>{JSON.stringify(options ?? null)}</Text>;
      },
    },
  ),
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({
    back: mockBack,
    dismissTo: mockDismissTo,
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

// Routes warm the PDP via prefetchCardDetail(useAppServices().spotlightRepository).
// Stub both so the route wrappers render in isolation (no AppProviders here).
jest.mock('@/features/cards/card-detail-prefetch', () => ({
  prefetchCardDetail: jest.fn(),
}));

jest.mock('@/providers/app-providers', () => ({
  useAppServices: () => ({ spotlightRepository: {} }),
}));

jest.mock('@/features/auth/auth-service', () => ({
  restoreSessionFromUrl: (url: string) => mockRestoreSessionFromUrl(url),
}));

jest.mock('@/features/cards/screens/card-detail-screen', () => ({
  CardDetailScreen: ({
    cardId,
    entryId,
    onBack,
    previewId,
    scanReviewId,
  }: {
    cardId: string;
    entryId?: string;
    onBack: () => void;
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
    onBack,
    onOpenEntry,
  }: {
    onBack: () => void;
    onOpenEntry: (entry: { cardId: string; id: string }) => void;
  }) => {
    const { Pressable } = require('react-native');
    return (
      <>
        <Pressable onPress={onBack} testID="inventory-back" />
        <Pressable onPress={() => onOpenEntry({ cardId: 'base1-4', id: 'entry-1' })} testID="inventory-open-entry" />
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

import AccountImportRoute from '@/app/(modal)/account/import';
import ModalLayout from '@/app/(modal)/_layout';
import AccountRoute from '@/app/(modal)/account';
import CatalogSearchRoute from '@/app/(sheet)/catalog/search';
import SheetLayout from '@/app/(sheet)/_layout';
import BrowseStackLayout from '@/app/(stack)/_layout';
import CardDetailRoute from '@/app/(stack)/cards/[cardId]';
import DesignSystemRoute from '@/app/(stack)/design-system';
import InventoryRoute from '@/app/(stack)/inventory/index';
import LabelingSessionRoute from '@/app/(stack)/labeling/session';
import SalesHistoryRoute from '@/app/(stack)/sales-history';
import TabsLayout from '@/app/(tabs)/_layout';
import PortfolioRedirect from '@/app/(tabs)/portfolio';
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

    // The tabs layout is Apple's native tab bar now, not a Slot.
    mockPathname.mockReturnValue('/');
    const tabs = render(<TabsLayout />);
    expect(screen.getByTestId('native-tabs-minimize').props.children).toBe('onScrollDown');
    expect(screen.getByTestId('native-tab-index')).toBeTruthy();
    expect(screen.getByTestId('native-tab-scan')).toBeTruthy();
    expect(screen.getByTestId('native-tab-wishlist')).toBeTruthy();
    expect(screen.getByTestId('native-tabs-hidden').props.children).toBe('false');

    // On the Scanner the BAR is hidden so the camera keeps the full screen —
    // this is what replaced the launcher-and-push design that stranded users on
    // a black screen. Regression guard: if this flips back to 'false', the
    // reticle silently shrinks again.
    tabs.unmount();
    mockPathname.mockReturnValue('/scan');
    render(<TabsLayout />);
    expect(screen.getByTestId('native-tabs-hidden').props.children).toBe('true');
  });

  it('registers New Post on the ROOT stack so its formSheet actually presents', () => {
    // This is a structural assertion on purpose. react-native-screens ignores
    // `stackPresentation` on a stack's BOTTOM-MOST screen, and pushing
    // /new-post from the tabs used to mount the `(stack)` navigator with
    // new-post as its only route — so the sheet was silently a no-op and the
    // composer rendered full-screen with its close button under the status bar.
    // Nothing about that is visible to a render test; only the route's PLACEMENT
    // prevents it, so that placement is what gets pinned.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    const appDir = path.join(__dirname, '..', '..', 'src', 'app');

    expect(fs.existsSync(path.join(appDir, 'new-post.tsx'))).toBe(true);
    // Back under a group and it is that group's first screen again.
    expect(fs.existsSync(path.join(appDir, '(stack)', 'new-post.tsx'))).toBe(false);

    const rootLayout: string = fs.readFileSync(path.join(appDir, '_layout.tsx'), 'utf8');
    expect(rootLayout).toContain('name="new-post"');
    expect(rootLayout).toContain("presentation: 'formSheet'");
    // Figma 3147:10814 — 787pt of an 852pt screen.
    expect(rootLayout).toContain('sheetAllowedDetents: [0.92]');
    // Drag-down needs the gesture; tap-outside comes with formSheet itself.
    expect(rootLayout).toContain('gestureEnabled: true');
    // The composer draws its own grabber, so iOS must not add a second one.
    expect(rootLayout).toContain('sheetGrabberVisible: false');
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

  it('redirects /portfolio to the Collection tab', () => {
    // `page` params are gone with the pager: Collection and Scan are real tab
    // routes now, so /portfolio is a plain alias for / and /scan is a SCREEN,
    // not a redirect (which is why it is no longer asserted here).
    render(<PortfolioRedirect />);
    expect(screen.getByTestId('redirect-target').props.children).toBe(JSON.stringify('/'));
  });

  it('wires inventory back and card detail navigation', () => {
    render(<InventoryRoute />);

    fireEvent.press(screen.getByTestId('inventory-back'));
    expect(mockBack).toHaveBeenCalledTimes(1);

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

    expect(mockBack).toHaveBeenCalled();
  });

  it('restores the session from the login callback URL exactly once and then redirects', async () => {
    mockUseLinkingURL.mockReturnValue('spotlight://login-callback#access_token=token');

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      expect(mockRestoreSessionFromUrl).toHaveBeenCalledWith('spotlight://login-callback#access_token=token');
      expect(mockDismissTo).toHaveBeenCalledWith({ pathname: '/', params: { page: 'portfolio' } });
    });
  });

  it('falls back to the initial callback URL when the linking hook is empty', async () => {
    mockUseLinkingURL.mockReturnValue(null);
    mockGetInitialURL.mockResolvedValue('spotlight://login-callback#access_token=token');

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      expect(mockRestoreSessionFromUrl).toHaveBeenCalledWith('spotlight://login-callback#access_token=token');
      expect(mockDismissTo).toHaveBeenCalledWith({ pathname: '/', params: { page: 'portfolio' } });
    });
  });

  it('redirects away from the callback screen as soon as auth becomes signed in', async () => {
    mockUseLinkingURL.mockReturnValue(null);
    mockUseAuth.mockReturnValue({ state: 'signedIn' });

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      expect(mockDismissTo).toHaveBeenCalledWith({ pathname: '/', params: { page: 'portfolio' } });
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
