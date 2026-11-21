import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import { StyleSheet } from 'react-native';

import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { clearScanCandidateReviewSessions } from '@/features/scanner/scan-candidate-review-session';
import { __resetScannerTargetConfigForTests } from '@/features/scanner/use-scanner-target-config';

import { createTestSpotlightRepository, renderWithProviders } from './test-utils';

/*
  Two scanner reliability contracts:
  - ADD on a tray row scanned as a guest works once the guest has signed in,
    and every ADD tap reports `scan_add_tapped` with an outcome; a tap that
    can't add says why instead of doing nothing.
  - Shutter taps that land while a capture is in flight or the camera is
    settling are queued and fired in order — one tap, one scan, never two
    capturePhoto calls at once.
*/

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({
      back: jest.fn(),
      canGoBack: () => false,
      dismissTo: jest.fn(),
      push: mockPush,
      replace: jest.fn(),
    }),
  };
});

const mockCapture = jest.fn();
jest.mock('@/lib/observability/posthog', () => ({
  ...jest.requireActual('@/lib/observability/posthog'),
  capturePostHogEvent: (...args: unknown[]) => mockCapture(...args),
}));

let mockIsGuest = false;
let mockCurrentSession: { access_token: string; user: { id: string; is_anonymous: boolean } } | null = null;
const mockEnsureGuestSession = jest.fn(async () => {
  mockCurrentSession = { access_token: 'anon', user: { id: 'guest-1', is_anonymous: true } };
  return mockCurrentSession as any;
});

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentSession: mockCurrentSession,
    currentUser: {
      adminEnabled: false,
      avatarURL: null,
      displayName: 'UI Test User',
      email: 'ui-tests@spotlight.local',
      id: 'guest-1',
      labelerEnabled: false,
      providers: ['ui-tests'],
    },
    ensureGuestSession: mockEnsureGuestSession,
    isGuest: mockIsGuest,
  }),
}));

const visionCameraMock = jest.requireMock('react-native-vision-camera') as {
  usePhotoOutput: () => { capturePhoto: jest.Mock };
};
// The mock hook returns one shared jest.fn; it is not a real hook.
const mockCapturePhoto = visionCameraMock.usePhotoOutput().capturePhoto;
const { getInfoAsync } = jest.requireMock('expo-file-system/legacy') as { getInfoAsync: jest.Mock };

const trayRowTestIdPattern = /^scanner-tray-row-/;

// Newest row on screen (the tray is a recycled FlashList: order by cell `top`).
function newestRowCaptureId(): string {
  const rows = screen.queryAllByTestId(trayRowTestIdPattern);
  const top = (node: any): number => {
    for (let current = node; current; current = current.parent) {
      const style = StyleSheet.flatten(current.props.style) as { position?: string; top?: unknown } | undefined;
      if (style?.position === 'absolute' && typeof style.top === 'number') {
        return style.top;
      }
    }
    return Number.POSITIVE_INFINITY;
  };
  const sorted = rows.map((row, index) => ({ index, row, top: top(row) }))
    .sort((a, b) => a.top - b.top || a.index - b.index);
  if (!sorted[0]) {
    throw new Error('No tray rows');
  }
  return String(sorted[0].row.props.testID).replace(trayRowTestIdPattern, '');
}

function renderScanner(
  options?: Parameters<typeof renderWithProviders>[1],
  props?: ComponentProps<typeof ScannerScreen>,
) {
  return renderWithProviders(<ScannerScreen {...props} />, options);
}

async function waitForScannerReady() {
  await waitFor(() => {
    expect(screen.getByTestId('scanner-preview').props.accessibilityState?.disabled).toBe(false);
  });
}

function addTappedEvents() {
  return mockCapture.mock.calls.filter(([event]) => event === 'scan_add_tapped').map(([, props]) => props);
}

function countingRepository(createInventoryEntry: jest.Mock) {
  let scanCount = 0;
  return createTestSpotlightRepository({
    createInventoryEntry,
    getInventoryEntries: async () => [],
    matchScannerCapture: async () => {
      scanCount += 1;
      return {
        scanID: `scan-${scanCount}`,
        candidates: [{
          id: `mcdonalds25-${scanCount}`,
          cardId: `mcdonalds25-${scanCount}`,
          name: `Card ${scanCount}`,
          cardNumber: `#${scanCount}/25`,
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
          marketPrice: 0.56,
          currencyCode: 'USD',
        }],
      };
    },
  });
}

function inventoryEntryResponse(payload: any) {
  return {
    deckEntryID: `entry-${payload.cardID}`,
    cardID: payload.cardID,
    variantName: null,
    condition: payload.condition,
    confirmationID: null,
    sourceScanID: payload.sourceScanID,
    addedAt: payload.addedAt,
  };
}

