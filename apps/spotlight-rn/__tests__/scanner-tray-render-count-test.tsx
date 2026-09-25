import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
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
  The tray store's point: a change to ONE scan re-renders that scan's row and
  nothing else — not its siblings, not the 5,000-line screen around them.
  Counts renders of each row (via its swipe wrapper) and of the screen (via the
  scan-target pill, which re-renders whenever the screen does).
*/

const mockRowRenders = new Map<string, number>();
let mockScreenRenders = 0;

jest.mock('@/features/scanner/screens/recent-capture-swipe-row', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    RecentCaptureSwipeRow: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => {
      mockRowRenders.set(String(testID), (mockRowRenders.get(String(testID)) ?? 0) + 1);
      return <View testID={testID}>{children}</View>;
    },
  };
});

jest.mock('@/features/scanner/components/scan-target-pill', () => ({
  ScanTargetPill: () => {
    mockScreenRenders += 1;
    return null;
  },
}));

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

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({
      back: jest.fn(),
      canGoBack: jest.fn(() => false),
      push: mockPush,
      replace: jest.fn(),
      dismissTo: jest.fn(),
    }),
  };
});

const OWNER_ID = '00000000-0000-0000-0000-00000000000b';

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

const ROW_IDS = ['scan-a', 'scan-b', 'scan-c'];

function persistedRow(id: string, marketPrice: number) {
  return {
    id,
    scanID: `server-${id}`,
    mode: 'raw',
    uri: `${RECENT_CAPTURES_DIR}${id}.jpg`,
    normalizedImageUri: `${RECENT_CAPTURES_DIR}${id}.jpg`,
    candidates: [{
      id: `card-${id}`,
      cardId: `card-${id}`,
      name: `Card ${id}`,
      cardNumber: '#1/100',
      setName: 'Test Set',
      imageUrl: `https://cdn.spotlight.test/${id}.png`,
      marketPrice,
      currencyCode: 'USD',
    }],
    activeCandidateIndex: 0,
    totalCandidateCount: 1,
    matchReviewDisposition: null,
    matchReviewReason: null,
    slabContext: null,
    normalizedImageDimensions: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
  };
}

describe('ScannerScreen tray render isolation', () => {
  beforeEach(async () => {
    __resetRecentCapturesPersistenceForTests();
    __resetScannerTargetConfigForTests();
    await AsyncStorage.clear();
    mockRowRenders.clear();
    mockScreenRenders = 0;
    mockPush.mockReset();
  });

  it('patching one scan re-renders only that row, not its siblings or the screen', async () => {
    await AsyncStorage.setItem(
      RECENT_CAPTURES_STORAGE_KEY,
      JSON.stringify({
        version: PERSIST_ENVELOPE_VERSION,
        ownerKey: OWNER_ID,
        items: ROW_IDS.map((id, index) => persistedRow(id, index + 1)),
      }),
    );
    const spotlightRepository = createTestSpotlightRepository({
      getRawPricingMatrix: async (cardId: string) => ({ cardID: cardId, currencyCode: 'USD', variants: [] }),
    });
    renderWithProviders(<ScannerScreen />, { spotlightRepository });

    await waitFor(() => {
      expect(screen.getByTestId('scanner-value-pill-text')).toHaveTextContent('TOTAL: $6.00');
    });
    // Let rehydration, inventory and printings lookups settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const rowsBefore = new Map(mockRowRenders);
    const screenBefore = mockScreenRenders;

    // Opening a card marks that one row as resolved (hasTrackedSelectionEvent)
    // — a single-row patch the screen draws nothing from.
    fireEvent.press(screen.getByTestId('scanner-tray-open-card-scan-b'));
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalled();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const delta = (id: string) => (mockRowRenders.get(`scanner-tray-swipe-${id}`) ?? 0)
      - (rowsBefore.get(`scanner-tray-swipe-${id}`) ?? 0);
    expect(delta('scan-b')).toBe(1);
    expect(delta('scan-a')).toBe(0);
    expect(delta('scan-c')).toBe(0);
    expect(mockScreenRenders).toBe(screenBefore);
  });
});
