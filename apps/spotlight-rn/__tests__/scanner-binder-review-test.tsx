import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  __resetRecentCapturesPersistenceForTests,
  PERSIST_ENVELOPE_VERSION,
  RECENT_CAPTURES_DIR,
  RECENT_CAPTURES_STORAGE_KEY,
} from '@/features/scanner/recent-captures-persistence';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { __resetScannerTargetConfigForTests } from '@/features/scanner/use-scanner-target-config';

import { createTestSpotlightRepository, renderWithProviders } from './test-utils';

/*
  Binder page review as a BATCH EDITOR. The #2 wish across ~2,100 competitor
  reviews: fix a whole binder page's printings at once instead of
  nine cards one by one. These drive the real scanner screen against a tray
  rehydrated from storage (a page scanned earlier), so the review, the price
  selection map, and persistence are all exercised together.
*/

// In-memory AsyncStorage — the scanner tray is rehydrated from it on mount.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      removeItem: jest.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
    },
  };
});

// Every persisted row's image "exists" so rehydration keeps it.
jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
  readAsStringAsync: jest.fn(async () => 'bW9jay1zY2FuLWJhc2U2NA=='),
  writeAsStringAsync: jest.fn(async () => {}),
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: true, uri, isDirectory: uri.endsWith('/') })),
  deleteAsync: jest.fn(async () => {}),
  makeDirectoryAsync: jest.fn(async () => {}),
  copyAsync: jest.fn(async () => {}),
  readDirectoryAsync: jest.fn(async () => []),
  documentDirectory: 'file:///mock-docs/',
  cacheDirectory: 'file:///mock-cache/',
}));

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({
      back: jest.fn(),
      canGoBack: jest.fn(() => false),
      push: jest.fn(),
      replace: jest.fn(),
      dismissTo: jest.fn(),
    }),
  };
});

const OWNER_ID = '00000000-0000-0000-0000-00000000000a';

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentSession: { access_token: 'token', user: { id: OWNER_ID, is_anonymous: false } },
    currentUser: {
      adminEnabled: false,
      avatarURL: null,
      displayName: 'UI Test User',
      email: 'ui-tests@spotlight.local',
      id: OWNER_ID,
      labelerEnabled: false,
      providers: ['ui-tests'],
    },
    ensureGuestSession: jest.fn(),
    isGuest: false,
  }),
}));

const PAGE_ID = 'page-1';

function candidate(cardId: string, name: string, marketPrice: number) {
  return {
    id: cardId,
    cardId,
    name,
    cardNumber: `#${cardId.slice(-1)}/100`,
    setName: 'Test Set',
    imageUrl: `https://cdn.spotlight.test/${cardId}.png`,
    marketPrice,
    currencyCode: 'USD',
  };
}

/** One persisted tray row of the page (`PersistedCapture` shape). */
function pocketRow(
  pocketIndex: number,
  candidates: ReturnType<typeof candidate>[],
  matchConfidence: 'high' | 'medium' | 'low' = 'high',
) {
  const id = pocketIndex === 0 ? PAGE_ID : `${PAGE_ID}-p${pocketIndex}`;
  return {
    id,
    scanID: `scan-${id}`,
    mode: 'raw',
    uri: `${RECENT_CAPTURES_DIR}${id}-src.jpg`,
    normalizedImageUri: `${RECENT_CAPTURES_DIR}${id}.jpg`,
    candidates,
    activeCandidateIndex: 0,
    totalCandidateCount: candidates.length,
    matchReviewDisposition: null,
    matchReviewReason: null,
    slabContext: null,
    normalizedImageDimensions: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
    binderPage: { pageId: PAGE_ID, pocketIndex, layoutId: 'pockets-9' },
    matchConfidence,
  };
}

// Pocket 1 and 2 have a Holofoil printing; pocket 3 is Normal-only. Pocket 2
// is a low-confidence match with alternates.
const cardA = candidate('card-a', 'Alakazam', 10);
const cardB = candidate('card-b', 'Blastoise', 20);
const cardB2 = candidate('card-b2', 'Blastoise (alt)', 15);
const cardC = candidate('card-c', 'Charmander', 1);

