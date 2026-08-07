import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { TabsPageContext } from '@/contexts/tabs-page-context';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { __resetScannerTargetConfigForTests } from '@/features/scanner/use-scanner-target-config';

import { renderWithProviders } from './test-utils';

// The account the mocked auth session reports. Keys are per-account, so every
// assertion below pins the exact suffixed key.
const mockSessionUserId = '11111111-2222-3333-4444-555555555555';

// Legacy AsyncStorage flag (wiped on app uninstall) and its SecureStore twin
// (survives reinstall via the iOS Keychain, like the Supabase session). The
// SecureStore spelling is dotted because SecureStore keys only allow
// [A-Za-z0-9._-].
const LEGACY_SEEN_KEY = `@spotlight/scanner/language-tooltip-seen:${mockSessionUserId}`;
const SECURE_SEEN_KEY = `spotlight.scanner.language-tooltip-seen.${mockSessionUserId}`;

// In-memory AsyncStorage stand-in. State lives inside the factory so it is
// initialized when the hoisted mock first runs.
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

// Stateful expo-secure-store mock (jest.setup.ts's global one is stateless):
// tests seed/inspect the flag through `__store` and assert on the jest.fn calls.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
});

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

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentSession: { user: { id: mockSessionUserId } },
    currentUser: {
      adminEnabled: false,
      avatarURL: null,
      displayName: 'UI Test User',
      email: 'ui-tests@spotlight.local',
      id: mockSessionUserId,
      labelerEnabled: true,
      providers: ['ui-tests'],
    },
  }),
}));

jest.mock('@/features/scanner/scanner-smoke-fixtures', () => ({
  loadRawScannerSmokeFixture: jest.fn(),
}));

jest.mock('@/features/scanner/slab-native-analysis', () => ({
  analyzePSASlabCapture: jest.fn(),
}));

const secureStoreMock = jest.requireMock('expo-secure-store') as {
  __store: Map<string, string>;
  deleteItemAsync: jest.Mock;
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
};

// Flush the read chain (SecureStore read → legacy AsyncStorage read →
// setState) — every promise in the mocks resolves on a microtask, so a few
// awaited ticks inside act() settle it deterministically.
async function flushTooltipReads() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

describe('ScannerScreen language-tooltip seen flag (SecureStore + legacy AsyncStorage)', () => {
  beforeEach(async () => {
    __resetScannerTargetConfigForTests();
    secureStoreMock.__store.clear();
    secureStoreMock.getItemAsync.mockClear();
    secureStoreMock.setItemAsync.mockClear();
    secureStoreMock.deleteItemAsync.mockClear();
    await AsyncStorage.clear();
    (AsyncStorage.getItem as jest.Mock).mockClear();
    (AsyncStorage.setItem as jest.Mock).mockClear();
  });

  it('does not show the tooltip when the SecureStore flag is set (post-reinstall path)', async () => {
    // The AsyncStorage flag is absent — exactly the uninstall/reinstall state
    // this fix targets: only the Keychain-backed flag survived.
    secureStoreMock.__store.set(SECURE_SEEN_KEY, '1');

    renderWithProviders(<ScannerScreen />);

    await waitFor(() => {
      expect(secureStoreMock.getItemAsync).toHaveBeenCalledWith(SECURE_SEEN_KEY);
    });
    await flushTooltipReads();

    expect(screen.queryByTestId('scanner-language-tooltip')).toBeNull();
    // The SecureStore hit short-circuits the read — the legacy flag is never consulted.
    expect(AsyncStorage.getItem).not.toHaveBeenCalledWith(LEGACY_SEEN_KEY);
  });

  it('migrates a legacy AsyncStorage flag into SecureStore without showing the tooltip', async () => {
    await AsyncStorage.setItem(LEGACY_SEEN_KEY, '1');
    (AsyncStorage.setItem as jest.Mock).mockClear();

    renderWithProviders(<ScannerScreen />);

    // Migration: the legacy '1' is copied forward into SecureStore...
    await waitFor(() => {
      expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(SECURE_SEEN_KEY, '1');
    });
    await flushTooltipReads();

    // ...and the coach mark stays hidden.
    expect(screen.queryByTestId('scanner-language-tooltip')).toBeNull();
    expect(secureStoreMock.__store.get(SECURE_SEEN_KEY)).toBe('1');
  });

  it('shows the tooltip when neither store has the flag, and dismissal writes both', async () => {
    renderWithProviders(<ScannerScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('scanner-language-tooltip')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('scanner-language-tooltip'));

    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(LEGACY_SEEN_KEY, '1');
      expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(SECURE_SEEN_KEY, '1');
    });
    // The bubble unmounts once its 180ms fade-out completes.
    await waitFor(() => {
      expect(screen.queryByTestId('scanner-language-tooltip')).not.toBeOnTheScreen();
    });
  });

  it('does not read or show anything while the scanner is not the active tab', async () => {
    renderWithProviders(
      <TabsPageContext.Provider
        value={{
          activePage: 'portfolio',
          chartScrubLockRef: { current: false },
          collectionEditing: false,
          setCollectionEditing: () => {},
        }}
      >
        <ScannerScreen />
      </TabsPageContext.Provider>,
    );

    await flushTooltipReads();

    expect(screen.queryByTestId('scanner-language-tooltip')).toBeNull();
    expect(secureStoreMock.getItemAsync).not.toHaveBeenCalledWith(SECURE_SEEN_KEY);
    expect(AsyncStorage.getItem).not.toHaveBeenCalledWith(LEGACY_SEEN_KEY);
  });
});
