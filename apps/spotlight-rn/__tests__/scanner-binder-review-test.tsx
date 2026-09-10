import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StyleSheet } from 'react-native';

import { colors } from '@spotlight/design-system';

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

  it('shows each pocket\'s assumed printing and opens the price sheet from the chip', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();

    expect(screen.getByTestId(`${REVIEW}-pocket-0-printing-label`).props.children).toBe('Default');
    expect(StyleSheet.flatten(screen.getByTestId(`${REVIEW}-pocket-0-printing-label`).props.style).color)
      .toBe(colors.gray600);

    fireEvent.press(screen.getByTestId(`${REVIEW}-pocket-0-printing`));
    fireEvent.press(await screen.findByTestId('scan-price-sheet-row-holofoil-LP'));

    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-0-printing-label`).props.children).toBe('Holofoil');
    });
    expect(StyleSheet.flatten(screen.getByTestId(`${REVIEW}-pocket-0-printing-label`).props.style).color)
      .toBe(colors.gray900);
    // Add-all reflects the page's shown prices: 40 (Holofoil LP) + 20 + 1.
    expect(screen.getByTestId(`${REVIEW}-add-all`)).toHaveTextContent('Add 3 · $61.00');
  });

  it('"Set all → Printing" updates every pocket that has it and persists the choices', async () => {
    await seedPersistedPage();
    const view = renderScannerWithPage();
    await openPageReview();

    fireEvent.press(screen.getByTestId(`${REVIEW}-set-all-printing`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-set-all-printing-normal`));

    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-0-printing-label`).props.children).toBe('Normal');
      expect(screen.getByTestId(`${REVIEW}-pocket-1-printing-label`).props.children).toBe('Normal');
      expect(screen.getByTestId(`${REVIEW}-pocket-2-printing-label`).props.children).toBe('Normal');
    });
    expect(await screen.findByText('Applied to 3 of 3')).toBeTruthy();
    // NM prices for the Normal printing: 10 + 20 + 1
    expect(screen.getByTestId(`${REVIEW}-add-all`)).toHaveTextContent('Add 3 · $31.00');
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
    expect(screen.getByTestId(`${REVIEW}-pocket-1-printing-label`).props.children).toBe('Normal');
  });

  it('"Set all → Printing" applies only where that printing exists and reports the skips', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();

    fireEvent.press(screen.getByTestId(`${REVIEW}-set-all-printing`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-set-all-printing-holofoil`));

    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-0-printing-label`).props.children).toBe('Holofoil');
      expect(screen.getByTestId(`${REVIEW}-pocket-1-printing-label`).props.children).toBe('Holofoil');
    });
    // Charmander has no Holofoil printing: left on its default, and counted.
    expect(screen.getByTestId(`${REVIEW}-pocket-2-printing-label`).props.children).toBe('Default');
    expect(await screen.findByText('Applied to 2 of 3 · 1 has no Holofoil printing')).toBeTruthy();
    // 50 + 100 + 1
    expect(screen.getByTestId(`${REVIEW}-add-all`)).toHaveTextContent('Add 3 · $151.00');

    // A second batch reuses the cached matrices — no refetch.
    const callsAfterFirst = matrixCalls.length;
    fireEvent.press(screen.getByTestId(`${REVIEW}-set-all-printing`));
    fireEvent.press(await screen.findByTestId(`${REVIEW}-set-all-printing-normal`));
    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-0-printing-label`).props.children).toBe('Normal');
      expect(screen.getByTestId(`${REVIEW}-pocket-2-printing-label`).props.children).toBe('Normal');
    });
    expect(matrixCalls.length).toBe(callsAfterFirst);
  });

  it('"Not sure?" on a low-confidence pocket offers the top alternates inline', async () => {
    await seedPersistedPage();
    renderScannerWithPage();
    await openPageReview();

    // Only the low-confidence pocket carries the affordance.
    expect(screen.queryByTestId(`${REVIEW}-pocket-0-not-sure`)).toBeNull();
    fireEvent.press(screen.getByTestId(`${REVIEW}-pocket-1-not-sure`));

    const strip = await screen.findByTestId(`${REVIEW}-alternates`);
    expect(strip).toHaveTextContent(/Pocket 2 · other matches/);
    expect(screen.getByTestId(`${REVIEW}-alternates-1`)).toHaveTextContent(/Blastoise \(alt\)/);

    fireEvent.press(screen.getByTestId(`${REVIEW}-alternates-1`));

    await waitFor(() => {
      expect(screen.getByTestId(`${REVIEW}-pocket-1`)).toHaveTextContent(/Blastoise \(alt\)/);
    });
    expect(screen.queryByTestId(`${REVIEW}-alternates`)).toBeNull();
    // 10 + 15 + 1
    expect(screen.getByTestId(`${REVIEW}-add-all`)).toHaveTextContent('Add 3 · $26.00');
  });
});