function conditions(nm: number, lp: number) {
  return [
    { code: 'NM', label: 'Near Mint', market: nm, low: null, mid: null, high: null },
    { code: 'LP', label: 'Lightly Played', market: lp, low: null, mid: null, high: null },
  ];
}

const matrices: Record<string, { variant: string; variantKey: string; conditions: ReturnType<typeof conditions> }[]> = {
  'card-a': [
    { variant: 'Normal', variantKey: 'normal', conditions: conditions(10, 8) },
    { variant: 'Holofoil', variantKey: 'holofoil', conditions: conditions(50, 40) },
  ],
  'card-b': [
    { variant: 'Normal', variantKey: 'normal', conditions: conditions(20, 16) },
    { variant: 'Holofoil', variantKey: 'holofoil', conditions: conditions(100, 80) },
  ],
  'card-b2': [{ variant: 'Normal', variantKey: 'normal', conditions: conditions(15, 12) }],
  'card-c': [{ variant: 'Normal', variantKey: 'normal', conditions: conditions(1, 0.5) }],
};

async function seedPersistedPage(priceSelections?: Record<string, unknown>) {
  await AsyncStorage.setItem(
    RECENT_CAPTURES_STORAGE_KEY,
    JSON.stringify({
      version: PERSIST_ENVELOPE_VERSION,
      ownerKey: OWNER_ID,
      items: [
        pocketRow(0, [cardA]),
        pocketRow(1, [cardB, cardB2, cardA], 'low'),
        pocketRow(2, [cardC]),
      ],
      ...(priceSelections ? { priceSelections } : {}),
    }),
  );
}

async function readPersistedSelections(): Promise<Record<string, { variantLabel: string; conditionShortLabel: string }>> {
  const raw = await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY);
  return JSON.parse(raw ?? '{}').priceSelections ?? {};
}

let matrixCalls: string[] = [];

function renderScannerWithPage() {
  const spotlightRepository = createTestSpotlightRepository({
    getRawPricingMatrix: async (cardId: string) => {
      matrixCalls.push(cardId);
      return { cardID: cardId, currencyCode: 'USD', variants: matrices[cardId] ?? [] };
    },
  });
  return renderWithProviders(<ScannerScreen />, { spotlightRepository });
}

async function openPageReview() {
  fireEvent.press(await screen.findByTestId(`scanner-tray-page-view-${PAGE_ID}`));
  const review = await screen.findByTestId('scanner-binder-page-review');
  // The grid renders only after the frame is measured.
  fireEvent(screen.getByTestId('scanner-binder-page-review-frame'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } },
  });
  await screen.findByTestId('scanner-binder-page-review-grid');
  return review;
}

const REVIEW = 'scanner-binder-page-review';

