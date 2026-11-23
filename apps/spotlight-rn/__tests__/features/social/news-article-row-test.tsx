import { act, fireEvent, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';

import type { NewsItem } from '@spotlight/api-client';

import { NewsArticleRow } from '@/features/social/components/news-article-row';
import { likePost, repostPost } from '@/features/social/social-service';

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