beforeEach(() => {
  clearCardDetailCache();
  clearScanCandidateReviewSessions();
  __resetScannerTargetConfigForTests();
  mockIsGuest = false;
  mockCurrentSession = null;
  mockPush.mockReset();
  mockCapture.mockReset();
  mockEnsureGuestSession.mockClear();
  mockCapturePhoto.mockClear();
  getInfoAsync.mockImplementation(async () => ({ exists: true }));
});

afterEach(() => {
  getInfoAsync.mockImplementation(async () => ({ exists: false }));
});

describe('scanner ADD after a guest signs in', () => {
  it('adds rows scanned as a guest, and new rows, once the guest has converted', async () => {
    mockIsGuest = true;
    const createInventoryEntry = jest.fn(async (payload: any) => inventoryEntryResponse(payload));
    const spotlightRepository = countingRepository(createInventoryEntry);

    // Pending guest (no session): the first scan mints the anonymous user.
    const guestView = renderScanner({ spotlightRepository });
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    expect(await screen.findByText('Card 1')).toBeTruthy();
    guestView.rerender(<ScannerScreen />);
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    expect(await screen.findByText('Card 2')).toBeTruthy();

    // Guest ADD goes to sign-in and adds nothing.
    fireEvent.press(screen.getByTestId(`scanner-tray-add-${newestRowCaptureId()}`));
    expect(mockPush).toHaveBeenCalledWith('/login');
    expect(createInventoryEntry).not.toHaveBeenCalled();
    expect(addTappedEvents()).toEqual([{ outcome: 'login_required', source: 'pill' }]);

    // Conversion keeps the uuid; the provider key flips, so the app remounts and
    // the scanner rehydrates the tray from disk, now signed in.
    guestView.unmount();
    mockIsGuest = false;
    mockCurrentSession = { access_token: 'real', user: { id: 'guest-1', is_anonymous: false } };
    renderScanner({ spotlightRepository });
    expect(await screen.findByText('Card 2')).toBeTruthy();

    const guestRowId = newestRowCaptureId();
    fireEvent.press(screen.getByTestId(`scanner-tray-add-${guestRowId}`));
    await waitFor(() => {
      expect(createInventoryEntry).toHaveBeenCalledTimes(1);
    });
    expect(createInventoryEntry.mock.calls[0][0].cardID).toBe('mcdonalds25-2');
    // The row reaches "added" and leaves the tray.
    await waitFor(() => {
      expect(screen.queryByTestId(`scanner-tray-row-${guestRowId}`)).not.toBeOnTheScreen();
    }, { timeout: 2500 });

    // A card scanned after signing in adds too.
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    expect(await screen.findByText('Card 3')).toBeTruthy();
    fireEvent.press(screen.getByTestId(`scanner-tray-add-${newestRowCaptureId()}`));
    await waitFor(() => {
      expect(createInventoryEntry).toHaveBeenCalledTimes(2);
    });
    expect(addTappedEvents().slice(1)).toEqual([
      { outcome: 'started', source: 'pill' },
      { outcome: 'started', source: 'pill' },
    ]);
  });

  it('tells the user when an add fails instead of failing silently', async () => {
    mockCurrentSession = { access_token: 'real', user: { id: 'user-1', is_anonymous: false } };
    const createInventoryEntry = jest.fn(async () => {
      throw new Error('network down');
    });
    renderScanner({ spotlightRepository: countingRepository(createInventoryEntry) });
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    expect(await screen.findByText('Card 1')).toBeTruthy();

    const rowId = newestRowCaptureId();
    fireEvent.press(screen.getByTestId(`scanner-tray-add-${rowId}`));

    expect(await screen.findByText("Couldn't add Card 1. Try again.")).toBeTruthy();
    expect(mockCapture).toHaveBeenCalledWith('scan_inventory_add_failed', expect.objectContaining({ mode: 'raw' }));
    // The row stays, ready for another try.
    expect(screen.getByTestId(`scanner-tray-add-${rowId}`).props.accessibilityState?.disabled).toBeFalsy();
  });
});

