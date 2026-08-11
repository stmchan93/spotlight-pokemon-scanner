import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SharedPostBubble } from '@/features/social/components/shared-post-bubble';
import { clearSharedPostCache } from '@/features/social/shared-post-cache';
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
    // The resolved-post cache is MODULE state and outlives a single test.
    // `jest.clearAllMocks()` does not touch it, so without this a later test
    // starts warm and its "paints on the first frame" assertion passes for the
    // wrong reason — or worse, a test asserting the skeleton never sees one.
    clearSharedPostCache();
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

  /*
    ═══════════════════════════════════════════════════════════════════════════
    THE FLICKER. Reported as "reopening a thread shows the text messages, then
    everything jumps as the shared cards appear."
    ═══════════════════════════════════════════════════════════════════════════
    Two independent causes, one test each below.
  */

  /*
    CAUSE 1 — the loading state was a flat 220pt box against a resolved card of
    roughly 395, so every shared post grew ~155pt the moment it landed. The DM
    list has no `getItemLayout` and no `maintainVisibleContentPosition`, and it
    re-pins to the bottom on `onContentSizeChange`, so a row that changes height
    mid-read is an unanimated jump.

    Asserted STRUCTURALLY, not as a pixel height: pinning "the placeholder is
    395 tall" would just re-encode the same brittleness one number along. What
    has to be true is that the skeleton draws the same boxes the resolved card
    does, so the height follows from the layout.
  */
  it('reserves the resolved card\'s shape while loading, not a fixed box', async () => {
    let resolvePost: (post: unknown) => void = () => {};
    fetchPost.mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
    );

    renderWithProviders(
      <SharedPostBubble
        accessToken="token-123"
        apiBaseUrl="https://api.example.com"
        onOpen={jest.fn()}
        postId="post-1"
      />,
    );

    const skeleton = screen.getByTestId('shared-post-loading');
    // The same three bands the resolved card renders: header, image, caption.
    // A bare box would have no children at all — which is what shipped.
    const bands = skeleton.props.children.filter(Boolean);
    expect(bands.length).toBeGreaterThanOrEqual(3);

    // The image band holds `PostImage`'s exact frame, so the photo lands into
    // space that was already reserved rather than pushing the thread down.
    const frames = skeleton.findAll(
      (node: { props?: { style?: unknown } }) =>
        (StyleSheet.flatten(node?.props?.style) as { aspectRatio?: number } | undefined)
          ?.aspectRatio === 4 / 5,
    );
    expect(frames.length).toBeGreaterThan(0);

    await act(async () => {
      resolvePost(buildPost({ media: [{ id: 'm-1', width: 800, height: 1000, blurhash: null }] }));
    });
    expect(screen.getByTestId('shared-post-card')).toBeTruthy();
  });

  /*
    CAUSE 2 — every mount refetched from cold, so a thread you had already opened
    still showed a placeholder first. This is the half that actually removes the
    flicker on a REOPEN: the second mount paints the card on frame one.
  */
  it('paints a post it has already loaded on the first frame, with no skeleton', async () => {
    fetchPost.mockResolvedValue(buildPost());

    const first = renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);
    await screen.findByTestId('shared-post-card');
    first.unmount();

    renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);

    // Synchronously, before any effect has had a chance to resolve.
    expect(screen.queryByTestId('shared-post-loading')).toBeNull();
    expect(screen.getByTestId('shared-post-card')).toBeTruthy();
    expect(screen.getByText('Just pulled a Charizard')).toBeTruthy();
  });

  /*
    …AND THE CACHE MUST NOT BECOME THE ANSWER.

    The message stores an id precisely so visibility is re-checked on every read.
    A cache that skipped the read would leave a post removed by moderation, or
    hidden by a block created since, sitting readable in a private thread — the
    exact failure the reference design exists to prevent. So a warm mount still
    fetches, and still degrades when the answer has changed.
  */
  it('re-reads a cached post and drops it when it is no longer visible', async () => {
    fetchPost.mockResolvedValue(buildPost());
    const first = renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);
    await screen.findByTestId('shared-post-card');
    first.unmount();

    // Removed between the two opens.
    fetchPost.mockResolvedValue(null);
    renderWithProviders(<SharedPostBubble onOpen={jest.fn()} postId="post-1" />);

    // Warm, so it starts by showing what it had…
    expect(screen.getByTestId('shared-post-card')).toBeTruthy();
    // …then the read comes back and it degrades.
    expect(await screen.findByTestId('shared-post-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('shared-post-card')).toBeNull();
    expect(fetchPost).toHaveBeenCalledTimes(2);
  });

  // Two cards pointing at the same post — or a row scrolled out and back —
  // must not each open their own round trip.
  it('shares one request between simultaneous readers of the same post', async () => {
    fetchPost.mockResolvedValue(buildPost());

    renderWithProviders(
      <>
        <SharedPostBubble onOpen={jest.fn()} postId="post-1" testID="a" />
        <SharedPostBubble onOpen={jest.fn()} postId="post-1" testID="b" />
      </>,
    );

    await screen.findByTestId('a-card');
    await screen.findByTestId('b-card');
    expect(fetchPost).toHaveBeenCalledTimes(1);
  });
});
