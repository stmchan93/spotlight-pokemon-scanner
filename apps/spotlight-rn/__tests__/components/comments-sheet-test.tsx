import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { CommentsSheet } from '@/features/social/components/comments-sheet';
import {
  addComment,
  fetchComments,
  likeComment,
  type PostComment,
  unlikeComment,
} from '@/features/social/social-service';

jest.mock('@/features/social/social-service', () => ({
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

function buildComment(overrides: Partial<PostComment> = {}): PostComment {
  return {
    id: 'c1',
    postId: 'post-1',
    authorId: 'a1',
    author: { displayName: 'Misty', handle: 'misty', avatarUrl: null, isVerified: false },
    body: 'Great card!',
    parentCommentId: null,
    likeCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderSheet() {
  return render(
    <CommentsSheet onClose={jest.fn()} postId="post-1" testID="comments-sheet" visible />,
    { wrapper: Wrapper },
  );
}

describe('CommentsSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (addComment as jest.Mock).mockResolvedValue(null);
    (likeComment as jest.Mock).mockResolvedValue(true);
    (unlikeComment as jest.Mock).mockResolvedValue(true);
  });

  it('loads and renders the thread', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([buildComment()]);
    renderSheet();

    expect(await screen.findByText('Great card!')).toBeTruthy();
    expect(screen.getByText('Misty')).toBeTruthy();
    expect(fetchComments as jest.Mock).toHaveBeenCalledWith('post-1');
  });

  it('shows the empty state when there are no comments', async () => {
    renderSheet();
    expect(await screen.findByTestId('comments-sheet-empty')).toBeTruthy();
    expect(screen.getByText('Be the first to comment')).toBeTruthy();
  });

  it('optimistically appends a new comment', async () => {
    (addComment as jest.Mock).mockResolvedValue('c-new');
    const onCommentAdded = jest.fn();
    render(
      <CommentsSheet
        onClose={jest.fn()}
        onCommentAdded={onCommentAdded}
        postId="post-1"
        testID="comments-sheet"
        visible
      />,
      { wrapper: Wrapper },
    );
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'My first comment');
    fireEvent.press(screen.getByTestId('comments-sheet-send'));

    expect(await screen.findByText('My first comment')).toBeTruthy();
    expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'My first comment', null);
    await waitFor(() => expect(onCommentAdded).toHaveBeenCalled());
  });

  it('optimistically toggles the comment like and count', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([buildComment({ likeCount: 5 })]);
    renderSheet();
    await screen.findByText('Great card!');

    expect(screen.getByText('5')).toBeTruthy();

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-like'));

    // Optimistic bump before the write resolves.
    expect(screen.getByText('6')).toBeTruthy();
    await waitFor(() => expect(likeComment as jest.Mock).toHaveBeenCalledWith('c1'));
    // Success → no rollback.
    expect(screen.getByText('6')).toBeTruthy();
  });

  it('rolls the like back when the write fails', async () => {
    (likeComment as jest.Mock).mockResolvedValue(false);
    (fetchComments as jest.Mock).mockResolvedValue([buildComment({ likeCount: 5 })]);
    renderSheet();
    await screen.findByText('Great card!');

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-like'));
    expect(screen.getByText('6')).toBeTruthy();

    await waitFor(() => expect(screen.getByText('5')).toBeTruthy());
  });

  it('hides replies behind the "N replies" toggle and reveals them with a blue @mention', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'Top level', likeCount: 0 }),
      buildComment({
        id: 'r1',
        author: { displayName: 'Brock', handle: 'brock', avatarUrl: null, isVerified: false },
        body: 'Nice one',
        parentCommentId: 'c1',
      }),
    ]);
    renderSheet();
    await screen.findByText('Top level');

    // Reply is hidden until the toggle is tapped.
    expect(screen.queryByTestId('comments-sheet-comment-r1')).toBeNull();
    const toggle = screen.getByTestId('comments-sheet-comment-c1-replies-toggle');
    expect(screen.getByText('1 reply')).toBeTruthy();

    fireEvent.press(toggle);

    // Reply now visible; the parent author's handle renders as an inline @mention.
    expect(await screen.findByTestId('comments-sheet-comment-r1')).toBeTruthy();
    expect(screen.getByText('@misty')).toBeTruthy();
    expect(screen.getByText('Hide replies')).toBeTruthy();

    // Tapping again collapses.
    fireEvent.press(toggle);
    await waitFor(() => expect(screen.queryByTestId('comments-sheet-comment-r1')).toBeNull());
  });
});
