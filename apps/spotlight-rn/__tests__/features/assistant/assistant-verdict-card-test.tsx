import { fireEvent, screen } from '@testing-library/react-native';

import {
  mockInventoryEntries,
  parseAssistantAction,
  parseAssistantMessage,
  type AssistantMessage,
  type AssistantProposedAction,
} from '@spotlight/api-client';

import { runAssistantAction, type AssistantActionDeps } from '@/features/assistant/assistant-action-runner';
import { AssistantActionCard } from '@/features/assistant/components/assistant-action-card';
import { AssistantMessageBubble } from '@/features/assistant/components/assistant-message-bubble';
import { createWatchlistStore } from '@/features/wishlist/watchlist-store';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

const dealWire = {
  kind: 'deal',
  verdict: 'fair',
  label: 'Fair price',
  side: 'buying',
  asking_usd: 250,
  market_usd: 287.93,
  pct_of_market: 86.8,
  diff_usd: -37.93,
  items: [{
    card_id: 'sv3pt5-199', name: 'Charizard ex', set: '151', number: '199/165', image_small_url: null,
    condition: 'NM', condition_assumed: true, quantity: 1, price_usd: 287.93, market_total_usd: 287.93,
    asking_usd: 250, pct_of_market: 86.8, change_30d_pct: -6.1, solds: null,
  }],
  unpriced_count: 0,
};

const tradeWire = {
  kind: 'trade',
  verdict: 'uneven',
  label: 'Uneven',
  side_a: { label: 'You give', total_usd: 100, unpriced_count: 0, items: [{ card_id: 'a', name: 'Kyogre-EX', quantity: 1 }] },
  side_b: { label: 'You get', total_usd: 130, unpriced_count: 0, items: [{ card_id: 'b', name: 'Lugia', quantity: 2 }] },
  gap_usd: 30,
  gap_pct: 23.1,
  favors: 'you',
  balance: { who_adds: 'you', cash_usd: 30 },
};

const gradingWire = {
  kind: 'grading',
  cards: [{
    card_id: 'bw5-104', name: 'Kyogre-EX', set: 'Dark Explorers', number: '104/108', raw_price_usd: 504.48,
    recommendation: 'grade_if_confident_10', break_even: { PSA: '10' },
    scenarios: [
      { grader: 'PSA', grade: '10', comp_price_usd: 1450, fee_usd: 79.99, shipping_usd: 19.99, net_usd: 845.54 },
      { grader: 'PSA', grade: '9', comp_price_usd: 520, fee_usd: 59.99, shipping_usd: 19.99, net_usd: -64.46 },
      { grader: 'PSA', grade: '8', comp_price_usd: null, fee_usd: 59.99, shipping_usd: 19.99, net_usd: null },
    ],
  }],
  fees: { as_of: '2026-11-21', placeholder: false, shipping_usd: 20 },
};

function reply(verdicts: unknown[]): AssistantMessage {
  const parsed = parseAssistantMessage({
    id: 'a1', thread_id: 't', role: 'assistant', text: '**Fair.**', cards: [], actions: [], created_at: 'x',
    status: 'ok', verdicts,
  });
  if (!parsed) {
    throw new Error('unparsed');
  }
  return parsed;
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
  return onOpenCard;
}

describe('verdict wire', () => {
  it('parses deal, trade and grading cards and drops unknown kinds', () => {
    const message = reply([dealWire, tradeWire, { kind: 'future_thing' }]);
    expect(message.verdicts?.map((verdict) => verdict.kind)).toEqual(['deal', 'trade']);
    const deal = message.verdicts?.[0];
    expect(deal?.kind === 'deal' && deal.items[0].conditionAssumed).toBe(true);
    expect(reply([]).verdicts).toEqual([]);
  });

  it('parses the new collection actions', () => {
    expect(parseAssistantAction({
      id: 'r', type: 'remove_holding', summary: 'Remove 1 of 2', params: {
        holding_id: 'h1', card_id: 'c', quantity: 1, remove_all: false, remaining_quantity: 1,
      },
    })?.type).toBe('remove_holding');
    expect(parseAssistantAction({ id: 'm', type: 'move_holding', params: { holding_id: 'h1' } })).toBeNull();
    expect(parseAssistantAction({
      id: 'c', type: 'create_collection', params: { name: 'Show stock', holding_ids: ['h1'] },
    })).toMatchObject({ params: { name: 'Show stock', holdingIds: ['h1'] } });
  });
});

