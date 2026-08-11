import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { SharedPostBubble } from '@/features/social/components/shared-post-bubble';
import { fetchPostById } from '@/features/social/social-service';

import { renderWithProviders } from '../test-utils';

jest.mock('@/features/social/social-service', () => ({
  fetchPostById: jest.fn(),
}));

const fetchPost = fetchPostById as jest.Mock;

function buildPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    authorId: 'a1',
    author: { displayName: 'Misty', handle: 'misty', avatarUrl: null, isVerified: false },
    body: 'Just pulled a Charizard',
    cardId: null,
    media: [],
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SharedPostBubble', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the post it points at, headed by whose it is', async () => {
    fetchPost.mockResolvedValue(buildPost());

    renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);

    expect(await screen.findByTestId('shared-post-card')).toBeTruthy();
    // The handle, not the display name: the card is the Instagram shape, and
    // the thread's own avatar already says who SENT it — this says whose it is.
    expect(screen.getByText('@misty')).toBeTruthy();
    expect(screen.getByText('Just pulled a Charizard')).toBeTruthy();
  });

  // A collector who never claimed a handle still has to be named.
  it('falls back to the display name when the author has no handle', async () => {
    fetchPost.mockResolvedValue(
      buildPost({
        author: { displayName: 'Misty', handle: null, avatarUrl: null, isVerified: false },
      }),
    );

    renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);

    await screen.findByTestId('shared-post-card');
    expect(screen.getByText('Misty')).toBeTruthy();
  });

  /*
    THE PHOTO IS THE POINT.

    A shared post with its image stripped is a line of text claiming a post
    exists. But the bytes are PRIVATE — the proxy only serves them behind a
    bearer header — so the card renders one only when it has both halves of
    that, and degrades to header + caption rather than to a broken frame when
    it does not.
  */
  it('streams the photo through the authenticated proxy', async () => {
    fetchPost.mockResolvedValue(
      buildPost({ media: [{ id: 'm-1', width: 800, height: 1000, blurhash: null }] }),
    );

    renderWithProviders(
      <SharedPostBubble
        accessToken="token-123"
        apiBaseUrl="https://api.example.com/"
        onOpen={jest.fn()}
        postId="post-1"
      />,
    );

    const image = await screen.findByTestId('shared-post-image');
    // Trailing slash on the base must not double up.
    expect(image.props.source.uri).toBe('https://api.example.com/api/v1/post-media/m-1');
    expect(image.props.source.headers).toEqual({ Authorization: 'Bearer token-123' });
  });

  it('shows the card without a photo rather than a broken frame when unauthenticated', async () => {
    fetchPost.mockResolvedValue(
      buildPost({ media: [{ id: 'm-1', width: 800, height: 1000, blurhash: null }] }),
    );

    renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);

    await screen.findByTestId('shared-post-card');
    expect(screen.queryByTestId('shared-post-image')).toBeNull();
    // The rest of the card still stands.
    expect(screen.getByText('Just pulled a Charizard')).toBeTruthy();
  });

  it('opens the post when tapped', async () => {
    fetchPost.mockResolvedValue(buildPost());
    const onOpen = jest.fn();

    renderWithProviders(<SharedPostBubble onOpen={onOpen} postId="post-1" />);

    fireEvent.press(await screen.findByTestId('shared-post-card'));

    expect(onOpen).toHaveBeenCalledWith('post-1');
  });

  /*
    THE CASE THAT JUSTIFIES THE WHOLE DESIGN.

    The message stores only an id, so the preview is a fresh read of `posts` on
    every render and `posts_select` re-answers "may this reader see it?" each
    time. A post removed by moderation, soft-deleted by its author, or hidden by
    a block created AFTER it was sent simply stops resolving — and the bubble has
    to say so.

    Had the share baked a link into the message body instead, that text would
    still be sitting in a private thread nobody moderates.
  */
  it('says so when the post is no longer available', async () => {
    // Removed / deleted / blocked all arrive here as the same null.
    fetchPost.mockResolvedValue(null);

    renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);

    expect(await screen.findByTestId('shared-post-unavailable')).toBeTruthy();
    expect(screen.getByText('This post is no longer available')).toBeTruthy();
    // Never a blank card — that reads as a bug rather than as what happened.
    expect(screen.queryByTestId('shared-post-card')).toBeNull();
  });

  it('does not leak WHY it is unavailable', async () => {
    fetchPost.mockResolvedValue(null);

    renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);

    await screen.findByTestId('shared-post-unavailable');
    /*
      Removed, deleted and blocked must be indistinguishable. Naming the reason
      would disclose "this person blocked you", which the block system refuses
      to tell anyone — a detectable block is an invitation to retaliate from a
      second account.
    */
    expect(screen.queryByText(/block/i)).toBeNull();
    expect(screen.queryByText(/removed/i)).toBeNull();
    expect(screen.queryByText(/deleted/i)).toBeNull();
  });

  it('re-reads when the post it points at changes', async () => {
    fetchPost.mockResolvedValue(buildPost());

    const view = renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);
    await screen.findByTestId('shared-post-card');

    fetchPost.mockResolvedValue(buildPost({ id: 'post-2', body: 'A different post' }));
    view.rerender(<SharedPostBubble onOpen={jest.fn()} postId="post-2" />);

    await waitFor(() => expect(screen.getByText('A different post')).toBeTruthy());
    expect(fetchPost).toHaveBeenCalledTimes(2);
  });
});
