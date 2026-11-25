import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import type { CardDetailRecord } from '@spotlight/api-client';

import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { clearCardDetailPreviewSessions } from '@/features/cards/card-detail-preview-session';
import { clearGradingAnalysisCache } from '@/features/cards/components/grading-analysis-sheet';
import { capturePostHogEvent } from '@/lib/observability/posthog';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

describe('card detail "Worth grading?"', () => {
  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({ replace: jest.fn(), push: jest.fn(), back: jest.fn(), dismissTo: jest.fn() });
  });

  afterEach(() => {
    clearCardDetailPreviewSessions();
    clearCardDetailCache();
    clearGradingAnalysisCache();
    jest.clearAllMocks();
  });

  function detailWith(patch: Partial<CardDetailRecord>) {
    const baseRepository = createTestSpotlightRepository();
    return jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail({ ...query, cardId: 'sm7-1' });
      return base ? ({ ...base, cardId: query.cardId, ...patch } satisfies CardDetailRecord) : null;
    });
  }

  it('opens the analysis sheet and asks for the selected printing', async () => {
    const baseRepository = createTestSpotlightRepository();
    const getCardGradingAnalysis = jest.fn((query: Parameters<typeof baseRepository.getCardGradingAnalysis>[0]) =>
      baseRepository.getCardGradingAnalysis(query));
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ game: 'pokemon', catalogSource: 'scrydex' }),
          getCardGradingAnalysis,
        }),
      },
    );

    // Pick a printing, then open the sheet.
    fireEvent.press(await screen.findByTestId('detail-configurator-variant-raw'));
    fireEvent.press(screen.getByTestId('detail-worth-grading'));

    expect(await screen.findByTestId('detail-grading-sheet-headline')).toHaveTextContent('Only worth it at a PSA 10');
    expect(getCardGradingAnalysis).toHaveBeenCalledWith({ cardId: 'sm7-1', variant: 'Raw', grader: 'PSA' });
    expect(capturePostHogEvent).toHaveBeenCalledWith('grading_analysis_opened', { cardId: 'sm7-1', game: 'pokemon' });
  });

  it('hides the button for a TCGplayer-only card', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="tcgplayer-600001" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ game: 'pokemon', catalogSource: 'tcgplayer' }),
        }),
      },
    );

    await screen.findByTestId('detail-configurator-grader-Raw');
    expect(screen.queryByTestId('detail-worth-grading')).toBeNull();
  });

  it('hides the button for a game without PSA pricing', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="op01-001" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ game: 'onepiece', catalogSource: 'scrydex' }),
        }),
      },
    );

    await screen.findByTestId('detail-configurator-grader-Raw');
    await waitFor(() => expect(screen.queryByTestId('detail-configurator-grader-PSA')).not.toBeOnTheScreen());
    expect(screen.queryByTestId('detail-worth-grading')).toBeNull();
  });

  it('hides the button for a sealed product', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="tcgp-sealed-593355" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ game: 'pokemon', productKind: 'sealed' }),
        }),
      },
    );

    await screen.findByTestId('detail-name');
    await waitFor(() => expect(screen.queryByTestId('detail-configurator')).not.toBeOnTheScreen());
    expect(screen.queryByTestId('detail-worth-grading')).toBeNull();
  });
});