describe('AssistantVerdictCard', () => {
  it('shows the deal verdict, asking, market and % of market; a row opens the card', () => {
    const onOpenCard = renderBubble(reply([dealWire]));
    expect(screen.getByText('Fair price')).toBeTruthy();
    expect(screen.getByTestId('assistant-message-a1-verdict-0-asking')).toHaveTextContent('$250.00', { exact: false });
    expect(screen.getByTestId('assistant-message-a1-verdict-0-market')).toHaveTextContent('$287.93', { exact: false });
    expect(screen.getByTestId('assistant-message-a1-verdict-0-pct')).toHaveTextContent('87% of market', { exact: false });
    fireEvent.press(screen.getByTestId('assistant-message-a1-verdict-0-item-sv3pt5-199'));
    expect(onOpenCard).toHaveBeenCalledWith('sv3pt5-199');
  });

  it('shows both trade totals, the gap and the balancing fix', () => {
    renderBubble(reply([tradeWire]));
    expect(screen.getByTestId('assistant-message-a1-verdict-0-side-a-total')).toHaveTextContent('$100.00', { exact: false });
    expect(screen.getByTestId('assistant-message-a1-verdict-0-side-b-total')).toHaveTextContent('$130.00', { exact: false });
    expect(screen.getByTestId('assistant-message-a1-verdict-0-gap')).toHaveTextContent('Gap $30.00 (23%) · you get more', { exact: false });
    expect(screen.getByTestId('assistant-message-a1-verdict-0-balance')).toHaveTextContent('you add ~$30.00', { exact: false });
  });

  it('shows the grading scenario rows with signed nets', () => {
    renderBubble(reply([gradingWire]));
    expect(screen.getByText('Only for a 10')).toBeTruthy();
    expect(screen.getByTestId('assistant-message-a1-verdict-0-row-PSA-10')).toHaveTextContent('+$845.54', { exact: false });
    expect(screen.getByTestId('assistant-message-a1-verdict-0-row-PSA-9')).toHaveTextContent('-$64.46', { exact: false });
    expect(screen.getByTestId('assistant-message-a1-verdict-0-row-PSA-8')).toHaveTextContent('No recent sale', { exact: false });
    expect(screen.getByTestId('assistant-message-a1-verdict-0-fees')).toHaveTextContent('fees as of 2026-11-21', { exact: false });
  });
});

function deps(overrides: Parameters<typeof createTestSpotlightRepository>[0]): AssistantActionDeps {
  return {
    repository: createTestSpotlightRepository(overrides),
    activeCollectionID: 'all',
    inventoryEntriesCache: mockInventoryEntries,
    prependOptimisticInventoryEntry: jest.fn(),
    removeOptimisticInventoryEntries: jest.fn(),
    refreshData: jest.fn(),
    watchlistStore: createWatchlistStore(),
    cards: [],
  };
}

describe('collection actions', () => {
  const entry = mockInventoryEntries[0];

  it('a partial remove lowers the quantity; remove-all deletes the holding', async () => {
    const setPortfolioEntryQuantity = jest.fn(async () => ({ deckEntryID: entry.id, cardID: entry.cardId, quantity: 1, deleted: false }));
    const deletePortfolioEntry = jest.fn(async () => ({ deckEntryID: entry.id, cardID: entry.cardId }));
    const d = deps({ setPortfolioEntryQuantity, deletePortfolioEntry });
    const cache = [{ ...entry, quantity: 3 }];
    const partial: AssistantProposedAction = {
      id: 'r1', type: 'remove_holding', summary: 'Remove 2 of 3', state: 'proposed',
      params: { holdingId: entry.id, cardId: entry.cardId, quantity: 2, removeAll: false, remainingQuantity: 1 },
    };
    await expect(runAssistantAction(partial, { ...d, inventoryEntriesCache: cache })).resolves.toEqual({ status: 'done' });
    expect(setPortfolioEntryQuantity).toHaveBeenCalledWith({ deckEntryID: entry.id, quantity: 1 });
    await runAssistantAction(
      { ...partial, params: { ...partial.params, quantity: 3, removeAll: true, remainingQuantity: 0 } },
      { ...d, inventoryEntriesCache: cache },
    );
    expect(deletePortfolioEntry).toHaveBeenCalledWith({ deckEntryID: entry.id });
    expect(d.removeOptimisticInventoryEntries).toHaveBeenCalledWith([entry.id]);
  });

  it('create makes the collection, then moves the holdings into it', async () => {
    const createCollection = jest.fn(async (name: string) => ({
      id: 'col-new', name, sortOrder: 1, createdAt: '', cardCount: 0, totalValue: 0, isDefault: false, hidden: false,
    }));
    const movePortfolioEntry = jest.fn(async () => ({
      deckEntryID: 'h1', sourceDeckEntryID: 'h1', cardID: 'c', collectionID: 'col-new', movedQuantity: 1,
    }));
    const d = deps({ createCollection: createCollection as never, movePortfolioEntry });
    const outcome = await runAssistantAction(
      { id: 'c', type: 'create_collection', summary: '', state: 'proposed', params: { name: 'Show stock', holdingIds: ['h1'] } },
      d,
    );
    expect(outcome).toEqual({ status: 'done' });
    expect(movePortfolioEntry).toHaveBeenCalledWith({ deckEntryID: 'h1', collectionID: 'col-new', quantity: null });
  });

  it('a remove proposal renders as a red Remove card', () => {
    const action: AssistantProposedAction = {
      id: 'r2', type: 'remove_holding', summary: 'Remove 1 of 2 · Pikachu · NM', state: 'proposed',
      params: { holdingId: 'h', cardId: 'c', quantity: 1, removeAll: false, remainingQuantity: 1 },
    };
    renderWithProviders(
      <AssistantActionCard action={action} onConfirm={jest.fn()} onDismiss={jest.fn()} state={{ status: 'proposed' }} />,
    );
    expect(screen.getByText('Remove')).toBeTruthy();
  });
});
