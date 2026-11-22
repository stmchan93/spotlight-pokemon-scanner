import { fireEvent, screen } from '@testing-library/react-native';

import {
  mockAssistantCards,
  mockAssistantPriceChart,
  mockAssistantSlabCards,
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

  it('a one-card chart answer puts the card art in the chart header instead of a lone tile', () => {
    renderBubble(reply({ cards: [mockAssistantCards.celebi], charts: [mockAssistantPriceChart()] }));
    expect(screen.getByTestId('assistant-message-a1-chart-0-thumb-image')).toBeTruthy();
    expect(screen.queryByTestId('assistant-card-xyp-111')).toBeNull();
  });

  it('a multi-card answer with a chart draws every card as a compact row, no big chart', () => {
    // Owner 2026-11-21: one big Pikachu chart + plain Pikachu/Espeon tiles for "3 undervalued cards".
    const spark = (changePct: number) => ({ range: '30d' as const, points: [40, 30, 20], changePct });
    const cards = [
      { ...mockAssistantCards.celebi, sparkline: spark(-48.1) },
      { ...mockAssistantCards.oshawott, sparkline: spark(12.5) },
      { ...mockAssistantCards.treecko, sparkline: null },
    ];
    const { onOpenCard } = renderBubble(reply({ cards, charts: [mockAssistantPriceChart()] }));
    expect(screen.queryByTestId('assistant-message-a1-chart-0')).toBeNull();
    expect(screen.queryByTestId('assistant-message-a1-cards')).toBeNull();
    expect(screen.getByTestId('assistant-message-a1-rows')).toBeTruthy();
    for (const card of cards) {
      expect(screen.getByTestId(`assistant-card-${card.cardId}`)).toBeTruthy();
    }
    expect(screen.getByTestId('assistant-card-xyp-111-sparkline')).toBeTruthy();
    expect(screen.getByTestId('assistant-card-xyp-111-change')).toHaveTextContent('-48.10%');
    expect(screen.getByTestId('assistant-card-mcdonalds25-21-change')).toHaveTextContent('+12.50%');
    expect(screen.getByTestId('assistant-card-xyp-111-period')).toHaveTextContent('Past month');
    expect(screen.queryByTestId('assistant-card-sm7-1-sparkline')).toBeNull();
    fireEvent.press(screen.getByTestId('assistant-card-mcdonalds25-21'));
    expect(onOpenCard).toHaveBeenCalledWith('mcdonalds25-21');
  });

  it('a multi-card near-lows answer without a chart also uses rows', () => {
    const sparkline = { range: '1y' as const, points: [40, 30, 12], changePct: -70 };
    renderBubble(reply({ cards: [{ ...mockAssistantCards.celebi, sparkline }, { ...mockAssistantCards.oshawott, sparkline }] }));
    expect(screen.getByTestId('assistant-message-a1-rows')).toBeTruthy();
    expect(screen.getByTestId('assistant-card-xyp-111-price')).toHaveTextContent('$37.54');
  });

  it('a single-card chart answer keeps the big chart, not a row', () => {
    const sparkline = { range: '90d' as const, points: [30, 37.54], changePct: 21.1 };
    renderBubble(reply({ cards: [{ ...mockAssistantCards.celebi, sparkline }], charts: [mockAssistantPriceChart()] }));
    expect(screen.getByTestId('assistant-message-a1-chart-0-chart')).toBeTruthy();
    expect(screen.queryByTestId('assistant-message-a1-rows')).toBeNull();
  });

  it('multi-card answers without prices keep the tile rail', () => {
    renderBubble(reply({ cards: [mockAssistantCards.celebi, mockAssistantCards.oshawott] }));
    expect(screen.getByTestId('assistant-message-a1-cards')).toBeTruthy();
    expect(screen.queryByTestId('assistant-message-a1-rows')).toBeNull();
  });

  it('a card younger than the range fills the chart from its first price', () => {
    const chart = {
      ...mockAssistantPriceChart(),
      range: '1y' as const,
      points: [
        { date: '2026-10-07', usd: 400 },
        { date: '2026-10-20', usd: 120 },
        { date: '2026-11-20', usd: 20.76 },
      ],
    };
    const model = buildAssistantChartModel(chart);
    expect(model?.windowStartMs).toBe(model?.points[0]?.t);
    expect(assistantChartSeriesLabel(chart)).toBe('NM · Since Oct 7');
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
    expect(assistantChartSeriesLabel(chart)).toBe('PSA 10 · Since Mar 6');
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

describe('assistant tile section: label, sparkline, View all', () => {
  function renderWithWatchlist(message: AssistantMessage, onOpenWatchlist?: () => void) {
    renderWithProviders(
      <AssistantMessageBubble
        actionStates={{}}
        message={message}
        onConfirmAction={jest.fn()}
        onDismissAction={jest.fn()}
        onOpenCard={jest.fn()}
        onOpenWatchlist={onOpenWatchlist}
      />,
    );
  }

  it('renders the label as a header above the tiles', () => {
    renderBubble(reply({ cards: [mockAssistantCards.celebi], cardsLabel: 'Top holdings by value' }));
    expect(screen.getByTestId('assistant-message-a1-cards-label-title')).toHaveTextContent('Top holdings by value');
    expect(screen.queryByTestId('assistant-message-a1-cards-view-all')).toBeNull();
  });

  it('shows no header without a label, or without tiles', () => {
    renderBubble(reply({ cards: [mockAssistantCards.celebi] }));
    expect(screen.queryByTestId('assistant-message-a1-cards-label')).toBeNull();
    renderBubble(reply({ id: 'a2', cards: [], cardsLabel: 'Orphan label' }));
    expect(screen.queryByText('Orphan label')).toBeNull();
  });

  it('links "View all N" to the Watchlist', () => {
    const onOpenWatchlist = jest.fn();
    renderWithWatchlist(
      reply({ cards: [mockAssistantCards.celebi], cardsViewAll: { screen: 'watchlist', total: 17 } }),
      onOpenWatchlist,
    );
    expect(screen.getByTestId('assistant-message-a1-cards-label-title')).toHaveTextContent('Your Watchlist');
    expect(screen.getByText('View all 17')).toBeTruthy();
    fireEvent.press(screen.getByTestId('assistant-message-a1-cards-view-all'));
    expect(onOpenWatchlist).toHaveBeenCalledTimes(1);
  });

  it('hides View all when the screen has no Watchlist route', () => {
    renderWithWatchlist(reply({ cards: [mockAssistantCards.celebi], cardsViewAll: { screen: 'watchlist', total: 17 } }));
    expect(screen.queryByTestId('assistant-message-a1-cards-view-all')).toBeNull();
  });

  it('draws a sparkline with its period on near-low tiles only', () => {
    const card = { ...mockAssistantCards.celebi, sparkline: { range: '1y' as const, points: [40, 30, 12], changePct: -70 } };
    renderWithProviders(<AssistantCardTile card={card} onPress={jest.fn()} testID="tile" />);
    expect(screen.getByTestId('tile-sparkline')).toBeTruthy();
    expect(screen.getByTestId('tile-sparkline-period')).toHaveTextContent('Past year');
    renderWithProviders(<AssistantCardTile card={mockAssistantCards.treecko} onPress={jest.fn()} testID="plain" />);
    expect(screen.queryByTestId('plain-sparkline')).toBeNull();
  });

  it('parses cards_label, cards_view_all and tile sparklines', () => {
    const parsed = parseAssistantMessage({
      id: 'm',
      role: 'assistant',
      text: 'x',
      cards_label: " Chase cards you're missing ",
      cards_view_all: { screen: 'watchlist', total: 17 },
      cards: [
        { card_id: 'a', name: 'A', sparkline: { range: '90d', points: [3, 'x', 2, 1], change_pct: -66.7 } },
        { card_id: 'b', name: 'B', sparkline: { range: '1y', points: [1] } },
      ],
    });
    expect(parsed?.cardsLabel).toBe("Chase cards you're missing");
    expect(parsed?.cardsViewAll).toEqual({ screen: 'watchlist', total: 17 });
    expect(parsed?.cards[0].sparkline).toEqual({ range: '90d', points: [3, 2, 1], changePct: -66.7 });
    expect(parsed?.cards[1].sparkline).toBeNull();
    const old = parseAssistantMessage({ id: 'o', role: 'assistant', text: 'x', cards_view_all: { screen: 'feed', total: 3 } });
    expect(old?.cardsLabel).toBeNull();
    expect(old?.cardsViewAll).toBeNull();
  });
});

describe('assistant slab tiles', () => {
  it('a raw copy and its CGC slab are separate tiles; only the slab sits in the slab frame', () => {
    renderBubble(reply({ cards: [mockAssistantCards.celebi, mockAssistantSlabCards.cgc] }));
    const tiles = screen.getAllByTestId('assistant-card-xyp-111');
    expect(tiles).toHaveLength(2);
    // One slab frame (the CGC photo template), and both card images still render.
    expect(screen.getAllByTestId('assistant-card-xyp-111-slab-frame')).toHaveLength(1);
    expect(screen.getByTestId('assistant-card-xyp-111-slab-frame-template')).toBeTruthy();
    expect(screen.getByTestId('assistant-card-xyp-111-slab-frame-grade')).toHaveTextContent('9.5');
    expect(screen.getAllByTestId('assistant-card-xyp-111-image')).toHaveLength(2);
    expect(screen.getByText(/CGC 9\.5/)).toBeTruthy();
  });

  it('a grader without a photo template falls back to the vector slab frame', () => {
    renderBubble(reply({ cards: [mockAssistantSlabCards.sgc] }));
    expect(screen.getByTestId('assistant-card-xyp-111-slab-frame-label')).toBeTruthy();
    expect(screen.queryByTestId('assistant-card-xyp-111-slab-frame-template')).toBeNull();
    expect(screen.getByTestId('assistant-card-xyp-111-slab-frame-grade')).toHaveTextContent('10');
  });

  it('compact price rows frame slab thumbnails too', () => {
    const spark = { range: '30d' as const, changePct: 4, points: [1, 2] };
    renderBubble(reply({
      cards: [
        { ...mockAssistantCards.celebi, sparkline: spark },
        { ...mockAssistantSlabCards.psa, sparkline: spark },
      ],
    }));
    expect(screen.getAllByTestId('assistant-card-xyp-111-slab-frame')).toHaveLength(1);
  });

  it('a graded chart frames the header art, and a raw chart does not hide the slab tile', () => {
    const graded: AssistantPriceChart = { ...mockAssistantPriceChart(), condition: null, grader: 'CGC', grade: '9.5' };
    renderBubble(reply({ cards: [mockAssistantSlabCards.cgc], charts: [graded] }));
    expect(screen.getByTestId('assistant-message-a1-chart-0-thumb-slab-frame')).toBeTruthy();
    expect(screen.queryByTestId('assistant-card-xyp-111')).toBeNull();
    screen.unmount();

    renderBubble(reply({ cards: [mockAssistantCards.celebi, mockAssistantSlabCards.cgc], charts: [mockAssistantPriceChart()] }));
    expect(screen.queryByTestId('assistant-message-a1-chart-0-thumb-slab-frame')).toBeNull();
    expect(screen.getAllByTestId('assistant-card-xyp-111')).toHaveLength(2);
  });
});
