import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { NewsFeed, NewsFeedQuery, NewsItem } from '@spotlight/api-client';
import {
  NEWS_FOOTER_COPY,
  NEWS_PAGE_SIZE,
  NewsScreen,
  newsCardChips,
  newsCollectionGames,
  splitLead,
} from '@/features/meta-feed/screens/news-screen';

import { mockNewsFeed, mockNewsItems } from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

const mockOpenBrowserAsync = jest.fn(async () => ({ type: 'opened' }));

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(async () => ({ type: 'cancel' })),
  openBrowserAsync: (...args: unknown[]) => mockOpenBrowserAsync(...(args as [])),
}));

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

type FetchNews = (query?: NewsFeedQuery) => Promise<NewsFeed | null>;

function renderNews(fetchNewsFeed: FetchNews) {
  const onBack = jest.fn();
  const onOpenCard = jest.fn();
  renderWithProviders(<NewsScreen onBack={onBack} onOpenCard={onOpenCard} />, {
    spotlightRepository: createTestSpotlightRepository({ fetchNewsFeed }),
  });
  return { onBack, onOpenCard };
}

const [leadItem, secondItem, marketItem] = mockNewsItems;

describe('NewsScreen', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockOpenBrowserAsync.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows a skeleton while the first page loads', () => {
    renderNews(() => new Promise(() => {}));
    expect(screen.getByTestId('news-loading')).toBeTruthy();
    expect(screen.getByText('News & videos')).toBeTruthy();
  });

  it('leads with the first story that has an image, then rows, then the footer', async () => {
    renderNews(async () => mockNewsFeed);

    expect(await screen.findByTestId('news-lead')).toBeTruthy();
    expect(screen.getByText(leadItem.title)).toBeTruthy();
    expect(screen.getByTestId(`news-item-${secondItem.id}`)).toBeTruthy();
    expect(screen.getByTestId(`news-item-${marketItem.id}`)).toBeTruthy();
    expect(screen.getByText(NEWS_FOOTER_COPY)).toBeTruthy();

    fireEvent.press(screen.getByTestId(`news-item-${leadItem.id}`));
    await waitFor(() => expect(mockOpenBrowserAsync).toHaveBeenCalledWith(leadItem.url));
  });

  it('refetches when a kind chip is picked', async () => {
    const fetchNewsFeed = jest.fn<Promise<NewsFeed | null>, [NewsFeedQuery?]>(async () => mockNewsFeed);
    renderNews(fetchNewsFeed);
    await screen.findByTestId('news-lead');
    expect(fetchNewsFeed).toHaveBeenLastCalledWith({ game: null, kind: null, limit: NEWS_PAGE_SIZE });

    fireEvent.press(screen.getByTestId('news-kind-video'));
    await waitFor(() =>
      expect(fetchNewsFeed).toHaveBeenLastCalledWith({ game: null, kind: 'video', limit: NEWS_PAGE_SIZE }),
    );
    expect(screen.getByTestId('news-kind-video').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
  });

  it('loads the next page from nextCursor at the end of the list', async () => {
    const pageTwoItem: NewsItem = { ...marketItem, id: 'page-2-item', title: 'Older market story' };
    const fetchNewsFeed = jest.fn<Promise<NewsFeed | null>, [NewsFeedQuery?]>(async (query) =>
      query?.cursor === 'c2'
        ? { items: [pageTwoItem], nextCursor: null }
        : { items: mockNewsItems, nextCursor: 'c2' },
    );
    renderNews(fetchNewsFeed);
    await screen.findByTestId('news-lead');

    fireEvent(screen.getByTestId('news-list'), 'onEndReached');
    await waitFor(() =>
      expect(fetchNewsFeed).toHaveBeenLastCalledWith({ cursor: 'c2', game: null, kind: null, limit: NEWS_PAGE_SIZE }),
    );
    expect(await screen.findByText('Older market story')).toBeTruthy();

    // No cursor left → no further page request.
    const calls = fetchNewsFeed.mock.calls.length;
    fireEvent(screen.getByTestId('news-list'), 'onEndReached');
    expect(fetchNewsFeed).toHaveBeenCalledTimes(calls);
  });

  it('shows card chips for tagged cards and opens the card', async () => {
    const { onOpenCard } = renderNews(async () => ({
      items: [leadItem, { ...marketItem, cardIds: ['ecard3-149'] }],
      nextCursor: null,
    }));
    fireEvent.press(await screen.findByTestId(`news-cards-${marketItem.id}-ecard3-149`));
    expect(onOpenCard).toHaveBeenCalledWith('ecard3-149');
    expect(screen.getByText('1 tagged card')).toBeTruthy();
  });

  it('shows an empty state when there are no stories', async () => {
    renderNews(async () => ({ items: [], nextCursor: null }));
    expect(await screen.findByTestId('news-empty')).toBeTruthy();
    expect(screen.queryByText(NEWS_FOOTER_COPY)).toBeNull();
  });

  it('shows a retryable error', async () => {
    const fetchNewsFeed = jest
      .fn<Promise<NewsFeed | null>, [NewsFeedQuery?]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(mockNewsFeed);
    renderNews(fetchNewsFeed);
    fireEvent.press(await screen.findByTestId('news-retry'));
    expect(await screen.findByTestId('news-lead')).toBeTruthy();
  });

  it('says coming soon when the feature flag is off', async () => {
    renderNews(async () => null);
    expect(await screen.findByTestId('news-disabled')).toBeTruthy();
  });
});

describe('news helpers', () => {
  it('names owned cards and folds the rest into a count', () => {
    const owned = new Map([['a', 'Lugia (Crystal)']]);
    expect(newsCardChips(['a', 'b', 'c'], owned)).toEqual([
      { cardId: 'a', label: 'Lugia (Crystal)' },
      { cardId: 'b', label: '+2 more' },
    ]);
    expect(newsCardChips([], owned)).toEqual([]);
  });

  it('never leads with a video', () => {
    const video = mockNewsItems.find((item) => item.kind === 'video') as NewsItem;
    expect(splitLead([{ ...video, imageUrl: 'https://x.test/v.jpg' }, leadItem]).lead?.id).toBe(leadItem.id);
    expect(splitLead([marketItem]).lead).toBeNull();
  });

  it('lists collection games in catalog order, defaulting to Pokémon', () => {
    expect(newsCollectionGames(null)).toEqual([]);
    expect(
      newsCollectionGames([
        { game: 'onepiece' } as never,
        { game: undefined } as never,
      ]),
    ).toEqual(['pokemon', 'onepiece']);
  });
});
