import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { CardTransactionRecord } from '@spotlight/api-client';

import { LogTransactionScreen } from '@/features/sales/screens/log-transaction-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

const mockCapturePostHogEvent = jest.fn();

jest.mock('@/lib/observability/posthog', () => ({
  ...jest.requireActual('@/lib/observability/posthog'),
  capturePostHogEvent: (...args: unknown[]) => mockCapturePostHogEvent(...args),
}));

function buildCreatedRecord(overrides: Partial<CardTransactionRecord> = {}): CardTransactionRecord {
  return {
    id: 'txn-new',
    kind: 'sold',
    amountCents: 1250,
    currencyCode: 'USD',
    occurredAt: '2026-06-02T00:00:00.000Z',
    occurredAtLabel: null,
    note: null,
    photoUrl: null,
    createdAt: '2026-06-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('LogTransactionScreen', () => {
  beforeEach(() => {
    mockCapturePostHogEvent.mockClear();
  });

  it('renders the camera trigger, kind toggle, and price field', () => {
    renderWithProviders(
      <LogTransactionScreen onClose={jest.fn()} onComplete={jest.fn()} />,
    );

    expect(screen.getByTestId('log-transaction-photo-trigger')).toBeTruthy();
    expect(screen.getByTestId('log-transaction-kind-bought')).toBeTruthy();
    expect(screen.getByTestId('log-transaction-kind-sold')).toBeTruthy();
    expect(screen.getByTestId('log-transaction-kind-traded')).toBeTruthy();
    expect(screen.getByTestId('log-transaction-price')).toBeTruthy();
  });

  it('keeps Save disabled until a valid price is entered', () => {
    renderWithProviders(
      <LogTransactionScreen onClose={jest.fn()} onComplete={jest.fn()} />,
    );

    expect(screen.getByTestId('log-transaction-save').props.accessibilityState?.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('log-transaction-price'), '12.50');

    expect(screen.getByTestId('log-transaction-save').props.accessibilityState?.disabled).toBe(false);
  });

  it('submits the captured photo, kind, and amount and calls onComplete on success', async () => {
    const createCardTransaction = jest.fn(async () => buildCreatedRecord({ kind: 'bought', amountCents: 1250 }));
    const onComplete = jest.fn();
    const repository = createTestSpotlightRepository({ createCardTransaction });

    renderWithProviders(
      <LogTransactionScreen onClose={jest.fn()} onComplete={onComplete} />,
      { spotlightRepository: repository },
    );

    // Capture a photo.
    fireEvent.press(screen.getByTestId('log-transaction-photo-trigger'));
    fireEvent.press(screen.getByTestId('log-transaction-capture-photo'));
    await waitFor(() => {
      expect(screen.getByTestId('log-transaction-photo-thumbnail')).toBeTruthy();
    });

    // Pick a kind and a price.
    fireEvent.press(screen.getByTestId('log-transaction-kind-bought'));
    fireEvent.changeText(screen.getByTestId('log-transaction-price'), '12.50');

    await act(async () => {
      fireEvent.press(screen.getByTestId('log-transaction-save'));
    });

    await waitFor(() => {
      expect(createCardTransaction).toHaveBeenCalledTimes(1);
    });

    expect(createCardTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bought',
        amountCents: 1250,
        currencyCode: 'USD',
        occurredAt: expect.any(String),
        photo: expect.objectContaining({
          jpegBase64: expect.any(String),
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      }),
    );
    expect(mockCapturePostHogEvent).toHaveBeenCalledWith('transaction_logged', { kind: 'bought' });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('submits with a null photo when none is captured', async () => {
    const createCardTransaction = jest.fn(async () => buildCreatedRecord());
    const repository = createTestSpotlightRepository({ createCardTransaction });

    renderWithProviders(
      <LogTransactionScreen onClose={jest.fn()} onComplete={jest.fn()} />,
      { spotlightRepository: repository },
    );

    fireEvent.changeText(screen.getByTestId('log-transaction-price'), '40');

    await act(async () => {
      fireEvent.press(screen.getByTestId('log-transaction-save'));
    });

    await waitFor(() => {
      expect(createCardTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 4000, photo: null }),
      );
    });
  });

  it('surfaces an error and stays open when the create call fails', async () => {
    const createCardTransaction = jest.fn(async () => {
      throw new Error('network');
    });
    const onComplete = jest.fn();
    const repository = createTestSpotlightRepository({ createCardTransaction });

    renderWithProviders(
      <LogTransactionScreen onClose={jest.fn()} onComplete={onComplete} />,
      { spotlightRepository: repository },
    );

    fireEvent.changeText(screen.getByTestId('log-transaction-price'), '5');

    await act(async () => {
      fireEvent.press(screen.getByTestId('log-transaction-save'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('log-transaction-error')).toBeTruthy();
    });
    expect(onComplete).not.toHaveBeenCalled();
  });
});
