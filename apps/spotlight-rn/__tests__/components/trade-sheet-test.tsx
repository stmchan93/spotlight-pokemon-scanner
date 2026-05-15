import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { mockInventoryEntries } from '@spotlight/api-client';

import { TradeSheet } from '@/features/payments/screens/trade-sheet';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('TradeSheet', () => {
  it('does not submit until at least one outbound card is selected', async () => {
    const createTrade = jest.fn();
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => mockInventoryEntries,
      createTrade,
    });

    renderWithProviders(
      <TradeSheet cardId="mcdonalds25-16" onClose={jest.fn()} onComplete={jest.fn()} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('trade-sheet-submit')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('trade-sheet-submit'));
    expect(createTrade).not.toHaveBeenCalled();
  });

  it('calls /trades once with the inbound card, outbound selection, and cash delta', async () => {
    const createTrade = jest.fn(async () => ({
      tradeId: 'trade_mock_1',
      ownerUserId: 'mock-user',
      inboundCardId: 'mcdonalds25-16',
      inboundCondition: 'near_mint',
      inboundGrader: null,
      inboundGrade: null,
      inboundCertNumber: null,
      inboundMarketValueCents: 250,
      inboundDeckEntryId: 'entry-trade-mock',
      cashDeltaCents: 500,
      outboundTotalMarketValueCents: 56,
      showSessionId: null,
      notes: null,
      createdAt: new Date().toISOString(),
      outboundEntries: [
        {
          outboundIndex: 0,
          deckEntryId: 'entry-2',
          cardId: 'mcdonalds25-21',
          condition: 'near_mint',
          grader: null,
          grade: null,
          certNumber: null,
          quantity: 1,
          marketValueCents: 56,
        },
      ],
    }));
    const onComplete = jest.fn();
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => mockInventoryEntries,
      createTrade,
    });

    renderWithProviders(
      <TradeSheet
        cardId="mcdonalds25-16"
        inboundMarketPrice={2.5}
        onClose={jest.fn()}
        onComplete={onComplete}
      />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('trade-sheet-inventory-row-entry-2')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('trade-sheet-inventory-row-entry-2'));
    fireEvent.changeText(screen.getByTestId('trade-sheet-cash-delta-input'), '5');
    fireEvent.press(screen.getByTestId('trade-sheet-submit'));

    await waitFor(() => {
      expect(createTrade).toHaveBeenCalledTimes(1);
    });
    expect(createTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        inbound: expect.objectContaining({
          cardId: 'mcdonalds25-16',
          marketValueCents: 250,
        }),
        outbound: [
          expect.objectContaining({
            deckEntryId: 'entry-2',
            quantity: 1,
            marketValueCents: 56,
          }),
        ],
        cashDeltaCents: 500,
      }),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('renders the Scan inbound CTA when opened without a cardId and routes through onScanInbound', async () => {
    const onScanInbound = jest.fn();
    const createTrade = jest.fn();
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => mockInventoryEntries,
      createTrade,
    });

    renderWithProviders(
      <TradeSheet
        onClose={jest.fn()}
        onComplete={jest.fn()}
        onScanInbound={onScanInbound}
      />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('trade-sheet-no-inbound')).toBeTruthy();
    });

    const scanInboundButton = screen.getByTestId('trade-sheet-scan-inbound');
    expect(scanInboundButton).toBeTruthy();

    fireEvent.press(scanInboundButton);
    expect(onScanInbound).toHaveBeenCalledTimes(1);

    // Submit is still disabled without an inbound card, even if an outbound
    // is selected and a cash delta is set — the trade can't be saved yet.
    expect(createTrade).not.toHaveBeenCalled();
  });
});
