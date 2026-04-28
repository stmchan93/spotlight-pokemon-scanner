import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { LayoutAnimation, StyleSheet } from 'react-native';

import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import {
  clearScanCandidateReviewSessions,
  getScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';
import { createTestSpotlightRepository, renderWithProviders } from './test-utils';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockConfigureNext = jest.spyOn(LayoutAnimation, 'configureNext').mockImplementation(jest.fn());

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');

  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({
      push: mockPush,
      replace: mockReplace,
    }),
  };
});

function renderScannerScreen(options?: Parameters<typeof renderWithProviders>[1]) {
  return renderWithProviders(<ScannerScreen />, options);
}

async function waitForScannerReady() {
  await waitFor(() => {
    expect(screen.getByTestId('scanner-preview').props.accessibilityState?.disabled).toBe(false);
  });
}

describe('ScannerScreen', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
    mockConfigureNext.mockClear();
    clearScanCandidateReviewSessions();
  });

  it('switches between raw and slabs guidance', () => {
    renderScannerScreen();

    expect(screen.getByTestId('scanner-camera')).toBeTruthy();
    expect(screen.getByTestId('scanner-preview')).toBeTruthy();
    expect(screen.getByTestId('scanner-reticle')).toBeTruthy();
    expect(screen.getByTestId('scanner-mode-toggle')).toBeTruthy();
    expect(screen.getByTestId('scanner-back-button')).toBeTruthy();
    expect(screen.getByText('RAW')).toBeTruthy();
    expect(screen.getByText('SLABS')).toBeTruthy();
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

    fireEvent.press(screen.getByText('SLABS'));

    expect(screen.getByTestId('scanner-slab-guide')).toBeTruthy();
  });

  it('renders an empty recent scans tray with no placeholder rows', () => {
    renderScannerScreen();

    expect(screen.getByTestId('scanner-tray')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-header')).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-body')).toBeTruthy();
    expect(screen.getByTestId('scanner-recent-title')).toBeTruthy();
    expect(screen.getByTestId('scanner-value-pill-text')).toBeTruthy();
    expect(screen.queryByText('CLEAR')).toBeNull();
    expect(screen.queryByTestId('scanner-matches-button')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-toggle')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-row-pending')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-row-review')).toBeNull();
    expect(screen.queryByTestId('scanner-tray-row-expand')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('scanner-recent-title').props.style)).toMatchObject({
      fontSize: 16,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByTestId('scanner-value-pill-text').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
    });
  });

  it('captures a scan photo when the preview is tapped', async () => {
    renderScannerScreen();

    expect(StyleSheet.flatten(screen.getByTestId('scanner-prompt').props.style)).toMatchObject({
      fontSize: 16,
      lineHeight: 20,
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
    expect(screen.getByText("McDonald's Collection 2021 • #21/25")).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-qty-0')).toBeTruthy();
    expect(screen.queryByTestId('scanner-matches-button')).toBeNull();
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('$0.56');
    expect(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
      includeHiddenElements: true,
    })).toBeTruthy();
    expect(screen.getByTestId('scanner-tray-swipe-0-delete-button', {
      includeHiddenElements: true,
    }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('sends a normalized reticle target to scanner matching', async () => {
    const payloads: Array<{ height: number; jpegBase64: string; width: number }> = [];
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
    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('$0.56');
  });

  it('allows a single scan tray to expand and keeps it expanded when deleting down to one scan', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    expect(screen.getByTestId('scanner-tray-toggle')).toBeTruthy();
    fireEvent.press(screen.getByTestId('scanner-tray-toggle'));

    let expandedViewportHeight = 0;
    await waitFor(() => {
      expandedViewportHeight = StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height ?? 0;
      expect(expandedViewportHeight).toBeGreaterThanOrEqual(248);
    });

    fireEvent.press(screen.getByTestId('scanner-tray-toggle'));

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('scanner-tray-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-1')).toBeTruthy();
    });

    expandedViewportHeight = StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height ?? 0;
    fireEvent.press(screen.getByTestId('scanner-tray-swipe-0-reveal-delete', {
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
    expect(screen.getByTestId('scanner-tray-toggle')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height).toBe(expandedViewportHeight);
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

    expect(screen.getByTestId('scanner-tray-toggle')).toBeTruthy();
    await waitFor(() => {
      expect(pendingResolvers).toHaveLength(2);
    });

    fireEvent.press(screen.getByTestId('scanner-tray-toggle'));

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

  it('cycles through scan candidates when the thumbnail is tapped', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Oshawott')).toBeTruthy();
    expect(screen.queryByText('Potential match')).toBeNull();

    fireEvent.press(screen.getByTestId('scanner-tray-thumb-0'));

    await waitFor(() => {
      expect(screen.getByText('Scorbunny')).toBeTruthy();
    });

    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('$0.38');
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

    expect(screen.getByTestId('scanner-tray-toggle')).toBeTruthy();
    expect(screen.queryByTestId('scanner-tray-row-1')).toBeNull();

    fireEvent.press(screen.getByTestId('scanner-tray-toggle'));
    expect(mockConfigureNext).toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-scroll')).toBeTruthy();
      expect(screen.getByTestId('scanner-tray-viewport')).toBeTruthy();
      expect(screen.getByTestId('scanner-tray-row-1')).toBeTruthy();
    });

    const viewportHeight = StyleSheet.flatten(screen.getByTestId('scanner-tray-viewport').props.style)?.height ?? 0;
    expect(viewportHeight).toBeGreaterThanOrEqual(248);
    expect(viewportHeight).toBeLessThanOrEqual(428);

    fireEvent.press(screen.getByTestId('scanner-preview'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-row-2')).toBeTruthy();
    });

    expect(screen.getByTestId('scanner-tray-scroll').props.scrollEnabled).toBe(false);
    expect(screen.getByTestId('scanner-tray-scroll').props.showsVerticalScrollIndicator).toBe(false);
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
    expect(screen.queryByTestId('scanner-tray-qty-0')).toBeNull();

    fireEvent.press(screen.getByTestId('scanner-tray-add-0'));

    await waitFor(() => {
      expect(screen.getByTestId('scanner-tray-qty-0')).toBeTruthy();
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
    fireEvent.press(screen.getByTestId('scanner-tray-add-0'));

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
    fireEvent.press(screen.getByTestId('scanner-tray-refresh-0'));

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

    expect(mockReplace).toHaveBeenCalledWith('/portfolio');
  });
});
