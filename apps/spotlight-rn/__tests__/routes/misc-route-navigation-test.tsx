import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CatalogSearchResult, InventoryCardEntry } from '@spotlight/api-client';

import ModalLayout from '@/app/(modal)/_layout';
import AccountRoute from '@/app/(modal)/account';
import AssistantRoute from '@/app/assistant';
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
import YouRedirect from '@/app/(tabs)/you';
import LoginCallbackScreen from '@/app/login-callback';

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

// `(sheet)` nests its own SafeAreaProvider (it presents as a fullScreenModal, so
// it has to measure against the modal's own view). A real provider renders
// nothing until it measures, and jest never lays out, so seed it with metrics or
// the stack under it never mounts.
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 393, height: 852 },
      insets: { top: 59, left: 0, right: 0, bottom: 34 },
    },
  };
});

// The tabs layout records the pathname for "back to the last tab".
const mockPathname = jest.fn(() => '/');

// The pager navigator needs a real expo-router; this file mocks expo-router
// wholesale, so the navigator is stubbed to surface the props the layout passes.
jest.mock('@/components/tab-pager/tab-pager-navigator', () => ({
  TabPager: (props: object) => {
    const { Text } = require('react-native');
    return <Text testID="tab-pager">{JSON.stringify(props)}</Text>;
  },
}));

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

jest.mock('@/features/assistant/screens/assistant-screen', () => ({
  AssistantScreen: (props: {
    presentation?: string;
    onBack: () => void;
    onOpenCard: (cardId: string) => void;
    onOpenLogin?: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text testID="assistant-presentation">{props.presentation}</Text>
        <Pressable onPress={props.onBack} testID="assistant-close" />
        <Pressable onPress={() => props.onOpenCard('card-1')} testID="assistant-open-card" />
        <Pressable onPress={props.onOpenLogin} testID="assistant-open-login" />
      </>
    );
  },
}));

