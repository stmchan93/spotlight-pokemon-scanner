import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import type { ComponentProps } from 'react';
import { Keyboard, LayoutAnimation, StyleSheet } from 'react-native';

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
const mockQuickClassifyCapture = jest.fn(async (_imageUri: string, _sourceUri?: string) => ({
  isSlabLikely: false,
  hasBarcode: false,
  confidence: 0.2,
  redBandScore: 0.1,
  barcodeRegionScore: 0.15,
  decodeMs: 5,
  classifyMs: 3,
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

jest.mock('@/features/scanner/slab-scanner-native', () => ({
  quickClassifyCapture: (imageUri: any) => mockQuickClassifyCapture(imageUri),
  isSlabScannerNativeAvailable: () => true,
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

// The scan lane is now driven by the "Scanning for" toggle, not the on-device
// classifier. Open the header pill, pick Graded, and dismiss the sheet so the
// next capture routes through the slab lane.
function selectGradedCondition() {
  fireEvent.press(screen.getByTestId('scanner-target-pill'));
  fireEvent.press(screen.getByTestId('scanning-for-sheet-condition-graded'));
  fireEvent.press(screen.getByTestId('scanning-for-sheet-backdrop'));
}

describe('ScannerScreen', () => {
  const originalExtra = mockedConstants.expoConfig?.extra
    ? { ...mockedConstants.expoConfig.extra }
    : {};
  const originalScannerSmokeEnv = process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED;

  beforeEach(() => {
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
    mockQuickClassifyCapture.mockClear();
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

  it('does not show the camera permission card when the scanner is mounted offscreen with granted permission', () => {
    renderWithProviders(
      <TabsPageContext.Provider value={{ activePage: 'portfolio', chartScrubLockRef: { current: false } }}>
        <ScannerScreen />
      </TabsPageContext.Provider>,
    );

    expect(screen.getByTestId('scanner-camera-fallback')).toBeTruthy();
    expect(screen.queryByTestId('scanner-permission-card')).toBeNull();
    expect(screen.queryByText('Camera access needed')).toBeNull();
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

  it('warns without changing the lane when the classifier sees a slab on the raw lane', async () => {
    const payloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);
        return { scanID: 'scan-mismatch', candidates: [] };
      },
    });

    renderScannerScreen({ spotlightRepository });

    // Default condition is Ungraded (raw lane). The classifier flags a slab.
    mockQuickClassifyCapture.mockResolvedValueOnce({
      isSlabLikely: true,
      hasBarcode: true,
      confidence: 0.8,
      redBandScore: 0.6,
      barcodeRegionScore: 0.5,
      decodeMs: 5,
      classifyMs: 3,
    });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });

    // The lane is authoritative: the toggle says Ungraded, so we stay raw and
    // never run the slab analysis, but we surface a dismissible mismatch notice.
    expect(payloads[0].mode).toBe('raw');
    expect(mockAnalyzeSlabCapture).not.toHaveBeenCalled();
    expect(await screen.findByTestId('scanner-mode-mismatch-notice')).toBeTruthy();
  });

  it('drops the scan and warns when the card language differs from the toggle', async () => {
    const payloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);
        return {
          scanID: 'scan-lang-mismatch',
          candidates: [],
          targetLanguageMismatch: { selected: 'english', detected: 'japanese', confidence: 0.97 },
        };
      },
    });

    renderScannerScreen({ spotlightRepository });

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });
    // Default toggle is English; the backend says this card is Japanese.
    expect(payloads[0].cardLanguage).toBe('english');

    const notice = await screen.findByTestId('scanner-language-mismatch-notice');
    expect(notice).toBeTruthy();
    // Clear, actionable messaging that names the detected language.
    expect(screen.getByText(/looks like a Japanese card/i)).toBeTruthy();

    // A wrong-language scan is never kept in the tray.
    expect(screen.queryByTestId('scanner-tray-row-pending')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-row-review')).toBeNull();

    // Tapping the notice flips the toggle and clears the warning.
    fireEvent.press(notice);
    expect(screen.queryByTestId('scanner-language-mismatch-notice')).toBeNull();
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
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('Total: $0.56');
    expect(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
      includeHiddenElements: true,
    })).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
      includeHiddenElements: true,
    }).props.accessibilityState).toMatchObject({
      disabled: true,
    });

    const trayShell = screen.getByTestId('scanner-tray');
    expect(typeof trayShell.props.onMoveShouldSetResponderCapture).toBe('function');
  });

  it('sends a normalized reticle target to scanner matching', async () => {
    const payloads: { height: number; jpegBase64: string; width: number }[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push({
          height: payload.height,
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

    expect(payloads[0]).toEqual({
      height: 880,
      jpegBase64: 'bm9ybWFsaXplZC1zY2FuLWJhc2U2NA==',
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
      sourceImage: {
        jpegBase64: 'bW9jay1zY2FuLWJhc2U2NA==',
      },
    });
    expect(payloads[0].sourceImage.width).toBeGreaterThan(0);
    expect(payloads[0].sourceImage.height).toBeGreaterThan(0);
    expect(payloads[0].normalizedImage).toEqual(expect.objectContaining({
      jpegBase64: payloads[0].jpegBase64,
      width: payloads[0].width,
      height: payloads[0].height,
    }));
    expect(typeof payloads[0].submittedAt).toBe('string');
    expect(payloads[0].slabAnalysis).toBeUndefined();
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
    fireEvent.press(screen.getByTestId('scanning-for-sheet-type-pokemon-jp'));
    fireEvent.press(screen.getByTestId('scanning-for-sheet-backdrop'));

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });

    expect(payloads[0]).toMatchObject({ mode: 'raw', cardLanguage: 'japanese' });
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
    const payloads: { height: number; jpegBase64: string; mode: string; width: number }[] = [];
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
    expect(payloads).toEqual([{
      height: 880,
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
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('Total: $0.56');
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
      expect(screen.queryByTestId('scanner-tray-row-1')).toBeNull();
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

  it('shows the backend slab review reason instead of a generic load failure', async () => {
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async () => ({
        scanID: 'scan-slab-unsupported',
        candidates: [],
        reviewDisposition: 'unsupported',
        reviewReason: 'Could not extract a confident slab grader and grade.',
      }),
    });

    renderScannerScreen({ spotlightRepository });

    selectGradedCondition();
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    expect(screen.getByText('SLAB scan')).toBeTruthy();
    expect(screen.getByText('Could not extract a confident slab grader and grade.')).toBeTruthy();
    expect(screen.queryByText('Photo captured, but matches could not load')).toBeNull();
  });

  it('surfaces the PSA-only message locally for non-PSA slabs without sending a match request', async () => {
    mockAnalyzeSlabCapture.mockResolvedValueOnce({
      parsed: {
        unsupportedReason: 'non_psa_slab_not_supported_yet',
      },
      scannerMatchFields: {
        ocrAnalysis: null,
        slabBarcodePayloads: [],
        slabCardNumberRaw: null,
        slabCertConfidence: null,
        slabCertNumber: null,
        slabClassifierReasons: ['unsupported_reason:non_psa_slab_not_supported_yet'],
        slabGrade: null,
        slabGradeConfidence: null,
        slabGrader: null,
        slabGraderConfidence: null,
        slabParsedLabelText: [],
        slabRecommendedLookupPath: 'needs_review',
      },
    } as any);

    const matchScannerCapture = jest.fn(async () => ({
      scanID: 'scan-should-not-run',
      candidates: [],
    }));
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture,
    });

    renderScannerScreen({ spotlightRepository });

    selectGradedCondition();
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByText('Slab type is currently not supported')).toBeTruthy();
    });

    expect(screen.getByText('We currently only support PSA slabs for now.')).toBeTruthy();
    expect(matchScannerCapture).not.toHaveBeenCalled();
  });

  it('shows a slab-analysis-unavailable review reason when the native slab bridge is missing', async () => {
    mockAnalyzeSlabCapture.mockRejectedValueOnce({
      code: 'native_module_unavailable',
      message: 'Native module SpotlightSlabScanner is not registered in this build.',
    });

    const matchScannerCapture = jest.fn(async () => ({
      scanID: 'scan-should-not-run',
      candidates: [],
    }));
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture,
    });

    renderScannerScreen({ spotlightRepository });

    selectGradedCondition();
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByText('Slab analysis is unavailable on this build.')).toBeTruthy();
    });

    expect(screen.getByText('SLAB scan')).toBeTruthy();
    expect(matchScannerCapture).not.toHaveBeenCalled();
  });

  it('sends slab analysis evidence and artifact images through scanner matching', async () => {
    const payloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async (payload) => {
        payloads.push(payload);

        return {
          scanID: 'scan-slab-dragonite',
          slabContext: {
            grader: 'PSA',
            grade: '9',
            certNumber: '12345678',
            variantName: 'PSA 9',
          },
          candidates: [{
            id: 'm2a-232',
            cardId: 'm2a-232',
            name: 'Mega Dragonite ex',
            cardNumber: '#232/193',
            setName: 'Mega 2A',
            imageUrl: 'https://cdn.spotlight.test/m2a-232.png',
            marketPrice: 30.83,
            currencyCode: 'USD',
          }],
        };
      },
    });

    renderScannerScreen({ spotlightRepository });

    selectGradedCondition();
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(payloads).toHaveLength(1);
    });

    expect(mockAnalyzeSlabCapture).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Mega Dragonite ex')).toBeTruthy();
    expect(screen.getByText('PSA • 9')).toBeTruthy();
    expect(screen.getByText('Mega 2A · #232/193')).toBeTruthy();
    expect(screen.getByText('Market avg.')).toBeTruthy();
    expect(screen.getAllByText('$30.83').length).toBeGreaterThan(0);
    expect(screen.getByTestId('scanner-tray-image-0').props.source).toEqual({
      uri: 'https://cdn.spotlight.test/m2a-232.png',
    });
    expect(payloads[0]).toMatchObject({
      mode: 'slabs',
      captureSource: 'camera',
      sourceImage: {
        jpegBase64: 'bW9jay1zY2FuLWJhc2U2NA==',
        width: 1920,
        height: 888,
      },
      slabAnalysis: {
        slabGrader: 'PSA',
        slabGrade: '9',
        slabCertNumber: '12345678',
        slabBarcodePayloads: ['12345678'],
        slabParsedLabelText: ['PSA 9 Mega Dragonite ex 232/193 M2a'],
        slabRecommendedLookupPath: 'psa_cert',
        ocrAnalysis: {
          slabEvidence: {
            grader: 'PSA',
            grade: '9',
            cert: '12345678',
          },
        },
      },
    });
    expect(payloads[0].normalizedImage).toEqual(expect.objectContaining({
      jpegBase64: payloads[0].jpegBase64,
      width: payloads[0].width,
      height: payloads[0].height,
    }));
    expect(payloads[0].width).toBeGreaterThan(0);
    expect(payloads[0].height).toBeGreaterThan(0);
    // The slab pipeline produces a distinct label crop for the normalized target. The
    // upload payload must carry that crop, not a duplicate of the full source capture,
    // otherwise GCS gets two identical blobs instead of capture + normalized.
    expect(payloads[0].sourceImage.jpegBase64).not.toBe(payloads[0].normalizedImage.jpegBase64);

    fireEvent.press(screen.getByTestId('scanner-tray-open-card-0'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/cards/[cardId]',
        params: {
          cardId: 'm2a-232',
          entryId: undefined,
          scanReviewId: expect.any(String),
        },
      });
    });

    const pushedRoute = mockPush.mock.calls.at(-1)?.[0] as { params?: { scanReviewId?: string } };
    const scanReviewSession = getScanCandidateReviewSession(pushedRoute.params?.scanReviewId);
    expect(scanReviewSession?.slabContext).toEqual({
      grader: 'PSA',
      grade: '9',
      certNumber: '12345678',
      variantName: 'PSA 9',
    });
  });

  it('shows an unavailable price marker for slab matches without graded pricing', async () => {
    const spotlightRepository = createTestSpotlightRepository({
      matchScannerCapture: async () => ({
        scanID: 'scan-slab-unpriced',
        slabContext: {
          grader: 'PSA',
          grade: '9',
          certNumber: '76243431',
          variantName: 'PSA 9',
        },
        candidates: [{
          id: 'base1-4',
          cardId: 'base1-4',
          name: 'Charizard',
          cardNumber: '#4/102',
          setName: 'Base',
          imageUrl: 'https://cdn.spotlight.test/base1-4.png',
          marketPrice: null,
          currencyCode: 'USD',
        }],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    selectGradedCondition();
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    expect(screen.getByText('Charizard')).toBeTruthy();
    expect(screen.getByText('PSA • 9')).toBeTruthy();
    expect(screen.getByText('Base · #4/102')).toBeTruthy();
    expect(screen.getAllByText('$0.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('Total: $0.00');
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
      expect(screen.getByText('Scorbunny')).toBeTruthy();
    });

    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('Total: $0.38');
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
    // The second-newest scan is RENDERED in the DOM in the collapsed state
    // (so it can peek beneath the top row), but the tray viewport height
    // crops it to a small sliver via overflow:hidden. Confirm the peek row
    // exists and the viewport is sized for "one full row + small peek",
    // NOT for two full rows.
    expect(screen.getByTestId('scanner-tray-row-1')).toBeTruthy();
    const collapsedViewportHeight =
      StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height ?? 0;
    expect(collapsedViewportHeight).toBeGreaterThanOrEqual(102 + 14); // one row + peek
    expect(collapsedViewportHeight).toBeLessThan(102 + 16 + 102); // less than two full rows + gap

    fireEvent.press(screen.getByTestId('scanner-tray-header'));
    expect(mockConfigureNext).toHaveBeenCalled();

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
    fireEvent.press(screen.getByTestId('scanner-tray-add-0'));

    await waitFor(() => {
      expect(addPayloads).toHaveLength(1);
    });
    expect(addPayloads[0]).toEqual(expect.objectContaining({
      sourceScanID: 'scan-froakie',
      selectionSource: 'top',
      selectedRank: 1,
      wasTopPrediction: true,
    }));
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
    fireEvent.press(screen.getByTestId('scanner-tray-add-0'));

    await waitFor(() => {
      expect(addPayloads).toHaveLength(1);
    });
    expect(addPayloads[0]?.sourceScanID).toBeNull();
  });

  it('adds slab scans to inventory without forcing raw condition or null slab context', async () => {
    let inventoryEntries: any[] = [];
    const addPayloads: any[] = [];
    const spotlightRepository = createTestSpotlightRepository({
      createInventoryEntry: async (payload) => {
        addPayloads.push(payload);
        inventoryEntries = [
          {
            id: 'entry-dragonite-slab',
            cardId: payload.cardID,
            name: 'Mega Dragonite ex',
            cardNumber: '#232/193',
            setName: 'Mega 2A',
            imageUrl: 'https://cdn.spotlight.test/m2a-232.png',
            marketPrice: 30.83,
            hasMarketPrice: true,
            currencyCode: 'USD',
            quantity: 1,
            addedAt: payload.addedAt,
            kind: 'graded',
            slabContext: payload.slabContext,
            variantName: payload.variantName,
            conditionCode: null,
            conditionLabel: null,
            conditionShortLabel: null,
            costBasisPerUnit: null,
            costBasisTotal: 0,
          },
        ];

        return {
          deckEntryID: 'entry-dragonite-slab',
          cardID: payload.cardID,
          variantName: payload.variantName,
          condition: payload.condition,
          confirmationID: 'confirmation-dragonite-slab',
          sourceScanID: payload.sourceScanID,
          addedAt: payload.addedAt,
        };
      },
      getInventoryEntries: async () => inventoryEntries,
      matchScannerCapture: async () => ({
        scanID: 'scan-dragonite-slab',
        slabContext: {
          grader: 'PSA',
          grade: '9',
          certNumber: '12345678',
          variantName: 'First Edition Shadowless Holofoil',
        },
        candidates: [{
          id: 'm2a-232',
          cardId: 'm2a-232',
          name: 'Mega Dragonite ex',
          cardNumber: '#232/193',
          setName: 'Mega 2A',
          imageUrl: 'https://cdn.spotlight.test/m2a-232.png',
          marketPrice: 30.83,
          currencyCode: 'USD',
        }],
      }),
    });

    renderScannerScreen({ spotlightRepository });

    selectGradedCondition();
    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Mega Dragonite ex')).toBeTruthy();
    expect(screen.getByText('PSA • 9')).toBeTruthy();
    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-reveal-actions', {
      hidden: true,
    }));
    fireEvent.press(screen.getByTestId('scanner-tray-add-0'));

    await waitFor(() => {
      expect(addPayloads).toHaveLength(1);
    });
    expect(addPayloads[0]).toEqual(expect.objectContaining({
      condition: null,
      slabContext: {
        grader: 'PSA',
        grade: '9',
        certNumber: '12345678',
        variantName: 'First Edition Shadowless Holofoil',
      },
      sourceScanID: 'scan-dragonite-slab',
      variantName: 'First Edition Shadowless Holofoil',
    }));
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
      expect(screen.getByText('Scorbunny')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('scanner-tray-open-card-0'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/cards/[cardId]',
        params: {
          cardId: 'mcdonalds25-16',
          entryId: 'entry-1',
          scanReviewId: expect.any(String),
        },
      });
    });
  });

  it('exits the scanner to portfolio from the back button', () => {
    renderScannerScreen();

    fireEvent.press(screen.getByTestId('scanner-back-button'));

    expect(mockDismissTo).toHaveBeenCalledWith({
      pathname: '/',
      params: { page: 'portfolio' },
    });
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
    fireEvent.press(screen.getByTestId('scanner-tray-add-0'));

    await waitFor(() => {
      expect(addPayloads).toHaveLength(1);
    });
    expect(addPayloads[0]).toEqual(expect.objectContaining({
      condition: 'lightly_played',
    }));
  });

});
