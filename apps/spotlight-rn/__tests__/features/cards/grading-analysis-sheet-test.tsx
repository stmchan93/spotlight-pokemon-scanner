import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import {
  mockCardGradingAnalysis,
  mockCardGradingAnalysisOnlyAt10,
  type CardGradingAnalysis,
  type SpotlightRepository,
} from '@spotlight/api-client';
import { CardConfigurator } from '@/features/cards/components/card-configurator';
import {
  GradingAnalysisSheet,
  clearGradingAnalysisCache,
} from '@/features/cards/components/grading-analysis-sheet';
import { WorthGradingButton } from '@/features/cards/components/worth-grading-button';
import { capturePostHogEvent } from '@/lib/observability/posthog';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

const push = jest.fn();

function renderSheet(
  getCardGradingAnalysis: SpotlightRepository['getCardGradingAnalysis'],
  props: Partial<Parameters<typeof GradingAnalysisSheet>[0]> = {},
) {
  const onClose = jest.fn();
  const element = (visible: boolean) => (
    <GradingAnalysisSheet
      cardId="sv2-232"
      cardName="Charizard ex"
      cardNumber="232/193"
      game="pokemon"
      onClose={onClose}
      setName="Paldea Evolved"
      variant="Holofoil"
      visible={visible}
      {...props}
    />
  );
  const view = renderWithProviders(element(true), {
    spotlightRepository: createTestSpotlightRepository({ getCardGradingAnalysis }),
  });
  return { ...view, onClose, rerenderVisible: (visible: boolean) => view.rerender(element(visible)) };
}

function withVerdict(verdict: CardGradingAnalysis['verdict']): CardGradingAnalysis {
  return { ...mockCardGradingAnalysis, verdict };
}

