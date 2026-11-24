import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import {
  AssistantRequestError,
  MockSpotlightRepository,
  type CardGame,
  type CatalogSearchResult,
  type SmartSearchRequest,
  type SmartSearchResult,
} from '@spotlight/api-client';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';

import { renderWithProviders } from '../test-utils';

/**
 * Natural-language search on the Search tab: sentence-like queries go to the
 * smart endpoint (chips + results), chip removal re-runs without the model,
 * questions get an Ask Ekalight row, and any failure falls back to normal search.
 */

const mockCapture = jest.fn();
jest.mock('@/lib/observability/posthog', () => ({
  ...jest.requireActual('@/lib/observability/posthog'),
  capturePostHogEvent: (...args: unknown[]) => mockCapture(...args),
}));

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useGlobalSearchParams: () => ({}),
    usePathname: () => '/search',
    useRouter: () => ({ back: jest.fn(), canGoBack: jest.fn(() => false), push: jest.fn(), replace: jest.fn() }),
  };
});

jest.mock('@/features/social/social-service', () => ({
  ...jest.requireActual('@/features/social/social-service'),
  fetchUnreadNotificationCount: jest.fn(() => Promise.resolve(0)),
}));

const WAIT = { timeout: 3000 };

function card(id: string, name: string, marketPrice = 10): CatalogSearchResult {
  return {
    cardId: id,
    cardNumber: '#1',
    currencyCode: 'USD',
    id,
    imageUrl: '',
    marketPrice,
    name,
    ownedQuantity: 0,
    setName: 'Prismatic Evolutions',
  };
}

const EEVEE_SEARCH: SmartSearchResult = {
  chips: [
    { field: 'text', id: 'text', label: 'Eevee' },
    { field: 'rarity_bucket', id: 'rarity_bucket', label: 'Alt art' },
    { field: 'price_max_usd', id: 'price_max_usd', label: 'Under $50' },
  ],
  intent: 'search',
  interpretation: {
    filter: { price_max_usd: 50, rarity_bucket: ['sir', 'illustration'], text: 'Eevee' },
    owned: 'any',
    sort: 'relevance',
  },
  nextCursor: null,
  results: [card('eevee-sir', 'Eevee ex')],
};

function mockCatalog(normalCards: CatalogSearchResult[] = []) {
  jest.spyOn(MockSpotlightRepository.prototype, 'getSetProgress').mockImplementation(async (game: CardGame) => ({ game, sets: [] }));
  jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockResolvedValue([]);
  jest.spyOn(MockSpotlightRepository.prototype, 'listCardsInExpansion').mockResolvedValue([]);
  return jest
    .spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
    .mockResolvedValue({ cards: normalCards, hasMore: false });
}

function mockSmart(impl: (request: SmartSearchRequest) => Promise<SmartSearchResult>) {
  return jest.spyOn(MockSpotlightRepository.prototype, 'smartSearchCatalog').mockImplementation(impl);
}

function renderSearch() {
  const onAskAssistant = jest.fn();
  const onOpenCard = jest.fn();
  renderWithProviders(
    <ExpansionBrowserScreen
      mode="tab"
      onAskAssistant={onAskAssistant}
      onClose={jest.fn()}
      onOpenCard={onOpenCard}
      onSelectExpansion={jest.fn()}
    />,
  );
  return { onAskAssistant, onOpenCard };
}

