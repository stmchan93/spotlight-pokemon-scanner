import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { PostCard } from '@/features/social/components/post-card';
import {
  addComment,
  fetchComments,
  fetchLikedPostIds,
  type FeedPost,
  likePost,
  unlikePost,
} from '@/features/social/social-service';

jest.mock('@/features/social/social-service', () => ({
  fetchLikedPostIds: jest.fn(async () => new Set()),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  fetchComments: jest.fn(async () => []),
  addComment: jest.fn(async () => null),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
}));

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function Wrapper({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>{children}</SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

function buildPost(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    id: 'post-1',
    authorId: 'author-1',
    author: { displayName: 'Ash Ketchum', handle: 'ash', avatarUrl: null, isVerified: false },
    body: 'Nice pull today',
    cardId: null,
    likeCount: 2,
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    media: [],
    ...overrides,
  };
}

async function renderCard(post: FeedPost = buildPost()) {
  render(<PostCard post={post} />, { wrapper: Wrapper });
  // Flush the on-mount liked-state read so later state updates are settled.
  await waitFor(() => expect(fetchLikedPostIds as jest.Mock).toHaveBeenCalledWith([post.id]));
}

const likeCountText = () => screen.getByTestId('post-card-like-count').props.children;
// The thumbs-up has no solid variant; it tints to the accent color when liked.
// (gray700 unliked, purple500 liked — see PostCard's `likeColor`.)
const likeIconColor = () => screen.getByTestId('post-card-like-icon').props.color;
const ACCENT = '#A54BFA';
const GRAY700 = '#4A4A4A';

describe('PostCard likes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
    (likePost as jest.Mock).mockResolvedValue(true);
    (unlikePost as jest.Mock).mockResolvedValue(true);
  });

  it('optimistically tints the thumbs-up + bumps the count, then rolls both back when the write fails', async () => {
    (likePost as jest.Mock).mockResolvedValue(false);
    await renderCard();

    // Seeded unliked: gray thumbs-up, count = 2.
    expect(likeCountText()).toBe(2);
    expect(likeIconColor()).toBe(GRAY700);

    fireEvent.press(screen.getByTestId('post-card-like-button'));

    // Optimistic: accent-tinted thumbs-up + count bumped BEFORE the write resolves.
    expect(likeCountText()).toBe(3);
    expect(likeIconColor()).toBe(ACCENT);

    // The write returned false → both the tint and the count roll back.
    await waitFor(() => expect(likeCountText()).toBe(2));
    expect(likeIconColor()).toBe(GRAY700);
    expect(likePost as jest.Mock).toHaveBeenCalledWith('post-1');
  });

  it('keeps the optimistic like when the write succeeds', async () => {
    await renderCard();

    fireEvent.press(screen.getByTestId('post-card-like-button'));
    expect(likeCountText()).toBe(3);

    await waitFor(() => expect(likePost as jest.Mock).toHaveBeenCalledWith('post-1'));
    // Success → no rollback: stays liked at 3, thumbs-up stays accent-tinted.
    expect(likeCountText()).toBe(3);
    expect(likeIconColor()).toBe(ACCENT);
  });
});

describe('PostCard comments sheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (addComment as jest.Mock).mockResolvedValue(null);
  });

  it('loads and shows comments when the comment button is pressed', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      {
        id: 'c1',
        postId: 'post-1',
        authorId: 'a1',
        author: { displayName: 'Misty', handle: 'misty', avatarUrl: null, isVerified: false },
        body: 'Great card!',
        parentCommentId: null,
        likeCount: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    await renderCard();

    fireEvent.press(screen.getByTestId('post-card-comment-button'));

    expect(await screen.findByText('Great card!')).toBeTruthy();
    expect(fetchComments as jest.Mock).toHaveBeenCalledWith('post-1');
  });

  it('shows the empty state when there are no comments', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([]);
    await renderCard();

    fireEvent.press(screen.getByTestId('post-card-comment-button'));

    expect(await screen.findByTestId('post-card-comments-empty')).toBeTruthy();
    expect(screen.getByText('Be the first to comment')).toBeTruthy();
  });

  it('optimistically appends a new comment and bumps the card count', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (addComment as jest.Mock).mockResolvedValue('c-new');
    await renderCard();

    expect(screen.getByTestId('post-card-comment-count').props.children).toBe(0);

    fireEvent.press(screen.getByTestId('post-card-comment-button'));
    await screen.findByTestId('post-card-comments-empty');

    fireEvent.changeText(screen.getByTestId('post-card-comments-input'), 'My first comment');
    fireEvent.press(screen.getByTestId('post-card-comments-send'));

    expect(await screen.findByText('My first comment')).toBeTruthy();
    expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'My first comment', null);
    // The card's comment count folds in the optimistic append.
    await waitFor(() =>
      expect(screen.getByTestId('post-card-comment-count').props.children).toBe(1),
    );
  });
});
