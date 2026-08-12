import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CatalogSearchResult, InventoryCardEntry } from '@spotlight/api-client';

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

// Drives the tabs layout's `hidden` decision (the bar is hidden on /scan).
const mockPathname = jest.fn(() => '/');
// The You tab's icon. Null = no photo rasterised yet, which is the SF-symbol
// fallback case.
let mockTabAvatar: unknown = null;
jest.mock('@/components/circular-tab-avatar', () => ({
  useCircularTabAvatar: () => mockTabAvatar,
}));

jest.mock('expo-router/unstable-native-tabs', () => {
  const { Text, View } = require('react-native');
  const Trigger = Object.assign(
    ({ name, children }: { name?: string; children?: React.ReactNode }) => (
      <View>
        <Text testID={`native-tab-${name}`}>{name}</Text>
        {children}
      </View>
    ),
    {
      // Surfaces which icon source each trigger chose. `tab-icon` deliberately
      // does NOT start with `native-tab-`, so it stays out of the regex that
      // asserts tab ORDER below.
      Icon: ({
        renderingMode,
        sf,
        src,
      }: {
        renderingMode?: string;
        sf?: unknown;
        src?: unknown;
      }) => (
        <Text testID="tab-icon">
          {JSON.stringify({ renderingMode: renderingMode ?? null, sf: sf ?? null, src: src ?? null })}
        </Text>
      ),
      Label: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
    },
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

    // The tabs layout is Apple's native tab bar now, not a Slot. Four tabs:
    // Home / Scan / Wishlist / You, and the ORDER is part of the contract —
    // `index` is the feed and Collection sits last as `you`.
    mockPathname.mockReturnValue('/');
    const tabs = render(<TabsLayout />);
    expect(screen.getByTestId('native-tabs-minimize').props.children).toBe('onScrollDown');
    expect(screen.getByTestId('native-tab-index')).toBeTruthy();
    expect(screen.getByTestId('native-tab-scan')).toBeTruthy();
    expect(screen.getByTestId('native-tab-wishlist')).toBeTruthy();
    expect(screen.getByTestId('native-tab-you')).toBeTruthy();
    expect(
      screen.getAllByTestId(/^native-tab-/).map((node) => node.props.children),
    ).toEqual(['index', 'scan', 'wishlist', 'you']);
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

  // `sf` and `src` are MUTUALLY EXCLUSIVE on the You tab, and the failure is
  // silent in both directions: iOS resolves `sf` > `xcasset` > `src`, so passing
  // both means the symbol always wins and the avatar simply never appears; and
  // without `renderingMode="original"` the tint configured by `tintColor` turns
  // the photograph into a flat silhouette. Neither shows up as an error.
  it('swaps the You glyph for the avatar photo, untinted, once one exists', () => {
    mockPathname.mockReturnValue('/');

    mockTabAvatar = null;
    const glyph = render(<TabsLayout />);
    const asGlyph = JSON.parse(screen.getAllByTestId('tab-icon')[3].props.children);
    expect(asGlyph.sf).not.toBeNull();
    expect(asGlyph.src).toBeNull();
    glyph.unmount();

    mockTabAvatar = { uri: 'data:image/png;base64,PNG', width: 28, height: 28, scale: 3 };
    render(<TabsLayout />);
    const asPhoto = JSON.parse(screen.getAllByTestId('tab-icon')[3].props.children);
    expect(asPhoto.src).toEqual(mockTabAvatar);
    expect(asPhoto.sf).toBeNull();
    expect(asPhoto.renderingMode).toBe('original');

    // The avatar reaches ONLY the You tab — the assertion that matters here,
    // since every other tab now carries an image too.
    const others = [0, 1, 2].map((i) =>
      JSON.parse(screen.getAllByTestId('tab-icon')[i].props.children),
    );
    for (const icon of others) {
      expect(icon.src).not.toEqual(mockTabAvatar);
    }
    mockTabAvatar = null;
  });

  /*
    THE FIGMA GLYPHS, WHICH ARE IMAGES RATHER THAN SYMBOLS.

    Home (Figma 3670:48082) and Wishlist (3670:48091) draw iconoir's HomeSimple
    and Bookmark, which a native bar cannot take as components — they are
    rasterized from the installed package by `tools/generate_tab_icons.py`.

    `renderingMode="template"` MUST be set EXPLICITLY on them, and that is the
    whole point of this test. It is the inverse of the You avatar above: a
    photograph needs `original` or the tint flattens it to a silhouette, while
    these need `template` or `tintColor` never reaches them and the selected tab
    stops looking selected. Both failures are silent.

    This assertion used to demand the OPPOSITE — that the prop stay unset — on
    the belief that the default was `template`. It is not, and Home and Wishlist
    shipped untinted because of it. expo-router picks the default itself
    (`native-tabs/utils/icon.js`):

      effectiveRenderingMode = renderingMode ?? (iconColor !== undefined
        ? 'template' : 'original')

    and `iconColor` there is fed by the `iconColor` PROP, not by `tintColor`,
    which `appearance.js` maps onto `selectedIconColor` alone. This bar sets
    `tintColor` and no `iconColor`, so the default resolved to `original`, the
    PNG reached UIKit as a plain `imageSource`, and an original-mode image
    ignores the bar's tint and draws its own pixels — pure black, in BOTH
    states. Do not "simplify" this back to an unset prop.
  */
  it('draws Home and Wishlist from the Figma vectors, tintable', () => {
    mockPathname.mockReturnValue('/');
    render(<TabsLayout />);

    const [home, scan, wishlist] = [0, 1, 2].map((i) =>
      JSON.parse(screen.getAllByTestId('tab-icon')[i].props.children),
    );

    expect(home.src).toBeTruthy();
    expect(home.sf).toBeNull();
    expect(home.renderingMode).toBe('template');

    expect(wishlist.src).toBeTruthy();
    expect(wishlist.sf).toBeNull();
    expect(wishlist.renderingMode).toBe('template');

    /*
      Scan is deliberately NOT one of them. Its frame draws Apple's own
      `viewfinder`, so iOS renders it natively — and Apple's SF Symbols license
      does not allow shipping that artwork as an image on Android, which is why
      it must never be "fixed" to match the other two.
    */
    expect(scan.sf).not.toBeNull();
    expect(scan.src).toBeNull();
  });

  // A structural assertion, for the same reason the New Post one below is:
  // "there is no horizontal swipe between these screens" is the ABSENCE of a
  // behaviour, and absence is invisible to a render test. The native tab bar
  // gives it for free (UITabBarController has no swipe-between-tabs gesture),
  // so the only way it can come back is a JS recogniser hand-added to a tab
  // screen — which is exactly what `ScannerExitSwipe` was until it was deleted.
  //
  // This does NOT apply to pushed stack screens. They keep UIKit's interactive
  // back-swipe, which is deliberately the app's only horizontal nav gesture.
  it('keeps every tab screen free of a horizontal swipe-to-navigate gesture', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    const tabsDir = path.join(__dirname, '..', '..', 'src', 'app', '(tabs)');

    // The recogniser itself is gone, not merely unused.
    expect(
      fs.existsSync(path.join(__dirname, '..', '..', 'src', 'components', 'scanner-exit-swipe.tsx')),
    ).toBe(false);

    const tabRoutes = fs.readdirSync(tabsDir).filter((name: string) => name.endsWith('.tsx'));
    // Home / Scan / Wishlist / You, plus the layout and the /portfolio alias.
    expect(tabRoutes).toHaveLength(6);

    for (const name of tabRoutes) {
      const source: string = fs.readFileSync(path.join(tabsDir, name), 'utf8');
      // Comments are allowed to name the deleted component (scan.tsx explains
      // why it went); an IMPORT of a swipe recogniser is what must not reappear.
      const imports = source
        .split('\n')
        .filter((line) => line.trimStart().startsWith('import'))
        .join('\n');
      expect(imports).not.toMatch(/ExitSwipe|EdgeSwipe|Pager|Swipeable/);
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
    expect(rootLayout).toContain("animation: 'slide_from_bottom'");

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

  it('redirects /portfolio to the You tab, not the tabs root', () => {
    // `page` params are gone with the pager: Collection and Scan are real tab
    // routes now, so /portfolio is a plain alias and /scan is a SCREEN, not a
    // redirect (which is why it is no longer asserted here).
    //
    // The target is `/you`. It was `/` right up until Home (the feed) took the
    // tabs root — this asserts the alias followed Collection to its new route
    // instead of silently pointing every old portfolio link at the feed.
    render(<PortfolioRedirect />);
    expect(screen.getByTestId('redirect-target').props.children).toBe(JSON.stringify('/you'));
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
