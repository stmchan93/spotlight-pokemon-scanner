import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import type { ComponentProps } from 'react';
import { AppState, Keyboard, LayoutAnimation, StyleSheet } from 'react-native';

import { colors } from '@spotlight/design-system';

import { TabsPageContext } from '@/contexts/tabs-page-context';
import { rawScannerTrayEmptyPeekHeight } from '@/features/scanner/raw-scanner-capture-surface';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import {
  clearScanCandidateReviewSessions,
  getScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';
import { __resetScannerTargetConfigForTests } from '@/features/scanner/use-scanner-target-config';

import { createTestSpotlightRepository, renderWithProviders } from './test-utils';

const { useKeepAwake } = jest.requireMock('expo-keep-awake') as {
  useKeepAwake: jest.Mock;
};

const mockLoadRawScannerSmokeFixture = jest.fn(async () => ({
  nativeSourceImageDimensions: { height: 880, width: 630 },
  normalizationRotationDegrees: 0,
  normalizedImageBase64: 'c21va2UtZml4dHVyZS1iYXNlNjQ=',
  normalizedImageDimensions: { height: 880, width: 630 },
  normalizedImageUri: 'file:///scanner-smoke-fixture.jpg',
  sourceImageCrop: { height: 880, width: 630, x: 0, y: 0 },
}));
const mockAnalyzeSlabCapture = jest.fn(async (_imageUri: string): Promise<any> => ({
  parsed: {
    unsupportedReason: null,
  },
  scannerMatchFields: {
    slabGrader: 'PSA',
    slabGrade: '9',
    slabCertNumber: '12345678',
    slabBarcodePayloads: ['12345678'],
    slabParsedLabelText: ['PSA 9 Mega Dragonite ex 232/193 M2a'],
    slabCardNumberRaw: '232/193',
    slabGraderConfidence: 0.98,
    slabGradeConfidence: 0.94,
    slabCertConfidence: 0.99,
    slabClassifierReasons: ['barcode_cert_match', 'psa_label_detected'],
    slabRecommendedLookupPath: 'psa_cert' as const,
    ocrAnalysis: {
      slabEvidence: {
        titleTextPrimary: 'Mega Dragonite ex',
        cardNumber: '232/193',
        setHints: ['m2a'],
        grader: 'PSA',
        grade: '9',
        cert: '12345678',
        labelWideText: 'PSA 9 Mega Dragonite ex 232/193 M2a',
      },
    },
  },
}));

jest.mock('@/features/scanner/scanner-smoke-fixtures', () => ({
  loadRawScannerSmokeFixture: () => mockLoadRawScannerSmokeFixture(),
}));

jest.mock('@/features/scanner/slab-native-analysis', () => ({
  analyzePSASlabCapture: (imageUri: string) => mockAnalyzeSlabCapture(imageUri),
}));

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => false);
const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockConfigureNext = jest.spyOn(LayoutAnimation, 'configureNext').mockImplementation(jest.fn());
const keyboardDismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
const mockedConstants = Constants as any;

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');

  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({
      back: mockBack,
      canGoBack: mockCanGoBack,
      push: mockPush,
      replace: mockReplace,
      dismissTo: mockDismissTo,
    }),
  };
});

// Guest mode: `isGuest` flips the scanner into the first-launch experience, and
// `ensureGuestSession` is the deferred Supabase anonymous-user mint (a billable
// MAU) the capture path must pay for exactly once, and only on a real scan.
const mockGuestSession = { access_token: 'anon-token', user: { id: 'guest-1', is_anonymous: true } };
const mockEnsureGuestSession = jest.fn(async () => mockGuestSession as any);
let mockIsGuest = false;

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentUser: {
      adminEnabled: false,
      avatarURL: null,
      displayName: 'UI Test User',
      email: 'ui-tests@spotlight.local',
      id: '00000000-0000-0000-0000-000000000001',
      labelerEnabled: true,
      providers: ['ui-tests'],
    },
    ensureGuestSession: mockEnsureGuestSession,
    isGuest: mockIsGuest,
  }),
}));

