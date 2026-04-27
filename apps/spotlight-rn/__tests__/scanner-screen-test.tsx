import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { createTestSpotlightRepository, renderWithProviders } from './test-utils';

const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
}));

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
    const pendingResolvers: Array<(value: any) => void> = [];
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

  it('cycles through scan candidates with the thumbnail refresh control', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    fireEvent.press(screen.getByTestId('scanner-preview'));

    expect(await screen.findByText('Oshawott')).toBeTruthy();
    expect(screen.queryByText('Potential match')).toBeNull();

    fireEvent.press(screen.getByTestId('scanner-tray-refresh-0'));

    await waitFor(() => {
      expect(screen.getByText('Scorbunny')).toBeTruthy();
    });

    expect(screen.getByTestId('scanner-value-pill-text').props.children).toBe('$0.38');
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
        },
      });
    });
  });

  it('keeps the tray collapsed to the newest scan until expanded, then opens a calm half-screen viewport', async () => {
    renderScannerScreen();

    await waitForScannerReady();
    for (let index = 0; index < 2; index += 1) {
      fireEvent.press(screen.getByTestId('scanner-preview'));
      // Let the mocked camera request settle before the next capture.
      // The newest row remains row 0 even after multiple captures.
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => {
        expect(screen.getByTestId('scanner-tray-row-0')).toBeTruthy();
      });
      // eslint-disable-next-line no-await-in-loop
      await waitForScannerReady();
    }

    expect(screen.getByTestId('scanner-tray-toggle')).toBeTruthy();
    expect(screen.queryByTestId('scanner-tray-row-1')).toBeNull();

    fireEvent.press(screen.getByTestId('scanner-tray-toggle'));

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
    const spotlightRepository = createTestSpotlightRepository({
      createPortfolioBuy: async (payload) => {
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
            addedAt: payload.boughtAt,
            kind: 'raw',
            conditionCode: 'near_mint',
            conditionLabel: 'Near Mint',
            conditionShortLabel: 'NM',
            costBasisPerUnit: 55,
            costBasisTotal: 55,
          },
        ];

        return {
          deckEntryID: 'entry-froakie',
          cardID: payload.cardID,
          inserted: true,
          quantityAdded: payload.quantity,
          totalSpend: payload.quantity * payload.unitPrice,
          boughtAt: payload.boughtAt,
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