describe('scanner shutter tap queue', () => {
  function deferredPhoto() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('turns a rapid double tap into exactly two captures, one after the other', async () => {
    mockCurrentSession = { access_token: 'real', user: { id: 'user-1', is_anonymous: false } };
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: ReturnType<typeof deferredPhoto>[] = [];
    mockCapturePhoto.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = deferredPhoto();
      gates.push(gate);
      await gate.promise;
      inFlight -= 1;
      return {
        width: 1080,
        height: 1620,
        saveToTemporaryFileAsync: jest.fn(async () => '/mock-scan.jpg'),
        dispose: jest.fn(),
      };
    });

    renderScanner({ spotlightRepository: countingRepository(jest.fn()) });
    await waitForScannerReady();

    // Two taps in the same tick: the second lands while the first is in flight.
    fireEvent.press(screen.getByTestId('scanner-preview'));
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(mockCapturePhoto).toHaveBeenCalledTimes(1);
    });
    // Queued, not dropped, and not reported as blocked.
    expect(mockCapture).not.toHaveBeenCalledWith('scan_shutter_blocked', expect.anything());

    await act(async () => {
      gates[0]?.resolve();
    });
    await waitFor(() => {
      expect(mockCapturePhoto).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      gates[1]?.resolve();
    });

    expect(await screen.findByText('Card 2')).toBeTruthy();
    expect(maxInFlight).toBe(1);
    expect(mockCapturePhoto).toHaveBeenCalledTimes(2);
    mockCapturePhoto.mockReset();
    mockCapturePhoto.mockImplementation(async () => ({
      width: 1080,
      height: 1620,
      saveToTemporaryFileAsync: jest.fn(async () => '/mock-scan.jpg'),
      dispose: jest.fn(),
    }));
  });

  it('queues every tap in a burst (no count cap), firing one capture at a time', async () => {
    mockCurrentSession = { access_token: 'real', user: { id: 'user-1', is_anonymous: false } };
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: ReturnType<typeof deferredPhoto>[] = [];
    mockCapturePhoto.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = deferredPhoto();
      gates.push(gate);
      await gate.promise;
      inFlight -= 1;
      return {
        width: 1080,
        height: 1620,
        saveToTemporaryFileAsync: jest.fn(async () => '/mock-scan.jpg'),
        dispose: jest.fn(),
      };
    });

    renderScanner({ spotlightRepository: countingRepository(jest.fn()) });
    await waitForScannerReady();

    for (let tap = 0; tap < 6; tap += 1) {
      fireEvent.press(screen.getByTestId('scanner-preview'));
    }
    for (let shot = 1; shot <= 6; shot += 1) {
      await waitFor(() => {
        expect(mockCapturePhoto).toHaveBeenCalledTimes(shot);
      });
      await act(async () => {
        gates[shot - 1]?.resolve();
      });
    }

    // Let the six scans finish matching so nothing leaks into the next test.
    expect(await screen.findByText('Card 6')).toBeTruthy();
    expect(mockCapturePhoto).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(1);
    expect(mockCapture).not.toHaveBeenCalledWith('scan_shutter_blocked', expect.anything());
    mockCapturePhoto.mockReset();
    mockCapturePhoto.mockImplementation(async () => ({
      width: 1080,
      height: 1620,
      saveToTemporaryFileAsync: jest.fn(async () => '/mock-scan.jpg'),
      dispose: jest.fn(),
    }));
  });

  it('fires a tap made during the camera settle window once the window closes', async () => {
    jest.useFakeTimers();
    try {
      mockCurrentSession = { access_token: 'real', user: { id: 'user-1', is_anonymous: false } };
      renderScanner({ spotlightRepository: countingRepository(jest.fn()) });

      // The settle timer has not run yet: the shutter is gated.
      expect(screen.getByTestId('scanner-preview').props.accessibilityState?.disabled).toBe(true);
      fireEvent.press(screen.getByTestId('scanner-preview'));
      expect(mockCapturePhoto).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(10);
      });
      await waitFor(() => {
        expect(mockCapturePhoto).toHaveBeenCalledTimes(1);
      });
      expect(mockCapture).not.toHaveBeenCalledWith('scan_shutter_blocked', expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops a queued tap when the tray is expanded over the shutter', async () => {
    mockCurrentSession = { access_token: 'real', user: { id: 'user-1', is_anonymous: false } };
    renderScanner({ spotlightRepository: countingRepository(jest.fn()) });
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    expect(await screen.findByText('Card 1')).toBeTruthy();
    await waitForScannerReady();
    mockCapturePhoto.mockClear();

    // First tap holds the camera; the second queues behind it.
    let releasePhoto: () => void = () => {};
    mockCapturePhoto.mockImplementationOnce(() => new Promise((resolve) => {
      releasePhoto = () => resolve({
        width: 1080,
        height: 1620,
        saveToTemporaryFileAsync: jest.fn(async () => '/mock-scan.jpg'),
        dispose: jest.fn(),
      });
    }));
    fireEvent.press(screen.getByTestId('scanner-preview'));
    fireEvent.press(screen.getByTestId('scanner-preview'));
    await waitFor(() => {
      expect(mockCapturePhoto).toHaveBeenCalledTimes(1);
    });

    // The tray covers the shutter: the queued tap is dropped, not fired later.
    fireEvent.press(screen.getByTestId('scanner-tray-header'));
    await waitFor(() => {
      expect(screen.queryByTestId('scanner-preview')).not.toBeOnTheScreen();
    });
    fireEvent.press(screen.getByTestId('scanner-tray-header'));
    await act(async () => {
      releasePhoto();
    });
    expect(await screen.findByText('Card 2')).toBeTruthy();
    await waitForScannerReady();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(mockCapturePhoto).toHaveBeenCalledTimes(1);
  });
});
