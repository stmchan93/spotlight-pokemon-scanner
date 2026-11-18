import { fireEvent, screen } from '@testing-library/react-native';

import {
  mockAssistantCards,
  mockAssistantPriceChart,
  parseAssistantMessage,
  type AssistantMessage,
  type AssistantPriceChart,
} from '@spotlight/api-client';

import { AssistantCardTile } from '@/features/assistant/components/assistant-card-tile';
import { AssistantMessageBubble } from '@/features/assistant/components/assistant-message-bubble';
import {
  assistantChartSeriesLabel,
  buildAssistantChartModel,
} from '@/features/assistant/components/assistant-price-chart';

import { renderWithProviders } from '../../test-utils';

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'a1',
    threadId: 'thr_1',
    role: 'assistant',
    text: '**Celebi** climbed about 21% over the past 3 months.',
    cards: [],
    actions: [],
    createdAt: '2026-11-17T10:00:00Z',
    status: 'ok',
    ...overrides,
  };
}

function renderBubble(message: AssistantMessage) {
  const onOpenCard = jest.fn();
  renderWithProviders(
    <AssistantMessageBubble
      actionStates={{}}
      message={message}
      onConfirmAction={jest.fn()}
      onDismissAction={jest.fn()}
      onOpenCard={onOpenCard}
    />,
  );
  return { onOpenCard };
}

describe('assistant price chart', () => {
  it('renders the chart from message.charts and opens the card on tap', () => {
    const { onOpenCard } = renderBubble(reply({ charts: [mockAssistantPriceChart()] }));
    expect(screen.getByTestId('assistant-message-a1-chart-0-chart')).toBeTruthy();
    expect(screen.getByTestId('assistant-message-a1-chart-0-price')).toHaveTextContent('$37.54');
    expect(screen.getByTestId('assistant-message-a1-chart-0-delta')).toHaveTextContent('$6.54 (21.10%)');
    expect(screen.getByText('NM · Past 3 months')).toBeTruthy();
    expect(screen.getByTestId('assistant-message-a1-chart-0-as-of')).toHaveTextContent(/TCGplayer market/);
    fireEvent.press(screen.getByTestId('assistant-message-a1-chart-0-open'));
    expect(onOpenCard).toHaveBeenCalledWith('xyp-111');
  });

  it('renders nothing extra without charts (older messages)', () => {
    renderBubble(reply());
    expect(screen.queryByTestId('assistant-message-a1-chart-0')).toBeNull();
  });

  it('anchors the window to the newest point so an old answer still draws', () => {
    // Graded series that stopped months ago: the PDP would call it stale.
    const chart: AssistantPriceChart = {
      ...mockAssistantPriceChart('2025-06-01'),
      condition: null,
      grader: 'PSA',
      grade: '10',
      range: '1y',
      source: 'scrydex',
    };
    const model = buildAssistantChartModel(chart);
    expect(model?.insufficient).toBe(false);
    expect(model?.points).toHaveLength(30);
    expect(assistantChartSeriesLabel(chart)).toBe('PSA 10 · Past year');
  });

  it('parses wire charts: camelCase, USD points only, capped at 2, user rows get none', () => {
    const wire = {
      card_id: 'xyp-111',
      name: 'Celebi',
      variant: null,
      condition: 'NM',
      grader: null,
      grade: null,
      range: '1y',
      points: [{ date: '2026-10-02', usd: 30 }, { date: 'bad', usd: 1 }, { date: '2026-10-01', usd: 29 }],
      source: 'tcgplayer',
    };
    const parsed = parseAssistantMessage({
      id: 'm',
      role: 'assistant',
      text: 'x',
      charts: [wire, wire, wire, { card_id: 'one', points: [{ date: '2026-10-01', usd: 1 }] }],
    });
    expect(parsed?.charts).toHaveLength(2);
    expect(parsed?.charts?.[0]).toMatchObject({
      cardId: 'xyp-111',
      range: '1y',
      points: [{ date: '2026-10-01', usd: 29 }, { date: '2026-10-02', usd: 30 }],
    });
    expect(parseAssistantMessage({ id: 'u', role: 'user', text: 'q', charts: [wire] })?.charts).toEqual([]);
    expect(parseAssistantMessage({ id: 'old', role: 'assistant', text: 'q' })?.charts).toEqual([]);
  });
});

describe('assistant card tile image fallback', () => {
  it('shows the standard CARD placeholder when the image fails to load', () => {
    const card = { ...mockAssistantCards.celebi, name: 'Celebi ☆', language: 'ja' };
    renderWithProviders(<AssistantCardTile card={card} onPress={jest.fn()} testID="tile" />);
    expect(screen.queryByTestId('tile-placeholder')).toBeNull();
    fireEvent(screen.getByTestId('tile-image'), 'error', { error: 'load failed' });
    expect(screen.queryByTestId('tile-image')).toBeNull();
    expect(screen.getByTestId('tile-placeholder')).toHaveTextContent('CARD');
  });

  it('shows the placeholder when there is no image url', () => {
    renderWithProviders(
      <AssistantCardTile card={{ ...mockAssistantCards.treecko, imageSmallUrl: null }} onPress={jest.fn()} testID="tile" />,
    );
    expect(screen.getByTestId('tile-placeholder')).toHaveTextContent('CARD');
  });
});
