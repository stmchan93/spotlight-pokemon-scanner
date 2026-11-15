import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';

import type { NewsItem } from '@spotlight/api-client';

import { NewsArticleRow } from '@/features/social/components/news-article-row';
import { fetchNewsThreads } from '@/features/social/news-thread-service';
import { NewsPage } from '@/features/social/screens/news-page';
import { fetchLikedPostIds, likePost, repostPost } from '@/features/social/social-service';

import { MockSpotlightRepository, type SpotlightRepository } from '../../mock-api-client';
import { renderWithProviders } from '../../test-utils';

jest.mock('@/features/social/social-service', () => ({
  fetchLikedPostIds: jest.fn(async () => new Set()),
  fetchRepostedPostIds: jest.fn(async () => new Set()),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  repostPost: jest.fn(async () => true),
  unrepostPost: jest.fn(async () => true),
  fetchComments: jest.fn(async () => []),
  fetchLikedCommentIds: jest.fn(async () => new Set()),
  addComment: jest.fn(async () => ({ ok: false, reason: 'nope' })),
}));
jest.mock('@/features/social/news-thread-service', () => ({
  fetchNewsThreads: jest.fn(async () => new Map()),
}));
jest.mock('@/features/social/dm-service', () => ({
  fetchConversations: jest.fn(async () => []),
  findOrCreateDm: jest.fn(async () => 'conv-new'),
  sendMessage: jest.fn(async () => ({ id: 'm-1' })),
}));
jest.mock('@/features/profile/profile-service', () => ({
  searchUsers: jest.fn(async () => []),
}));
jest.mock('@/features/meta-feed/screens/components/open-link-out', () => ({
  openLinkOut: jest.fn(async () => undefined),
}));
jest.mock('@/features/meta-feed/meta-analytics', () => ({
  trackNewsItemOpened: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/features/social/screens/new-post-screen', () => ({
  signalFeedNeedsRefresh: jest.fn(),
}));

const repo = (overrides: Partial<SpotlightRepository>) =>
  Object.assign(new MockSpotlightRepository(), overrides) as SpotlightRepository;

const article = (overrides: Partial<NewsItem> = {}): NewsItem => ({
  id: 'n1',
  kind: 'news',
  source: 'Polygon',
  title: 'A headline',
  url: 'https://news.test/a',
  imageUrl: 'https://img.test/a.jpg',
  publishedAt: '2026-11-09T00:00:00Z',
  game: 'pokemon',
  setId: null,
  cardIds: [],
  tags: [],
  video: null,
  ...overrides,
});

const pageProps = {
  contentContainerStyle: { minHeight: 800, paddingTop: 100 },
  onScroll: jest.fn(),
  progressViewOffset: 100,
  scrollEventThrottle: 16,
  scrollToOverflowEnabled: true,
};

describe('NewsArticleRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the thread on the first like, then likes it', async () => {
    const ensureNewsThread = jest.fn(async () => 'post-1');
    renderWithProviders(<NewsArticleRow item={article()} testID="row" />, {
      spotlightRepository: repo({ ensureNewsThread }),
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('row-like-button'));
    });

    expect(ensureNewsThread).toHaveBeenCalledWith('n1');
    expect(likePost).toHaveBeenCalledWith('post-1');
    expect(screen.getByTestId('row-like-count').props.children).toBe(1);
  });

  it('rolls the like back and says so when the thread cannot open', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    renderWithProviders(<NewsArticleRow item={article()} testID="row" />, {
      spotlightRepository: repo({ ensureNewsThread: jest.fn(async () => null) }),
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('row-like-button'));
    });

    expect(likePost).not.toHaveBeenCalled();
    expect(screen.getByTestId('row-like-count').props.children).toBe(0);
    expect(alert).toHaveBeenCalled();
    alert.mockRestore();
  });

  it('reuses an existing thread instead of asking the backend again', async () => {
    const ensureNewsThread = jest.fn(async () => 'other');
    renderWithProviders(
      <NewsArticleRow
        item={article()}
        testID="row"
        thread={{ postId: 'post-9', likeCount: 3, commentCount: 1, repostCount: 2 }}
      />,
      { spotlightRepository: repo({ ensureNewsThread }) },
    );

    expect(screen.getByTestId('row-repost-count').props.children).toBe(2);
    await act(async () => {
      fireEvent.press(screen.getByTestId('row-repost-button'));
    });

    expect(ensureNewsThread).not.toHaveBeenCalled();
    expect(repostPost).toHaveBeenCalledWith('post-9');
  });

  it('shows a play badge on videos and no image frame without an image', () => {
    renderWithProviders(
      <>
        <NewsArticleRow item={article({ id: 'v', kind: 'video' })} testID="video" />
        <NewsArticleRow item={article({ id: 't', imageUrl: null })} testID="text" />
      </>,
    );

    expect(screen.getByTestId('video-play')).toBeTruthy();
    expect(screen.queryByTestId('text-image')).toBeNull();
  });
});

describe('NewsPage', () => {
  const feed = { items: [article(), article({ id: 'n2', title: 'Second' })], nextCursor: null };

  beforeEach(() => {
    jest.clearAllMocks();
    (fetchNewsThreads as jest.Mock).mockResolvedValue(new Map());
  });

  it('leads with the first story and filters by game', async () => {
    const fetchNewsFeed = jest.fn(async () => feed);
    renderWithProviders(<NewsPage page={pageProps} />, { spotlightRepository: repo({ fetchNewsFeed }) });

    await waitFor(() => expect(screen.getByTestId('news-page-article-n1-title')).toBeTruthy());
    expect(screen.getByTestId('news-page-article-n2-title')).toBeTruthy();
    expect(fetchNewsThreads).toHaveBeenCalledWith(['n1', 'n2']);

    await act(async () => {
      fireEvent.press(screen.getByTestId('news-page-chips-onepiece'));
    });
    await waitFor(() =>
      expect(fetchNewsFeed).toHaveBeenCalledWith(expect.objectContaining({ game: 'onepiece' })),
    );
  });

  it('draws a uniform square thumbnail beside a title of up to 5 lines', async () => {
    renderWithProviders(<NewsPage page={pageProps} />, {
      spotlightRepository: repo({ fetchNewsFeed: jest.fn(async () => feed) }),
    });

    const title = await screen.findByTestId('news-page-article-n2-title');
    expect(title.props.numberOfLines).toBe(5);
    expect(StyleSheet.flatten(screen.getByTestId('news-page-article-n2-thumbnail').props.style)).toMatchObject({
      borderRadius: 8,
      height: 80,
      width: 80,
    });
  });

  it('seeds counts and liked state from one batched read', async () => {
    (fetchNewsThreads as jest.Mock).mockResolvedValue(
      new Map([['n1', { postId: 'p1', likeCount: 4, commentCount: 2, repostCount: 1 }]]),
    );
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set(['p1']));
    renderWithProviders(<NewsPage page={pageProps} />, {
      spotlightRepository: repo({ fetchNewsFeed: jest.fn(async () => feed) }),
    });

    await waitFor(() =>
      expect(screen.getByTestId('news-page-article-n1-like-count').props.children).toBe(4),
    );
    expect(fetchLikedPostIds).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('news-page-article-n1-like-icon').props.fill).not.toBe('none');
  });
});