describe('ScannerScreen binder page review — batch editing', () => {
  beforeEach(async () => {
    matrixCalls = [];
    __resetRecentCapturesPersistenceForTests();
    __resetScannerTargetConfigForTests();
    await AsyncStorage.clear();
  });

  it('keeps the tiles free of pricing controls — no printing chip, no "Not sure?"', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();

    /*
      The tile is art + name + set + price and nothing else. Nine pockets each
      carrying a printing chip and an alternates link is what made the page
      unreadable; both moved to the batch row and the change-card picker.
    */
    for (const pocket of [0, 1, 2]) {
      expect(screen.queryByTestId(`${REVIEW}-pocket-${pocket}-printing`)).toBeNull();
      expect(screen.queryByTestId(`${REVIEW}-pocket-${pocket}-not-sure`)).toBeNull();
    }
    // And the hold gesture is advertised, since nothing else hints at it —
    // the page at rest carries NO dropdowns; they arrive with a selection.
    expect(screen.getByTestId(`${REVIEW}-hint`)).toHaveTextContent(/Hold to edit/);
    expect(screen.queryByTestId(`${REVIEW}-batch`)).toBeNull();
  });

  /*
    Hold the first pocket, then tap the other two. There is no Select-all
    button: holding and tapping IS how a page-wide batch is made now, and the
    ticks on the tiles are the only count there is.
  */
  async function selectWholePage() {
    fireEvent(screen.getByTestId(`${REVIEW}-pocket-0`), 'longPress');
    await screen.findByTestId(`${REVIEW}-batch`);
    fireEvent.press(screen.getByTestId(`${REVIEW}-pocket-1`));
    fireEvent.press(screen.getByTestId(`${REVIEW}-pocket-2`));
    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-2-tick`)).toBeTruthy();
    });
  }

  it('"Variant" updates every pocket that has it and persists the choices', async () => {
    await seedPersistedPage();
    const view = renderScannerWithPage();
    await openPageReview();
    await selectWholePage();

    fireEvent.press(screen.getByTestId(`${REVIEW}-batch-variant`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-batch-variant-menu-normal`));

    expect(await screen.findByText('Applied to 3 of 3')).toBeTruthy();
    // NM prices for the Normal printing: 10 + 20 + 1
    expect(screen.getByTestId(`${REVIEW}-add-all`)).toHaveTextContent('Add 3 · $31.00');
    // Normal is every one of these cards' OWN printing, so it earns no line —
    // the batch landed (the prices say so) without labelling a non-change.
    expect(screen.queryByTestId(`${REVIEW}-pocket-0-printing`)).toBeNull();
    expect(screen.queryByTestId(`${REVIEW}-pocket-1-printing`)).toBeNull();
    expect(screen.queryByTestId(`${REVIEW}-pocket-2-printing`)).toBeNull();
    // One matrix fetch per distinct card, in parallel.
    expect([...matrixCalls].sort()).toEqual(['card-a', 'card-b', 'card-c']);

    // Autosave: the choices ride with the rows (debounced), owner-scoped.
    await waitFor(async () => {
      const persisted = await readPersistedSelections();
      expect(Object.keys(persisted).sort()).toEqual([PAGE_ID, `${PAGE_ID}-p1`, `${PAGE_ID}-p2`]);
      expect(persisted[PAGE_ID]).toEqual(expect.objectContaining({ variantLabel: 'Normal', conditionShortLabel: 'NM' }));
    }, { timeout: 3000 });

    // Round-trip: a fresh scanner mount (crash / back out) shows the same choices.
    view.unmount();
    __resetRecentCapturesPersistenceForTests();
    renderScannerWithPage();
    await openPageReview();
    expect(screen.getByTestId(`${REVIEW}-add-all`)).toHaveTextContent('Add 3 · $31.00');
  });

  it('"Variant" applies only where that variant exists and reports the skips', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();
    await selectWholePage();

    fireEvent.press(screen.getByTestId(`${REVIEW}-batch-variant`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-batch-variant-menu-holofoil`));

    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-0-printing`)).toHaveTextContent('Holo');
      expect(screen.getByTestId(`${REVIEW}-pocket-1-printing`)).toHaveTextContent('Holo');
    });
    // Charmander has no Holofoil printing: left on its default (so it shows no
    // printing line at all), and counted in the notice.
    expect(screen.queryByTestId(`${REVIEW}-pocket-2-printing`)).toBeNull();
    expect(await screen.findByText('Applied to 2 of 3 · 1 has no Holofoil variant')).toBeTruthy();
    // 50 + 100 + 1
    expect(screen.getByTestId(`${REVIEW}-add-all`)).toHaveTextContent('Add 3 · $151.00');

    // A second batch reuses the cached matrices — no refetch. Going back to
    // Normal is a return to each card's own printing, so the lines go away.
    const callsAfterFirst = matrixCalls.length;
    fireEvent.press(screen.getByTestId(`${REVIEW}-batch-variant`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-batch-variant-menu-normal`));
    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-add-all`)).toHaveTextContent('Add 3 · $31.00');
    });
    expect(screen.queryByTestId(`${REVIEW}-pocket-0-printing`)).toBeNull();
    expect(screen.queryByTestId(`${REVIEW}-pocket-2-printing`)).toBeNull();
    expect(matrixCalls.length).toBe(callsAfterFirst);
  });

  it('hold-to-select scopes a batch to the pockets you picked', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();

    // Holding starts selection; a plain tap then picks rather than opening the
    // change-card picker.
    // Holding brings the toolbar in; a plain tap then picks rather than opening
    // the change-card picker. The ticks are the count — the toolbar shows none.
    fireEvent(screen.getByTestId(`${REVIEW}-pocket-0`), 'longPress');
    await screen.findByTestId(`${REVIEW}-batch`);
    fireEvent.press(screen.getByTestId(`${REVIEW}-pocket-2`));
    expect(screen.getByTestId(`${REVIEW}-pocket-0-tick`)).toBeTruthy();
    expect(screen.getByTestId(`${REVIEW}-pocket-2-tick`)).toBeTruthy();

    fireEvent.press(screen.getByTestId(`${REVIEW}-batch-variant`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-batch-variant-menu-holofoil`));

    // Alakazam took the Holofoil price; Charmander has none and was skipped.
    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-0-printing`)).toHaveTextContent('Holo');
    });
    // The pocket nobody picked is untouched — and the count reports the two.
    expect(screen.queryByTestId(`${REVIEW}-pocket-1-printing`)).toBeNull();
    expect(screen.queryByTestId(`${REVIEW}-pocket-2-printing`)).toBeNull();
    expect(await screen.findByText('Applied to 1 of 2 · 1 has no Holofoil variant')).toBeTruthy();

    // Done clears the selection and the toolbar leaves with it; the hint is back.
    fireEvent.press(screen.getByTestId(`${REVIEW}-batch-done`));
    expect(screen.queryByTestId(`${REVIEW}-batch`)).toBeNull();
    expect(screen.getByTestId(`${REVIEW}-hint`)).toHaveTextContent(/Hold to edit/);
  });

  it('starts the selection toolbar on the first card, not on the screen gutter', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();
    await selectWholePage();

    // The grid centers its columns inside the page's 16pt gutter, so the first
    // card starts inboard of it. The toolbar has to start on the same line.
    const tile = screen.getByTestId(`${REVIEW}-pocket-0`);
    const tileWidth = StyleSheet.flatten(tile.props.style).width as number;
    // 390pt frame, 16pt gutters, three columns and two 10pt gaps.
    const expectedInset = 16 + (390 - 32 - (3 * tileWidth + 2 * 10)) / 2;
    expect(expectedInset).toBeGreaterThan(16);

    const toolbar = screen.getByTestId(`${REVIEW}-batch`);
    expect(StyleSheet.flatten(toolbar.props.style).paddingLeft).toBeCloseTo(expectedInset);
  });

  it('names a printing only where it differs from the card\'s own, and abbreviates it', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();

    // Nothing set: the tile is art + name + set + price and nothing else.
    expect(screen.queryByTestId(`${REVIEW}-pocket-0-printing`)).toBeNull();

    await selectWholePage();
    fireEvent.press(screen.getByTestId(`${REVIEW}-batch-variant`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-batch-variant-menu-holofoil`));

    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-0-printing`)).toHaveTextContent('Holo');
    });
    // Charmander has no Holofoil, so it keeps its own printing and no label.
    expect(screen.queryByTestId(`${REVIEW}-pocket-2-printing`)).toBeNull();
  });

  it('keeps the cards the same size when a batch labels a printing', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();

    const widthOf = () => StyleSheet.flatten(
      screen.getByTestId(`${REVIEW}-pocket-0`).props.style,
    ).width as number;
    const before = widthOf();

    await selectWholePage();
    fireEvent.press(screen.getByTestId(`${REVIEW}-batch-variant`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-batch-variant-menu-holofoil`));
    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-0-printing`)).toHaveTextContent('Holo');
    });

    // The label rides the price row, so nothing resizes and nothing scrolls.
    expect(widthOf()).toBe(before);
  });

  it('offers no condition dropdown — condition lives on the card\'s price sheet', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();
    await selectWholePage();

    expect(screen.getByTestId(`${REVIEW}-batch-variant`)).toBeTruthy();
    expect(screen.queryByTestId(`${REVIEW}-batch-condition`)).toBeNull();
  });
});