describe('GradingAnalysisSheet', () => {
  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({ push, replace: jest.fn(), back: jest.fn() });
  });

  afterEach(() => {
    clearGradingAnalysisCache();
    jest.clearAllMocks();
  });

  it('shows the loading state while the analysis is on its way', async () => {
    let resolve: (value: CardGradingAnalysis | null) => void = () => {};
    renderSheet(() => new Promise((done) => { resolve = done; }));

    expect(screen.getByText('✦ Ekalight analysis')).toBeTruthy();
    expect(screen.getByTestId('grading-analysis-sheet-loading')).toHaveTextContent('Analyzing…');
    expect(screen.getByTestId('grading-analysis-sheet-skeleton')).toBeTruthy();

    await act(async () => resolve(mockCardGradingAnalysis));
    expect(screen.queryByTestId('grading-analysis-sheet-loading')).toBeNull();
  });

  it.each([
    ['worth_it', 'Worth grading'],
    ['only_at_10', 'Only worth it at a PSA 10'],
    ['not_worth_it', 'Not worth grading'],
  ] as const)('headlines the %s verdict', async (verdict, headline) => {
    renderSheet(async () => withVerdict(verdict));

    expect(await screen.findByTestId('grading-analysis-sheet-headline')).toHaveTextContent(headline);
  });

  it('renders the summary, ✓/✗ outcomes, the raw reference and the costs', async () => {
    renderSheet(async () => mockCardGradingAnalysis);

    expect(await screen.findByTestId('grading-analysis-sheet-summary')).toHaveTextContent(mockCardGradingAnalysis.summary);
    expect(screen.getByTestId('grading-analysis-sheet-outcome-10')).toHaveTextContent(/PSA 10\$310 → you keep ~\$275✓/);
    expect(screen.getByTestId('grading-analysis-sheet-outcome-9-mark')).toHaveTextContent('✓');
    expect(screen.getByTestId('grading-analysis-sheet-outcome-8-mark')).toHaveTextContent('✗');
    expect(screen.getByTestId('grading-analysis-sheet-raw')).toHaveTextContent('Raw NM$42');
    expect(screen.getByTestId('grading-analysis-sheet-costs'))
      .toHaveTextContent('Value Bulk · $24.99 + ~$10 shipping · ~65 business days');
    expect(screen.getByTestId('grading-analysis-sheet-fees-caption'))
      .toHaveTextContent('Fees: PSA, as of Nov 1, 2026 · estimates, not a guarantee');
    expect(capturePostHogEvent).toHaveBeenCalledWith('grading_analysis_result', { verdict: 'worth_it', summarySource: 'ai' });
  });

  it('says so when there are not enough PSA sales (204)', async () => {
    renderSheet(async () => null);

    expect(await screen.findByTestId('grading-analysis-sheet-empty'))
      .toHaveTextContent('Not enough PSA sales to judge this card yet.');
  });

  it('offers a retry after a failure', async () => {
    const fetcher = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(mockCardGradingAnalysisOnlyAt10);
    renderSheet(fetcher);

    fireEvent.press(await screen.findByTestId('grading-analysis-sheet-retry'));

    expect(await screen.findByTestId('grading-analysis-sheet-headline')).toHaveTextContent('Only worth it at a PSA 10');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fetches once per card + printing and re-opens from the session cache', async () => {
    const fetcher = jest.fn(async () => mockCardGradingAnalysis);
    const { rerenderVisible } = renderSheet(fetcher);
    await screen.findByTestId('grading-analysis-sheet-headline');

    rerenderVisible(false);
    rerenderVisible(true);

    expect(screen.getByTestId('grading-analysis-sheet-headline')).toHaveTextContent('Worth grading');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith({ cardId: 'sv2-232', variant: 'Holofoil', grader: 'PSA' });
  });

  it('Ask Ekalight closes the sheet and opens the chat with the question', async () => {
    const { onClose } = renderSheet(async () => mockCardGradingAnalysis);
    await screen.findByTestId('grading-analysis-sheet-headline');

    fireEvent.press(screen.getByTestId('grading-analysis-sheet-ask'));

    expect(capturePostHogEvent).toHaveBeenCalledWith('grading_analysis_ask_ekalight', { game: 'pokemon' });
    expect(onClose).toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
    const href = push.mock.calls[0][0] as { pathname: string; params: Record<string, string> };
    expect(href.pathname).toBe('/assistant');
    expect(href.params.prompt).toBe(
      'Is my Charizard ex (Paldea Evolved 232/193) worth grading with PSA? Help me pick a tier.',
    );
    expect(JSON.parse(href.params.page)).toEqual({
      kind: 'card',
      label: 'Charizard ex · Paldea Evolved',
      params: { card_id: 'sv2-232', grader: 'PSA', variant: 'Holofoil' },
    });
  });
});

describe('CardConfigurator aiAction', () => {
  const base = {
    graders: ['Raw', 'PSA'],
    onSelectGrader: jest.fn(),
    onSelectLanguage: jest.fn(),
    onSelectVariant: jest.fn(),
    selectedGrader: 'Raw',
    selectedLanguage: 'EN',
    selectedVariant: null,
    testID: 'configurator',
    variants: [],
  };

  it('sits on the language row beside the chips', () => {
    const onPress = jest.fn();
    renderWithProviders(
      <CardConfigurator {...base} aiAction={<WorthGradingButton onPress={onPress} />} languages={['EN', 'JP']} />,
    );

    expect(screen.queryByTestId('configurator-ai-row')).toBeNull();
    const button = screen.getByTestId('worth-grading-button');
    expect(within(button).getByText('Worth grading?')).toBeTruthy();
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalled();
  });

  it('gets its own right-aligned row when there is no language row', () => {
    renderWithProviders(
      <CardConfigurator {...base} aiAction={<WorthGradingButton onPress={jest.fn()} />} languages={[]} />,
    );

    expect(within(screen.getByTestId('configurator-ai-row')).getByTestId('worth-grading-button')).toBeTruthy();
  });

  it('renders nothing extra without an aiAction', () => {
    renderWithProviders(<CardConfigurator {...base} languages={[]} />);

    expect(screen.queryByTestId('configurator-ai-row')).toBeNull();
    expect(screen.queryByTestId('worth-grading-button')).toBeNull();
  });
});
