import { act, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createRef } from 'react';
import { View } from 'react-native';

import {
  __resetRecentCapturesPersistenceForTests,
  RECENT_CAPTURES_DIR,
} from '@/features/scanner/recent-captures-persistence';
import type { RawScannerCameraHandle, RawScannerFrameRect } from '@/features/scanner/raw-scanner-capture-surface';
import {
  makeRawScannerCaptureLayout,
  RawScannerCaptureSurface,
} from '@/features/scanner/raw-scanner-capture-surface';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { formatCurrency } from '@/features/scanner/screens/scanner-screen-helpers';
import { __resetScannerTargetConfigForTests } from '@/features/scanner/use-scanner-target-config';
import { buildDevScannerPreview, devScannerPricingMatrices } from '@/dev/dev-scanner-screen';
import { DEV_SCAN_BINDER, DEV_SCAN_SINGLE } from '@/dev/dev-scanner-fixtures';

import { seedTrayRows } from '../test-support/scan-tray-db';
import { createTestSpotlightRepository, renderWithProviders } from './test-utils';

/*
  The dev screenshot routes (`spotlight://dev/scanner`, `/dev/scanner-binder`)
  render the REAL scanner over a still image with a pre-filled tray. What has to
  hold: no camera mounts, the seeded rows are what the tray shows (a persisted
  tray from the same account must NOT bleed in), and the header reads the
  fixture's count and total. The surface seam is covered on its own: the scene
  callback gets the frame the reticle actually draws.
*/

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

const OWNER_ID = '00000000-0000-0000-0000-00000000000c';

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

// A row this account already has on disk — the dev preview must ignore it.
const persistedRow = {
  id: 'persisted-scan',
  scanID: 'server-persisted-scan',
  mode: 'raw',
  uri: `${RECENT_CAPTURES_DIR}persisted-scan.jpg`,
  normalizedImageUri: `${RECENT_CAPTURES_DIR}persisted-scan.jpg`,
  candidates: [{
    id: 'card-persisted',
    cardId: 'card-persisted',
    name: 'Persisted Card',
    cardNumber: '#1/100',
    setName: 'Test Set',
    imageUrl: 'https://cdn.spotlight.test/persisted.png',
    marketPrice: 999,
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

// Fixture names/sets carry regex metacharacters ("Scarlet & Violet", "ex").
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderDevScanner(mode: 'single' | 'binder') {
  const getRawPricingMatrix = jest.fn(async (cardId: string) => (
    devScannerPricingMatrices[cardId] ?? { cardID: cardId, currencyCode: 'USD', variants: [] }
  ));
  const spotlightRepository = createTestSpotlightRepository({ getRawPricingMatrix });
  renderWithProviders(
    <ScannerScreen devPreview={buildDevScannerPreview(mode)} />,
    { spotlightRepository },
  );
  return { getRawPricingMatrix };
}

async function settle() {
  // Let the inventory and printings lookups land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('ScannerScreen dev preview', () => {
  beforeEach(async () => {
    __resetRecentCapturesPersistenceForTests();
    __resetScannerTargetConfigForTests();
    await AsyncStorage.clear();
    await seedTrayRows(OWNER_ID, [persistedRow]);
  });

  it('renders the still image instead of the camera and seeds the single-card tray', async () => {
    const { getRawPricingMatrix } = renderDevScanner('single');

    expect(screen.getByTestId('scanner-camera-preview-override')).toBeTruthy();
    expect(screen.queryByTestId('scanner-camera')).toBeNull();
    expect(screen.getByTestId('dev-scanner-scene')).toBeTruthy();
    // Permission is taken as granted: no denied card, no prompt copy.
    expect(screen.queryByTestId('scanner-camera-denied')).toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId('scanner-recent-title')).toHaveTextContent('SCAN: 1');
    });
    expect(screen.getByTestId('scanner-value-pill-text')).toHaveTextContent(
      `TOTAL: ${formatCurrency(DEV_SCAN_SINGLE.priceUsd)}`,
    );
    const row = screen.getByTestId('scanner-tray-row-dev-scan-single');
    expect(row).toHaveTextContent(new RegExp(escapeRegExp(DEV_SCAN_SINGLE.name)));
    // Set · #number, the way a resolved row reads it.
    expect(row).toHaveTextContent(
      new RegExp(escapeRegExp(`${DEV_SCAN_SINGLE.setName} · #${DEV_SCAN_SINGLE.collectorNumber}`)),
    );
    expect(row).toHaveTextContent(new RegExp(escapeRegExp(formatCurrency(DEV_SCAN_SINGLE.priceUsd))));

    await settle();
    // The printing link needs the card's matrix, which the dev repository serves.
    expect(getRawPricingMatrix).toHaveBeenCalledWith(DEV_SCAN_SINGLE.cardId);
    expect(screen.getByTestId('scanner-tray-printing-dev-scan-single-label')).toHaveTextContent(
      DEV_SCAN_SINGLE.printing,
    );
    // The persisted tray stayed on disk — the preview never rehydrates.
    expect(screen.queryByTestId('scanner-tray-row-persisted-scan')).toBeNull();
  });

  it('seeds the nine-pocket binder page with its total and the page grid', async () => {
    renderDevScanner('binder');

    await waitFor(() => {
      expect(screen.getByTestId('scanner-recent-title')).toHaveTextContent('SCAN: 9');
    });
    const total = DEV_SCAN_BINDER.reduce((sum, card) => sum + card.priceUsd, 0);
    expect(screen.getByTestId('scanner-value-pill-text')).toHaveTextContent(`TOTAL: ${formatCurrency(total)}`);
    // Page mode is armed from the start: the thirds grid is inside the frame.
    expect(screen.getByTestId('scanner-binder-grid')).toBeTruthy();
    // Pocket 0's row id IS the page id, like a real page scan.
    expect(screen.getByTestId('scanner-tray-row-dev-binder-page')).toHaveTextContent(
      new RegExp(escapeRegExp(DEV_SCAN_BINDER[0].name)),
    );
    expect(screen.queryByTestId('scanner-tray-row-persisted-scan')).toBeNull();
    await settle();
  });
});