function renderScannerScreen(
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

// NOTE: Slab/graded scanning is intentionally gated off — grading moved to the
// PDP, so the scanner is raw/visual only and no longer exposes a Graded toggle.
// The slab lane code is kept dormant; its UI-driven tests were removed with it.

describe('ScannerScreen', () => {
  const originalExtra = mockedConstants.expoConfig?.extra
    ? { ...mockedConstants.expoConfig.extra }
    : {};
  const originalScannerSmokeEnv = process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED;

  beforeEach(() => {
    mockIsGuest = false;
    mockEnsureGuestSession.mockClear();
    mockEnsureGuestSession.mockImplementation(async () => mockGuestSession as any);
    useKeepAwake.mockClear();
    mockBack.mockReset();
    mockCanGoBack.mockReset();
    mockCanGoBack.mockReturnValue(false);
    mockPush.mockReset();
    mockReplace.mockReset();
    mockDismissTo.mockReset();
    mockConfigureNext.mockClear();
    keyboardDismissSpy.mockClear();
    mockLoadRawScannerSmokeFixture.mockClear();
    mockAnalyzeSlabCapture.mockClear();
    __resetScannerTargetConfigForTests();
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {}, name: 'Spotlight', slug: 'spotlight' };
    }
    mockedConstants.expoConfig.extra = { ...originalExtra };
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED;
    clearScanCandidateReviewSessions();
  });

  afterAll(() => {
    if (originalScannerSmokeEnv == null) {
      delete process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED;
    } else {
      process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED = originalScannerSmokeEnv;
    }
    keyboardDismissSpy.mockRestore();
  });

  it('renders the scanner camera UI', () => {
    renderScannerScreen();

    expect(useKeepAwake).toHaveBeenCalledWith('scanner-screen');

    expect(screen.getByTestId('scanner-camera')).toBeTruthy();
    expect(screen.getByTestId('scanner-preview')).toBeTruthy();
    expect(screen.getByTestId('scanner-reticle')).toBeTruthy();
    expect(screen.getByTestId('scanner-back-button')).toBeTruthy();
    expect(screen.queryByTestId('scanner-account-button')).toBeNull();
    expect(screen.queryByTestId('scanner-slab-guide')).toBeNull();
    const previewStyle = StyleSheet.flatten(screen.getByTestId('scanner-preview').props.style);
    const reticleStyle = StyleSheet.flatten(screen.getByTestId('scanner-reticle').props.style);
    expect(previewStyle).toMatchObject({
      height: reticleStyle.height,
      left: reticleStyle.left,
      position: 'absolute',
      top: reticleStyle.top,
      width: reticleStyle.width,
    });
    expect(previewStyle.bottom).toBeUndefined();
    expect(previewStyle.right).toBeUndefined();
  });

  it('keeps the camera mounted (inactive) offscreen with granted permission, without a permission card', () => {
    // Regression guard: the camera must stay MOUNTED when the scanner is paged
    // offscreen (activePage=portfolio) and only pause via isActive. Conditionally
    // unmounting it here tore down/rebuilt the native session on every page swipe,
    // which hard-crashed the app on the portfolio->scanner return.
    renderWithProviders(
      <TabsPageContext.Provider value={{ activePage: 'portfolio', chartScrubLockRef: { current: false }, collectionEditing: false, setCollectionEditing: () => {} }}>
        <ScannerScreen />
      </TabsPageContext.Provider>,
    );

    expect(screen.getByTestId('scanner-camera')).toBeTruthy();
    expect(screen.queryByTestId('scanner-camera-fallback')).toBeNull();
    expect(screen.queryByTestId('scanner-permission-card')).toBeNull();
    expect(screen.queryByText('Camera access needed')).toBeNull();
  });

  it('pauses the capture session while backgrounded and restores it on foreground', async () => {
    // Regression guard for the "app is stuck after it sits idle" bug: when the OS
    // backgrounds/locks the app, the camera session must pause (so it cleanly
    // restarts on return) and the capture button must hide; coming back to the
    // foreground must re-arm capture. Before the AppState wiring, the session was
    // never told to stop, so the preview returned frozen and capture stayed dead.
    const addEventListenerSpy = jest.spyOn(AppState, 'addEventListener');
    renderScannerScreen();
    await waitForScannerReady();
    expect(screen.getByTestId('scanner-preview')).toBeTruthy();

    const changeHandlers = addEventListenerSpy.mock.calls
      .filter(([eventType]) => eventType === 'change')
      .map(([, handler]) => handler as (state: string) => void);
    expect(changeHandlers.length).toBeGreaterThan(0);

    const emitAppState = (state: string) => {
      act(() => {
        changeHandlers.forEach((handler) => handler(state));
      });
    };

    emitAppState('background');
    // The <Camera> stays mounted (no remount thrash), but isActive/capture pause:
    // the reticle capture button is gone because shouldMountCamera went false.
    expect(screen.getByTestId('scanner-camera')).toBeTruthy();
    expect(screen.queryByTestId('scanner-preview')).toBeNull();

    // Returning to the foreground re-activates the session (shouldMountCamera true)
    // so the capture surface comes back. In the real app the native session
    // restart re-fires onStarted to re-arm the capture gate.
    emitAppState('active');
    expect(screen.getByTestId('scanner-preview')).toBeTruthy();

    addEventListenerSpy.mockRestore();
  });

  it('resets top-level swipe handling to enabled on unmount', () => {
    const onTopLevelSwipeEnabledChange = jest.fn();
    const view = renderScannerScreen(undefined, { onTopLevelSwipeEnabledChange });

    expect(onTopLevelSwipeEnabledChange).toHaveBeenCalledWith(true);

    view.unmount();

    expect(onTopLevelSwipeEnabledChange).toHaveBeenLastCalledWith(true);
  });

  it('opens catalog search from the scanner header search button', () => {
    renderScannerScreen();

    fireEvent.press(screen.getByTestId('scanner-search-button'));

    expect(mockPush).toHaveBeenCalledWith('/catalog/search');
  });

  it('renders an empty recent scans tray with no placeholder rows', () => {
    renderScannerScreen();

    expect(screen.getByTestId('scanner-tray')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-header')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-handle')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-header').props.hitSlop).toEqual({
      bottom: 10,
      left: 12,
      right: 12,
      top: 12,
    });
    expect(screen.getByTestId('scanner-tray-body')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-empty-fill')).toBeTruthy();
    expect(screen.getByTestId('scanner-recent-title')).toBeTruthy();
    expect(screen.getByTestId('scanner-value-pill-text')).toBeTruthy();
    expect(screen.queryByText('CLEAR')).toBeNull();
    expect(screen.queryByTestId('scanner-matches-button')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-viewport')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-toggle')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-row-pending')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-row-review')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-row-expand')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('scanner-tray-body').props.style)).toMatchObject({
      minHeight: rawScannerTrayEmptyPeekHeight,
    });
    expect(StyleSheet.flatten(screen.getByTestId('scanner-tray-empty-fill').props.style)).toMatchObject({
      minHeight: rawScannerTrayEmptyPeekHeight,
    });
    expect(StyleSheet.flatten(screen.getByTestId('scanner-recent-title').props.style)).toMatchObject({
      fontSize: 13,
      lineHeight: 18.2,
    });
    expect(StyleSheet.flatten(screen.getByTestId('scanner-value-pill-text').props.style)).toMatchObject({
      fontSize: 13,
      lineHeight: 18.2,
    });
    expect(screen.queryByTestId('scanner-smoke-fixture-trigger')).toBeNull();
  });

  it('keeps reticle geometry stable after the first scan', async () => {
    renderScannerScreen();

    const initialReticleStyle = StyleSheet.flatten(screen.getByTestId('scanner-reticle').props.style);
    const initialPreviewStyle = StyleSheet.flatten(screen.getByTestId('scanner-preview').props.style);

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    expect(StyleSheet.flatten(screen.getByTestId('scanner-reticle').props.style)).toMatchObject({
      height: initialReticleStyle.height,
      left: initialReticleStyle.left,
      top: initialReticleStyle.top,
      width: initialReticleStyle.width,
    });
    expect(StyleSheet.flatten(screen.getByTestId('scanner-preview').props.style)).toMatchObject({
      height: initialPreviewStyle.height,
      left: initialPreviewStyle.left,
      top: initialPreviewStyle.top,
      width: initialPreviewStyle.width,
    });
  });

  it('captures a scan photo when the preview is tapped', async () => {
    renderScannerScreen();

    expect(StyleSheet.flatten(screen.getByTestId('scanner-prompt').props.style)).toMatchObject({
      fontSize: 16,
      lineHeight: 21.6,
    });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    expect(screen.getByText('Oshawott')).toBeTruthy();
    expect(screen.queryByText('Potential match')).toBeNull();
    expect(screen.getByTestId('scanner-tray-image-0')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-image-0').props.source).toEqual({
      uri: 'https://images.pokemontcg.io/mcdonalds25/21.png',
    });
    expect(screen.getByText("McDonald's Collection 2021 · #21/25")).toBeTruthy();
    expect(screen.queryByTestId('scanner-matches-button')).toBeNull();
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('TOTAL: $0.56');
    expect(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
      includeHiddenElements: true,
    })).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
      includeHiddenElements: true,
    }).props.accessibilityState).toMatchObject({
      disabled: true,
    });

    // The tray shell renders; its expand/collapse swipe is now a
    // gesture-handler GestureDetector (no inspectable JS responder props).
    expect(screen.getByTestId('scanner-tray')).toBeTruthy();
  });

  it('shows a dash instead of $0.00 when a matched card has no market price', async () => {
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async () => ({
        scanID: 'scan-poncho-pikachu',
        candidates: [{
          id: 'xy-promo-poncho-pikachu',
          cardId: 'xy-promo-poncho-pikachu',
          name: 'Poncho Pikachu',
          cardNumber: '#202/XY-P',
          setName: 'XY Promo',
          imageUrl: 'https://images.pokemontcg.io/xyp/202.png',
          marketPrice: null,
          currencyCode: 'USD',
        }],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    expect(screen.getByText('Poncho Pikachu')).toBeTruthy();
    // No raw sales means no headline price: render an em-dash, never "$0.00".
    expect(screen.getByTestId('scanner-tray-price-0')).toHaveTextContent('—');
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('sends a normalized reticle target to scanner matching', async () => {
    const payloads: {
      height: number;
      fileUri: string | null | undefined;
      jpegBase64: string | null | undefined;
      width: number;
    }[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push({
          height: payload.height,
          fileUri: payload.fileUri,
          jpegBase64: payload.jpegBase64,
          width: payload.width,
        });

        return {
          scanID: 'scan-oshawott',
          candidates: [{
            id: 'mcdonalds25-21',
            cardId: 'mcdonalds25-21',
            name: 'Oshawott',
            cardNumber: '#21/25',
            setName: "McDonald's Collection 2021",
            imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
            marketPrice: 0.56,
            currencyCode: 'USD',
          }],
        };
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });

    // The scan hot path passes the normalized target as a FILE URI (multipart
    // streaming) and performs no base64 read at all.
    expect(payloads[0]).toEqual({
      height: 880,
      fileUri: expect.stringContaining('file:///mock-normalized-'),
      jpegBase64: undefined,
      width: 630,
    });
  });

  it('attaches source and normalized images to the raw match payload so the backend can persist scan artifacts', async () => {
    const payloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);

        return {
          scanID: 'scan-raw-artifacts',
          candidates: [{
            id: 'mcdonalds25-21',
            cardId: 'mcdonalds25-21',
            name: 'Oshawott',
            cardNumber: '#21/25',
            setName: "McDonald's Collection 2021",
            imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
            marketPrice: 0.56,
            currencyCode: 'USD',
          }],
        };
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });

    expect(payloads[0]).toMatchObject({
      mode: 'raw',
      cardLanguage: 'english',
      captureSource: 'camera',
      cameraZoomFactor: 1,
      sourceImage: {
        fileUri: 'file:///mock-scan.jpg',
      },
    });
    expect(payloads[0].sourceImage.jpegBase64).toBeUndefined();
    expect(payloads[0].sourceImage.width).toBeGreaterThan(0);
    expect(payloads[0].sourceImage.height).toBeGreaterThan(0);
    expect(payloads[0].normalizedImage).toEqual(expect.objectContaining({
      fileUri: payloads[0].fileUri,
      width: payloads[0].width,
      height: payloads[0].height,
    }));
    expect(payloads[0].normalizedImage.jpegBase64).toBeUndefined();
    expect(typeof payloads[0].submittedAt).toBe('string');
    expect(payloads[0].slabAnalysis).toBeUndefined();

    // The JSON+base64 fallback reads lazily through the payload's reader —
    // it must resolve real bytes for both the source photo and the normalized
    // target without having been called during the default (multipart) flow.
    expect(typeof payloads[0].readFileAsBase64).toBe('function');
    await expect(payloads[0].readFileAsBase64('file:///mock-scan.jpg'))
      .resolves.toBe('bW9jay1zY2FuLWJhc2U2NA==');
  });

  it('threads the selected Pokémon JP card type into the match payload language', async () => {
    const payloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);
        return { scanID: 'scan-jp', candidates: [] };
      },
    });

    renderScannerScreen({ spotlightRepository });

    fireEvent.press(screen.getByTestId('scanner-target-pill'));
    // Selecting a language now closes the sheet in one tap (no separate dismiss).
    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-pokemon-jp'));

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });

    expect(payloads[0]).toMatchObject({ mode: 'raw', cardLanguage: 'japanese' });
  });

  it('threads the selected camera zoom factor into the match payload', async () => {
    const payloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);
        return { scanID: 'scan-zoom', candidates: [] };
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    // Default is 1×; switch to 2× before capturing.
    fireEvent.press(screen.getByTestId('scanner-zoom-2x'));
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });

    expect(payloads[0]).toMatchObject({ cameraZoomFactor: 2 });
  });

  it('shows the scanner smoke fixture trigger when staging smoke is enabled', () => {
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {}, name: 'Spotlight', slug: 'spotlight' };
    }
    mockedConstants.expoConfig.extra = {
      ...mockedConstants.expoConfig.extra,
      spotlightAppEnv: 'staging',
      spotlightScannerSmokeEnabled: '1',
    };

    renderScannerScreen();
    expect(screen.getByTestId('scanner-smoke-fixture-trigger')).toBeTruthy();
  });

  it('runs a fixture-backed smoke scan through the real match flow', async () => {
    const payloads: import('@spotlight/api-client').ScannerCapturePayload[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);

        return {
          scanID: 'scan-smoke-fixture',
          candidates: [{
            id: 'base1-14',
            cardId: 'base1-14',
            name: 'Dark Weezing',
            cardNumber: '#14/82',
            setName: 'Team Rocket',
            imageUrl: 'https://cdn.spotlight.test/dark-weezing.png',
            marketPrice: 1.23,
            currencyCode: 'USD',
          }],
        };
      },
    });

    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {}, name: 'Spotlight', slug: 'spotlight' };
    }
    mockedConstants.expoConfig.extra = {
      ...mockedConstants.expoConfig.extra,
      spotlightAppEnv: 'staging',
      spotlightScannerSmokeEnabled: '1',
    };

    renderScannerScreen({ spotlightRepository });

    fireEvent.press(screen.getByTestId('scanner-smoke-fixture-trigger'));

    await waitFor(() => {
      expect(screen.getByText('Dark Weezing')).toBeTruthy();
    });

    expect(mockLoadRawScannerSmokeFixture).toHaveBeenCalledTimes(1);
    // The fixture carries both transports: fileUri for the default multipart
    // lane and inline base64 so the JSON fallback stays read-free.
    expect(payloads).toEqual([{
      height: 880,
      fileUri: 'file:///scanner-smoke-fixture.jpg',
      jpegBase64: 'c21va2UtZml4dHVyZS1iYXNlNjQ=',
      mode: 'raw',
      width: 630,
    }]);

    fireEvent.press(screen.getByTestId('scanner-tray-open-card-0'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/cards/[cardId]',
        params: {
          cardId: 'base1-14',
          entryId: undefined,
          previewId: expect.any(String),
          scanReviewId: expect.any(String),
        },
      });
    });

    const pushedRoute = mockPush.mock.calls.at(-1)?.[0] as { params?: { scanReviewId?: string } };
    const scanReviewSession = getScanCandidateReviewSession(pushedRoute.params?.scanReviewId);
    expect(scanReviewSession?.normalizedImageUri).toBe('file:///scanner-smoke-fixture.jpg');
    expect(scanReviewSession?.sourceImageCrop).toEqual({
      height: 880,
      width: 630,
      x: 0,
      y: 0,
    });
  });

  it('surfaces a clear error when the scanner smoke fixture cannot load', async () => {
    mockLoadRawScannerSmokeFixture.mockRejectedValueOnce(new Error('fixture_missing'));
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {}, name: 'Spotlight', slug: 'spotlight' };
    }
    mockedConstants.expoConfig.extra = {
      ...mockedConstants.expoConfig.extra,
      spotlightAppEnv: 'staging',
      spotlightScannerSmokeEnabled: '1',
    };

    renderScannerScreen();

    fireEvent.press(screen.getByTestId('scanner-smoke-fixture-trigger'));

    await waitFor(() => {
      expect(screen.getByText('Scanner smoke fixture could not load.')).toBeTruthy();
    });
  });

  it('keeps the hidden delete action inactive until the row is swiped open', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
      includeHiddenElements: true,
    }));

    expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('TOTAL: $0.56');
  });

  it('disables top-level scanner swipe while a tray action rail is open and restores it when closed', async () => {
    const handleTopLevelSwipeEnabledChange = jest.fn();
    renderScannerScreen(undefined, {
      onTopLevelSwipeEnabledChange: handleTopLevelSwipeEnabledChange,
    });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-reveal-actions', {
      includeHiddenElements: true,
    }));

    await waitFor(() => {
      expect(handleTopLevelSwipeEnabledChange).toHaveBeenCalledWith(false);
    });

    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-collapse-delete', {
      includeHiddenElements: true,
    }));

    await waitFor(() => {
      expect(handleTopLevelSwipeEnabledChange).toHaveBeenCalledWith(true);
    });
  });

  it('allows a single scan tray to expand and keeps it expanded when deleting down to one scan', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    expect(screen.getByTestId('scanner-tray-header')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-handle')).toBeTruthy();
    fireEvent.press(screen.getByTestId('scanner-tray-header'));

    let expandedViewportHeight = 0;
    await waitFor(() => {
      expandedViewportHeight = StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height ?? 0;
      expect(expandedViewportHeight).toBeGreaterThanOrEqual(88);
    });

    fireEvent.press(screen.getByTestId('scanner-tray-header'));

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('scanner-tray-header'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-1')).toBeTruthy();
    });

    expandedViewportHeight = StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height ?? 0;
    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-reveal-actions', {
      includeHiddenElements: true,
    }));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
        includeHiddenElements: true,
      }).props.accessibilityState).toMatchObject({
        disabled: false,
      });
    });

    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
      includeHiddenElements: true,
    }));

    await waitFor(() => {
      expect(screen.queryByTestId('scanner-tray-row-1')).not.toBeOnTheScreen();
    });

    expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-header')).toBeTruthy();
    // Tray viewport fits content (captureRowHeight) when only one row remains.
    expect(StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height).toBeGreaterThanOrEqual(102);
    // Verify the tray is still in the expanded state (not collapsed back).
    expect(screen.getByTestId('scanner-tray-header').props.accessibilityLabel).toBe('Collapse recent scans');
    // Avoid an unused-variable lint by referencing the saved expanded height.
    expect(expandedViewportHeight).toBeGreaterThanOrEqual(102);
  });

  it('shows the CLEAR ALL control only when the tray is expanded', async () => {
    renderScannerScreen();

    // Empty tray: no CLEAR ALL.
    expect(screen.queryByTestId('scanner-tray-clear-all')).toBeNull();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    // Collapsed with a scan: CLEAR ALL lives at the bottom of the expanded list, not here.
    expect(screen.queryByTestId('scanner-tray-clear-all')).toBeNull();

    fireEvent.press(screen.getByTestId('scanner-tray-header'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-clear-all')).toBeTruthy();
    });
    expect(screen.getByText('CLEAR ALL')).toBeTruthy();
  });

  const froakieAddAllRepository = (
    favoritePayloads: { cardId: string; isFavorite: boolean }[],
  ) => createTestSpotlightRepository({
    setCardFavorite: async (cardId: string, isFavorite?: boolean | null) => {
      const next = isFavorite ?? true;
      favoritePayloads.push({ cardId, isFavorite: next });
      return {
        cardId,
        favoritedAt: next ? '2026-05-15T00:00:00.000Z' : null,
        isFavorite: next,
      };
    },
    matchScannerCapture: async () => ({
      scanID: 'scan-froakie',
      candidates: [{
        id: 'froakie-candidate',
        cardId: 'mcdonalds25-22',
        name: 'Froakie',
        cardNumber: '#22/25',
        setName: "McDonald's Collection 2021",
        imageUrl: 'https://cdn.spotlight.test/froakie.png',
        marketPrice: 55,
        currencyCode: 'USD',
      }],
    }),
  });

  it('shows ADD ALL whenever scans exist — collapsed tray included', async () => {
    renderScannerScreen();

    // No scans: no ADD ALL.
    expect(screen.queryByTestId('scanner-tray-add-all')).toBeNull();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    // Collapsed with a scan: ADD ALL is available without swiping the tray up.
    expect(screen.getByTestId('scanner-tray-add-all')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanner-tray-header'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-add-all')).toBeTruthy();
    });
  });

  it('ADD ALL wishlists the scan, then clears the tray and returns to the scanner', async () => {
    const favoritePayloads: { cardId: string; isFavorite: boolean }[] = [];
    renderScannerScreen({ spotlightRepository: froakieAddAllRepository(favoritePayloads) });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('scanner-tray-header'));
    fireEvent.press(await screen.findByTestId('scanner-tray-add-all'));

    // ADD ALL opens the action menu; pick Wishlist.
    fireEvent.press(await screen.findByTestId('add-all-menu-wishlist'));

    // Confirmation sheet with the count + wishlist copy.
    expect(await screen.findByTestId('scan-bulk-confirm-sheet')).toBeTruthy();
    expect(screen.getByTestId('scan-bulk-confirm-sheet-title').props.children)
      .toBe('Add 1 item to Wishlist?');

    fireEvent.press(screen.getByTestId('scan-bulk-confirm-sheet-confirm'));

    await waitFor(() => {
      expect(favoritePayloads).toHaveLength(1);
    });
    expect(favoritePayloads[0]).toEqual({ cardId: 'mcdonalds25-22', isFavorite: true });

    // Tray cleared (SCAN: 0) + collapsed (ADD ALL gone).
    await waitFor(() => {
      expect(screen.getByTestId('scanner-recent-title').props.children).toBe('SCAN: 0');
    });
    expect(screen.queryByTestId('scanner-tray-add-all')).toBeNull();
  });

  it('cancels ADD ALL without wishlisting or clearing the tray', async () => {
    const favoritePayloads: { cardId: string; isFavorite: boolean }[] = [];
    renderScannerScreen({ spotlightRepository: froakieAddAllRepository(favoritePayloads) });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('scanner-tray-header'));
    fireEvent.press(await screen.findByTestId('scanner-tray-add-all'));
    fireEvent.press(await screen.findByTestId('add-all-menu-wishlist'));
    fireEvent.press(await screen.findByTestId('scan-bulk-confirm-sheet-cancel'));

    // The sheet unmounts from the completion callback of its 200ms JS-driven
    // close animation, so "gone" is gated on real elapsed time, not a state
    // flush. waitFor's 1s default is enough when this file runs alone but not
    // when the whole suite runs in parallel workers — same 2500 used elsewhere
    // in this file for animation-gated waits.
    await waitFor(
      () => {
        expect(screen.queryByTestId('scan-bulk-confirm-sheet')).not.toBeOnTheScreen();
      },
      { timeout: 2500 },
    );
    expect(favoritePayloads).toHaveLength(0);
    expect(screen.getByTestId('scanner-recent-title').props.children).toBe('SCAN: 1');
  });

  it('shows the pending tray row immediately before scanner matches resolve', async () => {
    let resolveMatch: ((value: any) => void) | undefined;
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async () => {
        return new Promise((resolve) => {
          resolveMatch = resolve;
        });
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    expect(screen.getByText('Finding match')).toBeTruthy();

    await waitFor(() => {
      expect(resolveMatch).toBeTruthy();
    });

    const resolvePendingMatch = resolveMatch;
    if (!resolvePendingMatch) {
      throw new Error('Scanner match promise did not initialize.');
    }

    resolvePendingMatch({
      scanID: 'scan-oshawott',
      candidates: [{
        id: 'mcdonalds25-21',
        cardId: 'mcdonalds25-21',
        name: 'Oshawott',
        cardNumber: '#21/25',
        setName: "McDonald's Collection 2021",
        imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
        marketPrice: 0.56,
        currencyCode: 'USD',
      }],
    });

    expect(await screen.findByText('Oshawott')).toBeTruthy();
  });

  it('allows another scan while earlier scans are still processing', async () => {
    const pendingResolvers: ((value: any) => void)[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async () => {
        return new Promise((resolve) => {
          pendingResolvers.push(resolve);
        });
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    expect(screen.getByText('Finding match')).toBeTruthy();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(screen.getByTestId('scanner-tray-header')).toBeTruthy();
    await waitFor(() => {
      expect(pendingResolvers).toHaveLength(2);
    });

    fireEvent.press(screen.getByTestId('scanner-tray-header'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-1')).toBeTruthy();
    });

    pendingResolvers[0]?.({
      scanID: 'scan-one',
      candidates: [{
        id: 'mcdonalds25-21',
        cardId: 'mcdonalds25-21',
        name: 'Oshawott',
        cardNumber: '#21/25',
        setName: "McDonald's Collection 2021",
        imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
        marketPrice: 0.56,
        currencyCode: 'USD',
      }],
    });
    pendingResolvers[1]?.({
      scanID: 'scan-two',
      candidates: [{
        id: 'mcdonalds25-16',
        cardId: 'mcdonalds25-16',
        name: 'Scorbunny',
        cardNumber: '#16/25',
        setName: "McDonald's Collection 2021",
        imageUrl: 'https://images.pokemontcg.io/mcdonalds25/16.png',
        marketPrice: 0.38,
        currencyCode: 'USD',
      }],
    });

    expect(await screen.findByText('Scorbunny')).toBeTruthy();
  });

  it('swaps the active candidate when one is picked in the change card picker', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Oshawott')).toBeTruthy();
    expect(screen.queryByText('Potential match')).toBeNull();

    fireEvent.press(screen.getByTestId('scanner-tray-change-0'));

    fireEvent.press(await screen.findByTestId('change-card-picker-row-1'));

    await waitFor(() => {
      // The redesigned card-detail screen renders the name in both the header
      // and the identity block, so the swapped candidate can appear more than once.
      expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);
    });

    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('TOTAL: $0.38');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens card detail when the recent scan text area is tapped', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Oshawott')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanner-tray-open-card-0'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/cards/[cardId]',
        params: {
          cardId: 'mcdonalds25-21',
          entryId: 'entry-2',
          previewId: expect.any(String),
          scanReviewId: expect.any(String),
        },
      });
    });

    const pushedRoute = mockPush.mock.calls[0]?.[0] as {
      params?: { scanReviewId?: string };
    };
    const scanReviewSession = getScanCandidateReviewSession(pushedRoute.params?.scanReviewId);
    expect(scanReviewSession?.normalizedImageUri).toEqual(expect.stringContaining('file:///mock-normalized-'));
    expect(scanReviewSession?.normalizedImageDimensions).toEqual({
      height: 880,
      width: 630,
    });
    expect(scanReviewSession?.sourceImageCrop).not.toBeNull();
    expect(scanReviewSession?.sourceImageCrop?.width).toBeGreaterThan(0);
    expect(scanReviewSession?.sourceImageCrop?.height).toBeGreaterThan(0);
    expect(scanReviewSession?.sourceImageDimensions).toBeTruthy();
    expect(scanReviewSession?.sourceImageDimensions?.height).toBeGreaterThan(
      scanReviewSession?.sourceImageDimensions?.width ?? 0,
    );
  });

  it('keeps the tray collapsed to the newest scan until expanded, then opens a calm half-screen viewport', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    for (let index = 0; index < 2; index += 1) {
      fireEvent.press(screen.getByTestId('scanner-preview'));
      // Let the mocked camera request settle before the next capture.
      // The newest row remains row 0 even after multiple captures.
      await waitFor(() => {
        expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
      });
      await waitForScannerReady();
    }

    expect(screen.getByTestId('scanner-tray-header')).toBeTruthy();
    // Collapsed shows EXACTLY one card (the newest, row 0): every row stays
    // mounted (so toggling never churns the row set), but the viewport is
    // clipped to a single full row so only row 0 is visible.
    expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    const collapsedViewportHeight =
      StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height ?? 0;
    expect(collapsedViewportHeight).toBe(102); // exactly one full row, no peek

    fireEvent.press(screen.getByTestId('scanner-tray-header'));
    // Toggling springs the tray height via a Reanimated shared value (NOT a
    // classic LayoutAnimation, which crashed when run over the Reanimated tray
    // rows). The classic LayoutAnimation path must no longer fire.
    expect(mockConfigureNext).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-scroll')).toBeTruthy();
      expect(screen.getByTestId('scanner-tray-viewport')).toBeTruthy();
      expect(screen.getByTestId('scanner-tray-row-1')).toBeTruthy();
    });

    const viewportHeight = StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height ?? 0;
    expect(viewportHeight).toBeGreaterThanOrEqual(184);
    expect(viewportHeight).toBeLessThanOrEqual(428);

    // While expanded, scanner-preview is intentionally not rendered so taps on
    // the camera surface fall through to scanner-tray-collapse-backdrop (which
    // collapses the tray). Verify that contract.
    expect(screen.queryByTestId('scanner-preview')).toBeNull();
    expect(screen.getByTestId('scanner-tray-collapse-backdrop')).toBeTruthy();
  });

  it('shows the scan-target pill alongside the zoom controls and hides them when the tray expands', async () => {
    renderScannerScreen();

    // Pill shares the bottom controls row with the zoom dock; back/search stay in the header.
    expect(screen.getByTestId('scanner-target-pill')).toBeTruthy();
    expect(screen.getByTestId('scanner-zoom-control')).toBeTruthy();
    expect(screen.getByTestId('scanner-back-button')).toBeTruthy();
    expect(screen.getByTestId('scanner-search-button')).toBeTruthy();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    // Still visible while collapsed with a scan.
    expect(screen.getByTestId('scanner-target-pill')).toBeTruthy();

    // Shares the controls row with the zoom dock, so it hides when the tray expands.
    fireEvent.press(screen.getByTestId('scanner-tray-header'));
    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-collapse-backdrop')).toBeTruthy();
    });
    expect(screen.queryByTestId('scanner-target-pill')).toBeNull();
    expect(screen.queryByTestId('scanner-zoom-control')).toBeNull();
  });

  it('draws every chrome surface in the scrim when Liquid Glass is unavailable', async () => {
    /*
      All of this chrome renders through `GlassSurface`: real Liquid Glass on
      iOS 26, and `scannerChromeFill` everywhere else. `jest.setup` forces glass
      OFF, so this is the Android / iOS < 26 path — the one almost every device
      actually draws, and the one nobody sees while developing on an iOS 26
      simulator. Pinning it is what stops the scrim rotting silently.
    */
    renderScannerScreen();

    const fillOf = (testID: string) =>
      (
        StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as Record<
          string,
          unknown
        >
      )?.backgroundColor;

    expect(fillOf('scanner-target-pill-surface')).toBe(colors.scannerChromeFill);
    // Only the SELECTED zoom factor has a surface; the others are bare labels.
    expect(fillOf('scanner-zoom-1x-surface')).toBe(colors.scannerChromeFill);
    expect(screen.queryByTestId('scanner-zoom-2x-surface')).toBeNull();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    // The tray's SCAN/TOTAL chips used to be an opaque gray900 — the one
    // surface here that read as a different material from the rest.
    expect(fillOf('scanner-recent-title-surface')).toBe(colors.scannerChromeFill);
    expect(fillOf('scanner-value-pill-surface')).toBe(colors.scannerChromeFill);

    /*
      The TRAY keeps its BlurView on this path rather than degrading to a flat
      scrim. It sits over a live viewfinder and the blur is doing real work
      there, so glass-or-nothing would have been a downgrade on every Android
      device. Real Liquid Glass replaces it only on iOS 26.
    */
    expect(screen.queryByTestId('scanner-tray-glass')).toBeNull();
  });

  it('replaces the search bubble with a labelled search field', async () => {
    renderScannerScreen();

    // A magnifier icon reads as "some action"; the frame (3686:56583) gives
    // search the whole width beside the back button so it reads as a field.
    expect(screen.getByTestId('scanner-search-button')).toBeTruthy();
    expect(screen.getByText('Search Cards')).toBeTruthy();
  });

  it('floats the toolbar over the camera with no dark strip behind it', async () => {
    renderScannerScreen();

    /*
      The header used to carry a full-width `rgba(0, 0, 0, 0.25)` scrim. The
      frame has the glass controls straight over the viewfinder — each carries
      its own contrast, which is the point of the material.
    */
    await waitForScannerReady();
    expect(screen.getByTestId('scanner-back-button')).toBeTruthy();
    expect(screen.queryByTestId('scanner-top-chrome-backdrop')).toBeNull();
  });

  it('adds a scanned card into inventory from the tray', async () => {
    let inventoryEntries: any[] = [];
    const addPayloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      createInventoryEntry: async (payload) => {
        addPayloads.push(payload);
        inventoryEntries = [
          {
            id: 'entry-froakie',
            cardId: payload.cardID,
            name: 'Froakie',
            cardNumber: '#22/25',
            setName: "McDonald's Collection 2021",
            imageUrl: 'https://cdn.spotlight.test/froakie.png',
            marketPrice: 55,
            hasMarketPrice: true,
            currencyCode: 'USD',
            quantity: 1,
            addedAt: payload.addedAt,
            kind: 'raw',
            conditionCode: 'near_mint',
            conditionLabel: 'Near Mint',
            conditionShortLabel: 'NM',
            costBasisPerUnit: null,
            costBasisTotal: 0,
          },
        ];

        return {
          deckEntryID: 'entry-froakie',
          cardID: payload.cardID,
          variantName: null,
          condition: payload.condition,
          confirmationID: 'confirmation-froakie',
          sourceScanID: payload.sourceScanID,
          addedAt: payload.addedAt,
        };
      },
      getInventoryEntries: async () => inventoryEntries,
      matchScannerCapture: async () => ({
        scanID: 'scan-froakie',
        candidates: [{
          id: 'froakie-candidate',
          cardId: 'mcdonalds25-22',
          name: 'Froakie',
          cardNumber: '#22/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://cdn.spotlight.test/froakie.png',
          marketPrice: 55,
          currencyCode: 'USD',
        }],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Froakie')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-reveal-actions', {
      hidden: true,
    }));
    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-collection-button'));

    await waitFor(() => {
      expect(addPayloads).toHaveLength(1);
    });
    expect(addPayloads[0]).toEqual(expect.objectContaining({
      sourceScanID: 'scan-froakie',
      selectionSource: 'top',
      selectedRank: 1,
      wasTopPrediction: true,
    }));

    // Once a card is added to the collection it should leave the recent-scans
    // tray (after a brief "ADDED" confirmation) rather than lingering.
    await waitFor(() => {
      expect(screen.queryByTestId('scanner-tray-row-0')).not.toBeOnTheScreen();
    }, { timeout: 2500 });
  });

  it('wishlists a scanned card via the row ADD menu, then slides it out of the tray', async () => {
    const setCardFavorite = jest.fn(async (cardId: string, isFavorite?: boolean | null) => ({
      cardId,
      favoritedAt: (isFavorite ?? true) ? '2026-05-15T00:00:00.000Z' : null,
      isFavorite: isFavorite ?? true,
    }));
    const spotlightRepository = createTestSpotlightRepository({
      setCardFavorite,
      matchScannerCapture: async () => ({
        scanID: 'scan-froakie',
        candidates: [{
          id: 'froakie-candidate',
          cardId: 'mcdonalds25-22',
          name: 'Froakie',
          cardNumber: '#22/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://cdn.spotlight.test/froakie.png',
          marketPrice: 55,
          currencyCode: 'USD',
        }],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Froakie')).toBeTruthy();

    // The inline ADD ▾ pill opens the per-row menu; picking Wishlist favorites
    // the active candidate immediately (no confirm sheet).
    const addPill = await screen.findByTestId('scanner-tray-add-0');
    expect(addPill).toHaveTextContent('ADD');
    fireEvent.press(addPill, {
      // A real press always carries both; the handler reads the tap point
      // BEFORE the async measure so Android's flaky measureInWindow cannot
      // leave the button dead (see the open-first fallback at the call site).
      nativeEvent: { pageX: 180, pageY: 640 },
      currentTarget: {
        measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) =>
          cb(0, 0, 0, 0),
      },
    });

    fireEvent.press(await screen.findByTestId('scanner-row-add-menu-wishlist'));

    await waitFor(() => {
      expect(setCardFavorite).toHaveBeenCalledWith('mcdonalds25-22', true);
    });

    // After wishlisting, the row slides out of the tray (same exit as a
    // collection add) rather than lingering.
    await waitFor(() => {
      expect(screen.queryByTestId('scanner-tray-row-0')).not.toBeOnTheScreen();
    }, { timeout: 2500 });
  });

  it('does not send a synthetic capture id when scanner add has no backend scan id', async () => {
    const addPayloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      createInventoryEntry: async (payload) => {
        addPayloads.push(payload);

        return {
          deckEntryID: 'entry-froakie',
          cardID: payload.cardID,
          variantName: null,
          condition: payload.condition,
          confirmationID: null,
          sourceScanID: payload.sourceScanID,
          addedAt: payload.addedAt,
        };
      },
      getInventoryEntries: async () => [],
      matchScannerCapture: async () => ({
        scanID: null,
        candidates: [{
          id: 'froakie-candidate',
          cardId: 'mcdonalds25-22',
          name: 'Froakie',
          cardNumber: '#22/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://cdn.spotlight.test/froakie.png',
          marketPrice: 55,
          currencyCode: 'USD',
        }],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Froakie')).toBeTruthy();
    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-reveal-actions', {
      hidden: true,
    }));
    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-collection-button'));

    await waitFor(() => {
      expect(addPayloads).toHaveLength(1);
    });
    expect(addPayloads[0]?.sourceScanID).toBeNull();
  });

  it('cycles candidates and then opens card detail for the active result', async () => {
    const repository = createTestSpotlightRepository({
      matchScannerCapture: async () => ({
        scanID: 'scan-oshawott',
        candidates: [
          {
            id: 'mcdonalds25-21',
            cardId: 'mcdonalds25-21',
            name: 'Oshawott',
            cardNumber: '#21/25',
            setName: "McDonald's Collection 2021",
            imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
            marketPrice: 0.56,
            currencyCode: 'USD',
            ownedQuantity: 2,
          },
          {
            id: 'mcdonalds25-16',
            cardId: 'mcdonalds25-16',
            name: 'Scorbunny',
            cardNumber: '#16/25',
            setName: "McDonald's Collection 2021",
            imageUrl: 'https://images.pokemontcg.io/mcdonalds25/16.png',
            marketPrice: 0.38,
            currencyCode: 'USD',
            ownedQuantity: 1,
          },
        ],
      }),
    });

    renderScannerScreen({ spotlightRepository: repository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Oshawott')).toBeTruthy();
    fireEvent.press(screen.getByTestId('scanner-tray-change-0'));

    fireEvent.press(await screen.findByTestId('change-card-picker-row-1'));

    await waitFor(() => {
      // The redesigned card-detail screen renders the name in both the header
      // and the identity block, so the swapped candidate can appear more than once.
      expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);
    });

    fireEvent.press(screen.getByTestId('scanner-tray-open-card-0'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/cards/[cardId]',
        params: {
          cardId: 'mcdonalds25-16',
          entryId: 'entry-1',
          previewId: expect.any(String),
          scanReviewId: expect.any(String),
        },
      });
    });
  });

  // Fallback exit, unreachable in the app (`scan.tsx` always passes
  // `onExitToPortfolio`). Used to assert a dead `page` param.
  it('exits to the app root from the back button when there is nothing to pop', () => {
    renderScannerScreen();

    fireEvent.press(screen.getByTestId('scanner-back-button'));

    expect(mockDismissTo).toHaveBeenCalledWith('/');
  });

  it('passes the condition selected in the price sheet through to inventory add', async () => {
    const addPayloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      createInventoryEntry: async (payload) => {
        addPayloads.push(payload);
        return {
          deckEntryID: 'entry-froakie',
          cardID: payload.cardID,
          variantName: null,
          condition: payload.condition,
          confirmationID: null,
          sourceScanID: payload.sourceScanID,
          addedAt: payload.addedAt,
        };
      },
      getInventoryEntries: async () => [],
      matchScannerCapture: async () => ({
        scanID: 'scan-froakie',
        candidates: [{
          id: 'froakie-candidate',
          cardId: 'mcdonalds25-22',
          name: 'Froakie',
          cardNumber: '#22/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://cdn.spotlight.test/froakie.png',
          marketPrice: 0.55,
          currencyCode: 'USD',
        }],
      }),
      getRawPricingMatrix: async () => ({
        cardID: 'mcdonalds25-22',
        currencyCode: 'USD',
        variants: [
          {
            variant: 'Holofoil',
            variantKey: 'holofoil',
            conditions: [
              { code: 'NM', label: 'Near Mint', market: 0.55, low: null, mid: null, high: null },
              { code: 'LP', label: 'Lightly Played', market: 0.42, low: null, mid: null, high: null },
            ],
          },
        ],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Froakie')).toBeTruthy();

    fireEvent.press(screen.getByTestId('scanner-tray-price-0'));

    const lpRow = await screen.findByTestId('scan-price-sheet-row-holofoil-LP');
    fireEvent.press(lpRow);

    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-reveal-actions', {
      hidden: true,
    }));
    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-collection-button'));

    await waitFor(() => {
      expect(addPayloads).toHaveLength(1);
    });
    expect(addPayloads[0]).toEqual(expect.objectContaining({
      condition: 'lightly_played',
    }));
  });

  // Supabase bills per Monthly Active User and an anonymous user is one, so a
  // guest who opens the app, warms the camera and browses must cost nothing.
  // The scan dispatch is the first thing that genuinely needs a server identity.
  it('GUEST: opening the scanner mints no Supabase user; the first capture mints exactly one', async () => {
    mockIsGuest = true;
    const payloads: unknown[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);
        return {
          scanID: 'scan-guest-1',
          candidates: [{
            id: 'mcdonalds25-21',
            cardId: 'mcdonalds25-21',
            name: 'Oshawott',
            cardNumber: '#21/25',
            setName: "McDonald's Collection 2021",
            imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
            marketPrice: 0.56,
            currencyCode: 'USD',
          }],
        };
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    expect(mockEnsureGuestSession).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });
    // One capture, one mint — and it happened BEFORE the match request.
    expect(mockEnsureGuestSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Oshawott')).toBeTruthy();
  });

  it('GUEST: a failed mint fails the capture instead of firing an unauthenticated match', async () => {
    mockIsGuest = true;
    // Anonymous sign-ins disabled / offline: the provider keeps the user in
    // guest mode and resolves null rather than throwing them out.
    mockEnsureGuestSession.mockImplementation(async () => null as any);

    const payloads: unknown[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);
        throw new Error('should not reach the backend without a session');
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    // The row lands in the tray and leaves its "Finding match" state through the
    // normal scan-failure path — no crash, no dropped capture, no doomed 401.
    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByText('Finding match')).not.toBeOnTheScreen();
    });
    expect(mockEnsureGuestSession).toHaveBeenCalledTimes(1);
    expect(payloads).toHaveLength(0);
  });

  it('SIGNED IN: a capture never touches the guest mint', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });
    expect(mockEnsureGuestSession).not.toHaveBeenCalled();
  });

  it('keeps the tray TOTAL equal to the row price after a non-NM condition is picked', async () => {
    // Dealers price a stack off the header TOTAL, so it must be the sum of the
    // numbers on the rows above it. The row honors the price-sheet selection
    // (Lightly Played, $0.42); the TOTAL used to ignore the selection entirely
    // and sum the raw candidate market price ($0.55), so every non-NM card in a
    // tray silently made the header disagree with its own rows.
    const spotlightRepository = createTestSpotlightRepository({
      getInventoryEntries: async () => [],
      matchScannerCapture: async () => ({
        scanID: 'scan-froakie',
        candidates: [{
          id: 'froakie-candidate',
          cardId: 'mcdonalds25-22',
          name: 'Froakie',
          cardNumber: '#22/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://cdn.spotlight.test/froakie.png',
          marketPrice: 0.55,
          currencyCode: 'USD',
        }],
      }),
      getRawPricingMatrix: async () => ({
        cardID: 'mcdonalds25-22',
        currencyCode: 'USD',
        variants: [
          {
            variant: 'Holofoil',
            variantKey: 'holofoil',
            conditions: [
              { code: 'NM', label: 'Near Mint', market: 0.55, low: null, mid: null, high: null },
              { code: 'LP', label: 'Lightly Played', market: 0.42, low: null, mid: null, high: null },
            ],
          },
        ],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Froakie')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-price-0')).toHaveTextContent('$0.55');
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('TOTAL: $0.55');

    fireEvent.press(screen.getByTestId('scanner-tray-price-0'));
    fireEvent.press(await screen.findByTestId('scan-price-sheet-row-holofoil-LP'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-price-0')).toHaveTextContent('$0.42');
    });
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('TOTAL: $0.42');
  });

  it('leaves captures with no finite price out of the tray TOTAL', async () => {
    // A matched card with no market price renders an em-dash, not "$0.00" — so
    // it must contribute nothing to the TOTAL rather than counting as zero.
    let matchCount = 0;
    const spotlightRepository = createTestSpotlightRepository({
      getInventoryEntries: async () => [],
      matchScannerCapture: async () => {
        matchCount += 1;
        return matchCount === 1
          ? {
            scanID: 'scan-oshawott',
            candidates: [{
              id: 'mcdonalds25-21',
              cardId: 'mcdonalds25-21',
              name: 'Oshawott',
              cardNumber: '#21/25',
              setName: "McDonald's Collection 2021",
              imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
              marketPrice: 0.56,
              currencyCode: 'USD',
            }],
          }
          : {
            scanID: 'scan-poncho-pikachu',
            candidates: [{
              id: 'xy-promo-poncho-pikachu',
              cardId: 'xy-promo-poncho-pikachu',
              name: 'Poncho Pikachu',
              cardNumber: '#202/XY-P',
              setName: 'XY Promo',
              imageUrl: 'https://images.pokemontcg.io/xyp/202.png',
              marketPrice: null,
              currencyCode: 'USD',
            }],
          };
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    expect(await screen.findByText('Oshawott')).toBeTruthy();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));
    expect(await screen.findByText('Poncho Pikachu')).toBeTruthy();

    expect(screen.getByTestId('scanner-recent-title').props.children).toBe('SCAN: 2');
    // Newest capture is prepended, so the unpriced Poncho Pikachu is row 0.
    expect(screen.getByTestId('scanner-tray-price-0')).toHaveTextContent('—');
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('TOTAL: $0.56');
  });

  it('drops a non-USD candidate from the tray TOTAL instead of summing it as USD', async () => {
    // The tray prices in USD only. A ¥4,000 row folded into a USD sum would read
    // as $4,000 — a ~25x overstatement a dealer could act on financially — so an
    // unsupported currency is excluded from the TOTAL and reported to PostHog.
    // The row itself still shows the card's own price honestly.
    //
    // Reachability of this path is a SERVER-side gap, tracked separately: the
    // backend normalizes pricing to USD only when it holds an FX snapshot
    // (`fx_rates.decorate_pricing_summary_with_fx` returns the pricing untouched
    // on a snapshot miss) and the client mapper preserves whatever arrives.
    const spotlightRepository = createTestSpotlightRepository({
      getInventoryEntries: async () => [],
      matchScannerCapture: async () => ({
        scanID: 'scan-jp-promo',
        candidates: [{
          id: 'jp-promo-gastly',
          cardId: 'jp-promo-gastly',
          name: 'Gastly',
          cardNumber: '#014',
          setName: 'JP Promo',
          imageUrl: 'https://cdn.spotlight.test/gastly.png',
          marketPrice: 4000,
          currencyCode: 'JPY',
        }],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Gastly')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-price-0')).toHaveTextContent('¥4,000.00');
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('TOTAL: $0.00');
  });

});