describe('Smart search', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockCapture.mockClear();
  });

  it('shows the example placeholder on CARDS', async () => {
    mockCatalog();
    renderSearch();
    const field = await screen.findByTestId('game-sets-search');
    expect(field.props.placeholder).toMatch(/^SEARCH CARDS, OR TRY "/);
  });

  it('a plain query never calls the smart endpoint', async () => {
    const searchPage = mockCatalog([card('char-199', 'Charizard ex')]);
    const smart = mockSmart(async () => EEVEE_SEARCH);
    renderSearch();
    fireEvent.changeText(await screen.findByTestId('game-sets-search'), 'charizard 199');
    expect(await screen.findByTestId('catalog-result-char-199')).toBeTruthy();
    expect(searchPage).toHaveBeenCalledWith('charizard 199', expect.any(Number), 0, expect.objectContaining({ game: 'pokemon' }));
    expect(smart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('game-sets-ask-ekalight')).toBeNull();
  });

  it('a natural query shows smart results with chips; removing a chip re-runs without the model', async () => {
    mockCatalog([card('noise', 'Unrelated')]);
    const smart = mockSmart(async (request) => (
      request.interpretation
        ? { ...EEVEE_SEARCH, chips: EEVEE_SEARCH.chips.filter((chip) => chip.id !== 'price_max_usd'),
          interpretation: request.interpretation, results: [card('eevee-pricey', 'Eevee ex', 120)] }
        : EEVEE_SEARCH
    ));
    renderSearch();
    fireEvent.changeText(await screen.findByTestId('game-sets-search'), 'eevee alt arts under $50');

    expect(await screen.findByTestId('catalog-result-eevee-sir', {}, WAIT)).toBeTruthy();
    expect(screen.queryByTestId('catalog-result-noise')).toBeNull();
    expect(smart).toHaveBeenCalledTimes(1);
    expect(smart.mock.calls[0][0]).toEqual({ game: 'pokemon', limit: 30, query: 'eevee alt arts under $50' });
    expect(screen.getByText('Under $50')).toBeTruthy();
    expect(screen.getByLabelText('Remove Alt art')).toBeTruthy();

    fireEvent.press(screen.getByTestId('game-sets-smart-chips-price_max_usd'));
    expect(await screen.findByTestId('catalog-result-eevee-pricey', {}, WAIT)).toBeTruthy();
    expect(smart).toHaveBeenCalledTimes(2);
    expect(smart.mock.calls[1][0]).toEqual({
      game: 'pokemon',
      interpretation: { filter: { rarity_bucket: ['sir', 'illustration'], text: 'Eevee' }, owned: 'any', sort: 'relevance' },
      limit: 30,
    });
    expect(screen.queryByTestId('game-sets-smart-chips-price_max_usd')).toBeNull();

    const events = mockCapture.mock.calls.filter(([name]) => name === 'smart_search_performed');
    expect(events[0][1]).toEqual(expect.objectContaining({ chip_count: 3, fell_back: false, intent: 'search', result_count: 1 }));
    // Never the query text.
    expect(JSON.stringify(events)).not.toContain('eevee');
  });

  it('falls back to the normal search when the smart endpoint fails', async () => {
    mockCatalog([card('eevee-plain', 'Eevee')]);
    mockSmart(async () => {
      throw new AssistantRequestError('not found', 'not_found', 404);
    });
    renderSearch();
    fireEvent.changeText(await screen.findByTestId('game-sets-search'), 'eevee alt arts under $50');
    expect(await screen.findByTestId('catalog-result-eevee-plain', {}, WAIT)).toBeTruthy();
    expect(screen.queryByTestId('game-sets-smart-chips')).toBeNull();
    expect(screen.queryByText('Search unavailable')).toBeNull();
    await waitFor(() => expect(mockCapture).toHaveBeenCalledWith(
      'smart_search_performed', expect.objectContaining({ fell_back: true, intent: 'error' }),
    ));
  });

  it('a question shows the Ask row above normal results and opens the chat with it', async () => {
    mockCatalog([card('umbreon-vmax', 'Umbreon VMAX')]);
    const smart = mockSmart(async () => EEVEE_SEARCH);
    const { onAskAssistant } = renderSearch();
    fireEvent.changeText(await screen.findByTestId('game-sets-search'), 'should I grade my umbreon?');

    const row = await screen.findByTestId('game-sets-ask-ekalight');
    expect(screen.getByLabelText('Ask Ekalight: should I grade my umbreon?')).toBeTruthy();
    expect(await screen.findByTestId('catalog-result-umbreon-vmax')).toBeTruthy();
    fireEvent.press(row);
    expect(onAskAssistant).toHaveBeenCalledWith('should I grade my umbreon?', 'pokemon');
    expect(smart).not.toHaveBeenCalled();
  });

  it('a natural query the server calls a question also gets the Ask row', async () => {
    mockCatalog([]);
    mockSmart(async () => ({ chips: [], intent: 'question', interpretation: null, nextCursor: null, results: [] }));
    renderSearch();
    fireEvent.changeText(await screen.findByTestId('game-sets-search'), 'my cards up this month');
    expect(await screen.findByTestId('game-sets-ask-ekalight', {}, WAIT)).toBeTruthy();
  });
});