describe('RawScannerCaptureSurface previewOverride', () => {
  async function renderSurface(
    mode: 'card' | 'page',
    renderScene: (frame: RawScannerFrameRect) => React.ReactNode,
  ) {
    const layout = makeRawScannerCaptureLayout({
      containerHeight: 844,
      containerWidth: 390,
      mode,
      safeAreaTop: 59,
    });
    render(
      <RawScannerCaptureSurface
        cameraRef={createRef<RawScannerCameraHandle>()}
        canCapture={false}
        captureResolution={mode}
        hasCameraPermission
        layout={layout}
        onCameraReady={() => {}}
        onCapture={() => {}}
        pageGrid={mode === 'page' ? { columns: 3, rows: 3 } : null}
        previewOverride={{ renderScene, source: 1 }}
        prompt=""
        shouldMountCamera
        testIDPrefix="surface"
      />,
    );
    // Flush the surface's (zero-ms in tests) shutter settle timer inside act.
    await settle();
    return layout;
  }

  it('hands the scene the visible reticle in card mode', async () => {
    const renderScene = jest.fn((_frame: RawScannerFrameRect) => <View testID="scene" />);
    const layout = await renderSurface('card', renderScene);

    expect(screen.getByTestId('surface-camera-preview-override')).toBeTruthy();
    expect(screen.queryByTestId('surface-camera')).toBeNull();
    expect(screen.getByTestId('scene')).toBeTruthy();
    expect(renderScene).toHaveBeenCalledWith(layout.reticle);
  });

  it('hands the scene the page crop in binder mode, where the grid is drawn', async () => {
    const renderScene = jest.fn((_frame: RawScannerFrameRect) => <View testID="scene" />);
    const layout = await renderSurface('page', renderScene);

    expect(renderScene).toHaveBeenCalledWith(layout.captureCropRect);
    expect(screen.getByTestId('surface-binder-grid')).toBeTruthy();
  });
});