jest.mock('@/features/auth/screens/account-screen', () => ({
  AccountScreen: () => {
    const { Text } = require('react-native');
    return <Text testID="account-screen">account</Text>;
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
    fromScan,
    initialCondition,
    onBack,
    previewId,
    scanReviewId,
  }: {
    cardId: string;
    entryId?: string;
    fromScan?: boolean;
    initialCondition?: string;
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
        <Text testID="card-detail-from-scan">{fromScan ? 'yes' : 'no'}</Text>
        <Text testID="card-detail-condition">{initialCondition ?? 'none'}</Text>
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

/** The `new-post` Stack.Screen's own options, so assertions don't match another route's. */
function newPostBlockOf(rootLayout: string): string {
  const start = rootLayout.indexOf('name="new-post"');
  return start < 0 ? '' : rootLayout.slice(start, rootLayout.indexOf('/>', start));
}

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

    // The tabs layout is the tab pager (`@/components/tab-pager`); page ORDER
    // and the bar are pinned by the pager's own tests. Android back goes to Home.
    mockPathname.mockReturnValue('/');
    render(<TabsLayout />);
    expect(JSON.parse(screen.getByTestId('tab-pager').props.children)).toEqual({ backBehavior: 'firstRoute' });
  });


  // Tab ROUTES carry no swipe recogniser of their own: the one horizontal
  // gesture between tabs is the pager's, owned by the layout's navigator. A
  // recogniser hand-added to a route (what `ScannerExitSwipe` was until it was
  // deleted) would fight it.
  //
  // This does NOT apply to pushed stack screens. They keep UIKit's interactive
  // back-swipe.
  it('keeps every tab route free of its own horizontal swipe-to-navigate gesture', () => {

    const fs = require('node:fs');

    const path = require('node:path');
    const tabsDir = path.join(__dirname, '..', '..', 'src', 'app', '(tabs)');

    // The recognisers themselves are gone, not merely unused.
    expect(
      fs.existsSync(path.join(__dirname, '..', '..', 'src', 'components', 'scanner-exit-swipe.tsx')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(__dirname, '..', '..', 'src', 'components', 'tab-swipe-chain.tsx')),
    ).toBe(false);

    const tabRoutes = fs.readdirSync(tabsDir).filter((name: string) => name.endsWith('.tsx'));
    // Home / Scan / Search / Social, plus the layout and four redirects
    // (/portfolio, /you, /wishlist -> Home; /events -> Social).
    expect(tabRoutes).toHaveLength(9);

    for (const name of tabRoutes.filter((route: string) => route !== '_layout.tsx')) {
      const source: string = fs.readFileSync(path.join(tabsDir, name), 'utf8');
      const imports = source
        .split('\n')
        .filter((line) => line.trimStart().startsWith('import'))
        .join('\n');
      expect(imports).not.toMatch(/ExitSwipe|EdgeSwipe|Pager|Swipeable|SwipeChain/);
    }
  });

  it('registers New Post on the ROOT stack as an ungesturable full-page modal', () => {
    // This is a structural assertion on purpose. react-native-screens ignores
    // `stackPresentation` on a stack's BOTTOM-MOST screen, and pushing
    // /new-post from the tabs used to mount the `(stack)` navigator with
    // new-post as its only route — so the presentation was silently a no-op and
    // the composer rendered as a plain push with its close button under the
    // status bar. Nothing about that is visible to a render test; only the
    // route's PLACEMENT prevents it, so that placement is what gets pinned.
     
    const fs = require('node:fs');
     
    const path = require('node:path');
    const appDir = path.join(__dirname, '..', '..', 'src', 'app');

    expect(fs.existsSync(path.join(appDir, 'new-post.tsx'))).toBe(true);
    // Back under a group and it is that group's first screen again.
    expect(fs.existsSync(path.join(appDir, '(stack)', 'new-post.tsx'))).toBe(false);

    const rootLayout: string = fs.readFileSync(path.join(appDir, '_layout.tsx'), 'utf8');
    expect(rootLayout).toContain('name="new-post"');
    // Full page, not a sheet: the composer wants the whole screen for the image
    // and the body, and it is the only surface you can't gesture out of.
    expect(rootLayout).toContain("presentation: 'fullScreenModal'");

    // THE HIGHEST-VALUE ASSERTION HERE, because the bug it catches is invisible
    // on the platform most of this is developed on. `slide_from_bottom` is a
    // documented no-op on iOS (RNSScreen.mm's setStackAnimation only touches
    // modalTransitionStyle for fade/flip, so fullScreenModal keeps UIKit's
    // default coverVertical). On Android `fullScreenModal` is a plain MODAL
    // fragment whose default transition is an X-translate — drop this line and
    // the composer slides in from the RIGHT there, and nothing on iOS changes
    // to tell you.
    expect(newPostBlockOf(rootLayout)).toContain("animation: 'slide_from_bottom'");

    // No dismiss gesture on EITHER platform: exit is the X button or a posted
    // post. The old iOS-only opt-in is gone with it.
    expect(rootLayout).toContain('gestureEnabled: false');
    expect(rootLayout).not.toContain('gestureEnabled: true');
    expect(rootLayout).not.toContain("gestureEnabled: Platform.OS === 'ios'");

    // The sheet-only options must all be gone — a stray `sheetAllowedDetents`
    // next to `fullScreenModal` reads as an intent that isn't happening.
    // SCOPED to the new-post block on purpose: file-wide, this would be a
    // landmine for the next screen that legitimately wants a sheet.
    const newPostStart = rootLayout.indexOf('name="new-post"');
    expect(newPostStart).toBeGreaterThan(-1);
    const newPostBlock = rootLayout.slice(
      newPostStart,
      rootLayout.indexOf('/>', newPostStart),
    );
    expect(newPostBlock).not.toMatch(
      /sheetAllowedDetents|sheetCornerRadius|sheetExpandsWhenScrolledToEdge|sheetGrabberVisible/,
    );
  });

  it('presents Ask Ekalight as a ROOT form sheet, and leaves it before opening anything', () => {
    // Same placement rule as new-post: as a group's first screen the
    // formSheet presentation would be silently ignored.
    const fs = require('node:fs');
    const path = require('node:path');
    const appDir = path.join(__dirname, '..', '..', 'src', 'app');
    expect(fs.existsSync(path.join(appDir, 'assistant.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, '(stack)', 'assistant.tsx'))).toBe(false);
    const rootLayout: string = fs.readFileSync(path.join(appDir, '_layout.tsx'), 'utf8');
    expect(rootLayout).toContain('<Stack.Screen name="assistant" options={ASSISTANT_SHEET_OPTIONS} />');

    mockUseLocalSearchParams.mockReturnValue({ source: 'home' });
    render(<AssistantRoute />);
    expect(screen.getByTestId('assistant-presentation').props.children).toBe('sheet');

    fireEvent.press(screen.getByTestId('assistant-close'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();

    // A push after a modal would land UNDER the sheet: close it, then push.
    mockBack.mockReset();
    fireEvent.press(screen.getByTestId('assistant-open-card'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/cards/[cardId]', params: { cardId: 'card-1' } });
    expect(mockBack.mock.invocationCallOrder[0]).toBeLessThan(mockPush.mock.invocationCallOrder[0]);

    fireEvent.press(screen.getByTestId('assistant-open-login'));
    expect(mockBack).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenLastCalledWith('/login');
  });

  it('slides Search up and back down, with the swipe-down taken from the top only', () => {
    // `gestureDirection: 'vertical'` only implies `slide_from_bottom` when
    // `animation` is undefined, and the root stack's screenOptions set
    // `'default'` — so without an explicit animation, Search opened as a plain
    // push from the right on iOS and closed sideways.
     
    const fs = require('node:fs');
     
    const path = require('node:path');
    const rootLayout: string = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'app', '_layout.tsx'),
      'utf8',
    );
    const start = rootLayout.indexOf('name="(sheet)"');
    expect(start).toBeGreaterThan(-1);
    const sheetBlock = rootLayout.slice(start, rootLayout.indexOf('/>', start));
    // The shared slide-up preset.
    expect(sheetBlock).toContain('options={SLIDE_UP_SCREEN_OPTIONS}');
    const { SLIDE_UP_SCREEN_OPTIONS } = jest.requireActual<typeof import('@/lib/navigation-presentation')>(
      '@/lib/navigation-presentation',
    );
    expect(SLIDE_UP_SCREEN_OPTIONS).toMatchObject({
      animation: 'slide_from_bottom',
      animationDuration: 300,
      gestureDirection: 'vertical',
      gestureResponseDistance: { top: 140 },
    });
  });

  it('renders the account route screen', () => {
    render(<AccountRoute />);
    expect(screen.getByTestId('account-screen')).toBeTruthy();
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

  it('redirects /portfolio and /you to Collection at the tabs root', () => {
    // `page` params are gone with the pager: Collection and Scan are real tab
    // routes now, so /portfolio is a plain alias and /scan is a SCREEN, not a
    // redirect (which is why it is no longer asserted here).
    //
    // Both aliases point at `/`, which is Collection again now that the feed
    // has moved to `/social`. The load-bearing part is that neither may point
    // at `/social`: `/portfolio` and `/you` have always meant "my collection",
    // and aiming them at the feed would silently break every old link.
    render(<PortfolioRedirect />);
    expect(screen.getByTestId('redirect-target').props.children).toBe(JSON.stringify('/'));
    screen.unmount();

    render(<YouRedirect />);
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
      fromScan: '1',
      condition: 'lightly_played',
    });
    rerender(<CardDetailRoute />);

    expect(screen.getByTestId('card-detail-card').props.children).toBe('base1-4');
    expect(screen.getByTestId('card-detail-entry').props.children).toBe('entry-7');
    expect(screen.getByTestId('card-detail-preview').props.children).toBe('preview-1');
    expect(screen.getByTestId('card-detail-scan-review').props.children).toBe('review-1');
    expect(screen.getByTestId('card-detail-from-scan').props.children).toBe('yes');
    expect(screen.getByTestId('card-detail-condition').props.children).toBe('lightly_played');

    fireEvent.press(screen.getByTestId('card-detail-back'));

    expect(mockBack).toHaveBeenCalled();
  });

  it('restores the session from the login callback URL exactly once and then redirects', async () => {
    mockUseLinkingURL.mockReturnValue('spotlight://login-callback#access_token=token');

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      expect(mockRestoreSessionFromUrl).toHaveBeenCalledWith('spotlight://login-callback#access_token=token');
      // Home, plainly. This asserted `{ pathname: '/', params: { page: 'portfolio' } }`
      // — a name and a param that both said portfolio while `/` had become the
      // feed, and a `page` param nothing has read since the pager was retired.
      expect(mockDismissTo).toHaveBeenCalledWith('/');
    });
  });

  it('falls back to the initial callback URL when the linking hook is empty', async () => {
    mockUseLinkingURL.mockReturnValue(null);
    mockGetInitialURL.mockResolvedValue('spotlight://login-callback#access_token=token');

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      expect(mockRestoreSessionFromUrl).toHaveBeenCalledWith('spotlight://login-callback#access_token=token');
      // Home, plainly. This asserted `{ pathname: '/', params: { page: 'portfolio' } }`
      // — a name and a param that both said portfolio while `/` had become the
      // feed, and a `page` param nothing has read since the pager was retired.
      expect(mockDismissTo).toHaveBeenCalledWith('/');
    });
  });

  it('redirects away from the callback screen as soon as auth becomes signed in', async () => {
    mockUseLinkingURL.mockReturnValue(null);
    mockUseAuth.mockReturnValue({ state: 'signedIn' });

    render(<LoginCallbackScreen />);

    await waitFor(() => {
      // Home, plainly. This asserted `{ pathname: '/', params: { page: 'portfolio' } }`
      // — a name and a param that both said portfolio while `/` had become the
      // feed, and a `page` param nothing has read since the pager was retired.
      expect(mockDismissTo).toHaveBeenCalledWith('/');
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
