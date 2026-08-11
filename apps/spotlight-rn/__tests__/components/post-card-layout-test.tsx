import { render, screen, waitFor, within } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { PostCard } from '@/features/social/components/post-card';
import { fetchLikedPostIds, type FeedPost } from '@/features/social/social-service';

jest.mock('@/features/social/social-service', () => ({
  fetchLikedPostIds: jest.fn(async () => new Set()),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  fetchRepostedPostIds: jest.fn(async () => new Set()),
  repostPost: jest.fn(async () => true),
  unrepostPost: jest.fn(async () => true),
  fetchComments: jest.fn(async () => []),
  fetchLikedCommentIds: jest.fn(async () => new Set()),
  addComment: jest.fn(async () => ({ ok: false, reason: 'nope' })),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
  blockUser: jest.fn(async () => true),
  reportContent: jest.fn(async () => true),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentUser: {
      id: 'me',
      displayName: 'Ash Ketchum',
      handle: 'ash',
      avatarURL: null,
      email: 'ash@example.com',
      isVerified: false,
    },
  }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), back: jest.fn() }),
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

const post: FeedPost = {
  id: 'post-1',
  authorId: 'author-1',
  author: { displayName: 'Ash Ketchum', handle: 'ash', avatarUrl: null, isVerified: false },
  body: 'Nice pull today',
  cardId: null,
  likeCount: 2,
  commentCount: 0,
  repostCount: 0,
  createdAt: '2026-05-01T00:00:00.000Z',
  media: [],
};

async function renderCard() {
  render(<PostCard post={post} />, { wrapper: Wrapper });
  await waitFor(() => expect(fetchLikedPostIds as jest.Mock).toHaveBeenCalledWith([post.id]));
}

function flatten(node: { props: { style?: unknown } }) {
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<string, unknown>;
}

/**
 * The card's VERTICAL RHYTHM, which nothing asserted until a double-counted gap
 * shipped (Figma "Home" 3523:15499, post card 3505:14460).
 *
 * `metricsRow` carried a `paddingBottom: 8` on top of the card's own `gap: 8`,
 * so every divider sat 16pt below the action glyphs instead of 8 — the spacing
 * was right in each style on its own and wrong once the two were added up. The
 * only way to catch that class of bug is to assert the gap AND the padding that
 * stacks with it together, which is what this file does.
 */
describe('PostCard layout', () => {
  it('stacks the card on a single 8pt gap with a 16pt top inset', async () => {
    await renderCard();

    const card = flatten(screen.getByTestId(`post-card-${post.id}`));

    // One rhythm for header→body→image→metrics.
    expect(card.gap).toBe(8);
    // The 16 above the avatar is the same 16 that separates a divider from the
    // next card, so the feed itself carries no inter-item gap.
    expect(card.paddingTop).toBe(16);
  });

  it('leaves the action row no padding of its own, so the divider sits 8pt below the glyphs', async () => {
    await renderCard();

    const metricsRow = flatten(screen.getByTestId('post-card-metrics'));

    // MUST stay undefined. Any value here is ADDED to the card's `gap: 8` and
    // doubles the glyph→divider distance the frame specifies as 8.
    expect(metricsRow.paddingBottom).toBeUndefined();
    // Still the 16pt page gutter — the row's horizontal inset is unrelated.
    expect(metricsRow.paddingHorizontal).toBe(16);
  });

  /*
    The row's HORIZONTAL composition, which nothing asserted either — the file
    covered only vertical rhythm, so adding a third control to the reaction group
    could not have been caught by anything here.

    Figma 3523:15539 draws the left group as like · comment · repost with share
    alone on the right, and the split is load-bearing rather than decorative:
    `metricsRow` is `space-between` with exactly two children, so a control added
    as a THIRD child of the row (rather than inside the left group) silently
    re-spaces the whole thing and drops the 12pt inter-group gap.
  */
  it('groups all three reactions on the left with share alone on the right', async () => {
    await renderCard();

    const metricsRow = flatten(screen.getByTestId('post-card-metrics'));
    expect(metricsRow.justifyContent).toBe('space-between');
    // Bottom-aligned so the 18pt share glyph baselines with the reaction glyphs
    // instead of floating above them (Figma 3505:14440).
    expect(metricsRow.alignItems).toBe('flex-end');

    // Two children only: the left group, and the share button. A third would
    // mean a control was added to the ROW rather than to the group.
    const rowChildren = screen.getByTestId('post-card-metrics').children;
    expect(rowChildren).toHaveLength(2);

    // Every reaction lives in that first child, and the share button does not.
    const left = rowChildren[0] as never;
    expect(within(left).getByTestId('post-card-like-count')).toBeTruthy();
    expect(within(left).getByTestId('post-card-comment-count')).toBeTruthy();
    expect(within(left).getByTestId('post-card-repost-count')).toBeTruthy();
    expect(within(left).queryByTestId('post-card-share-button')).toBeNull();

    // Figma 3505:14441 — 12 between reaction groups, 4 inside one.
    expect(flatten(left).gap).toBe(12);
  });
});
