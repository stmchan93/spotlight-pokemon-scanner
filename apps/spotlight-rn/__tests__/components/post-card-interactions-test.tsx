import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { PostCard } from '@/features/social/components/post-card';
import { fetchConversations, sendMessage } from '@/features/social/dm-service';
import {
  addComment,
  blockUser,
  fetchComments,
  fetchLikedPostIds,
  type FeedPost,
  likePost,
  reportContent,
  unlikePost,
} from '@/features/social/social-service';

jest.mock('@/features/social/social-service', () => ({
  fetchLikedPostIds: jest.fn(async () => new Set()),
  likePost: jest.fn(async () => true),
  unlikePost: jest.fn(async () => true),
  fetchComments: jest.fn(async () => []),
  fetchLikedCommentIds: jest.fn(async () => new Set()),
  addComment: jest.fn(async () => ({ ok: false, reason: 'nope' })),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
  blockUser: jest.fn(async () => true),
  reportContent: jest.fn(async () => true),
}));

// The share sheet talks to the DM system: existing threads, then a send. Both
// are network in real life, so both are mocked here.
jest.mock('@/features/social/dm-service', () => ({
  fetchConversations: jest.fn(async () => []),
  findOrCreateDm: jest.fn(async () => 'conv-new'),
  sendMessage: jest.fn(async () => ({ id: 'm-1' })),
}));

jest.mock('@/features/profile/profile-service', () => ({
  searchUsers: jest.fn(async () => []),
}));

// The comments sheet the card renders reads the signed-in user so a just-posted
// comment carries their name, and the ⋯ menu reads it to decide whose post this
// is. Mutable so a test can sign the viewer out — `mock`-prefixed because jest
// hoists `jest.mock` above every const in the file.
const mockSignedInUser = {
  id: 'me',
  displayName: 'Ash Ketchum',
  handle: 'ash',
  avatarURL: null,
  email: 'ash@example.com',
  isVerified: false,
};
let mockCurrentUser: typeof mockSignedInUser | null = mockSignedInUser;
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ currentUser: mockCurrentUser }),
}));

// The card and the comment thread both navigate to a profile now. `mock`-
// prefixed because jest hoists `jest.mock` above every const in the file.
const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockNavigate, back: jest.fn() }),
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

async function renderCard(
  post: FeedPost = buildPost(),
  props: {
    onRequestDelete?: (post: FeedPost) => void;
    apiBaseUrl?: string | null;
    accessToken?: string | null;
  } = {},
) {
  render(<PostCard post={post} {...props} />, { wrapper: Wrapper });
  // Flush the on-mount liked-state read so later state updates are settled.
  await waitFor(() => expect(fetchLikedPostIds as jest.Mock).toHaveBeenCalledWith([post.id]));
}

/*
  The ⋯ safety menu and the block confirmation are VIEWS now, not `Alert`s — the
  same `OptionsSheet` + `ConfirmDeleteSheet` pair a comment row uses, so the app
  has one safety menu rather than an OS alert on a post and a bottom sheet on a
  comment. The only `Alert`s left here are the outcome ACKNOWLEDGEMENTS.
*/
const OPTIONS = 'post-card-options';
const BLOCK_CONFIRM = 'post-card-block-confirm';

async function pressById(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
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

// The mocked auth context above signs in as `me`; `buildPost` defaults to
// `author-1`, i.e. somebody else's post.
describe('PostCard delete affordance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
  });

  it('never offers delete on someone else’s post', async () => {
    const onRequestDelete = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderCard(buildPost({ authorId: 'author-1' }), { onRequestDelete });

    // The ⋯ is there — it carries Report/Block now — but it must never reach
    // the delete path for a post the viewer does not own.
    fireEvent.press(screen.getByTestId('post-card-more-button'));
    expect(onRequestDelete).not.toHaveBeenCalled();
    // …and the menu is the same bottom sheet a comment's ⋯ opens, not an OS
    // alert. Nothing is alerted just by opening it.
    expect(screen.getByTestId(OPTIONS)).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('renders the ⋯ menu on your own post and asks the list to delete it', async () => {
    const onRequestDelete = jest.fn();
    const post = buildPost({ authorId: 'me' });
    await renderCard(post, { onRequestDelete });

    fireEvent.press(screen.getByTestId('post-card-more-button'));

    // The card only REQUESTS the delete; confirming and removing is the list's job.
    expect(onRequestDelete).toHaveBeenCalledWith(post);
  });

  it('hides the ⋯ menu on your own post when the surface cannot delete', async () => {
    await renderCard(buildPost({ authorId: 'me' }));

    expect(screen.queryByTestId('post-card-more-button')).toBeNull();
  });
});

// Report and block are the app's ONLY safety controls, and until this existed
// the ⋯ menu rendered on your own post only — so there was no way to report or
// block anyone at all.
describe('PostCard report and block', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentUser = mockSignedInUser;
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
    (reportContent as jest.Mock).mockResolvedValue(true);
    (blockUser as jest.Mock).mockResolvedValue(true);
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  // The safety menu must not depend on the screen supporting deletion.
  it('offers Report/Block on someone else’s post even with no delete handler', async () => {
    await renderCard(buildPost({ authorId: 'author-1' }));

    fireEvent.press(screen.getByTestId('post-card-more-button'));

    expect(screen.getByTestId(OPTIONS)).toBeTruthy();
    expect(screen.getByText('Report post')).toBeTruthy();
    expect(screen.getByText('Block Ash Ketchum')).toBeTruthy();
    expect(screen.getByTestId(`${OPTIONS}-cancel`)).toBeTruthy();
  });

  /*
    NO chrome on the menu — the same treatment as the comment row's ⋯.

    It used to be an `Alert` titled with the author's name; the sheet has no
    heading and no subtitle at all, because two labelled rows and a Cancel
    explain themselves. What must NOT happen is the anonymity promise silently
    leaving the product with the subtitle: it moved to the report
    acknowledgement and the block confirmation, both asserted below.
  */
  it('shows a bare list of actions — no title, no subtitle, no OS alert', async () => {
    await renderCard(buildPost({ authorId: 'author-1' }));

    fireEvent.press(screen.getByTestId('post-card-more-button'));

    expect(alertSpy).not.toHaveBeenCalled();
    // Scoped to the sheet: the card behind it legitimately still shows the
    // author's name in its header.
    const sheet = within(screen.getByTestId(OPTIONS));
    expect(sheet.queryByText('Post options')).toBeNull();
    // The author's name was the old alert's title; it survives only inside the
    // Block row's own label.
    expect(sheet.queryByText('Ash Ketchum')).toBeNull();
    expect(sheet.queryByText('The author is not told who reported or blocked them.')).toBeNull();
  });

  // Report is reversible and low-stakes, Block is neither — a bare list must
  // not present them as the same kind of act.
  it('styles Report as the softer of the two — only Block is a red CTA', async () => {
    await renderCard(buildPost({ authorId: 'author-1' }));

    fireEvent.press(screen.getByTestId('post-card-more-button'));

    const fill = (id: string) =>
      StyleSheet.flatten(screen.getByTestId(id).props.style).backgroundColor;
    const labelColor = (label: string) =>
      StyleSheet.flatten(screen.getByText(label).props.style).color;

    expect(fill(`${OPTIONS}-block`)).toBe('#D93025');
    expect(fill(`${OPTIONS}-report`)).toBe(fill(`${OPTIONS}-cancel`));
    expect(labelColor('Report post')).toBe('#D93025');
    expect(labelColor('Cancel')).not.toBe('#D93025');
  });

  it('files a report against the post and its author', async () => {
    await renderCard(buildPost({ authorId: 'author-1' }));

    fireEvent.press(screen.getByTestId('post-card-more-button'));
    await pressById(`${OPTIONS}-report`);

    // `reason` stays empty (the service stores null): it is the REPORTER's
    // stated reason and there is no reason picker yet. A provenance marker here
    // would put "which screen this came from" in the column a moderator reads as
    // "why". The comment sheet files reports the same way — two surfaces writing
    // one table must not disagree about this field.
    await waitFor(() =>
      expect(reportContent as jest.Mock).toHaveBeenCalledWith({
        reportedUserId: 'author-1',
        postId: 'post-1',
        reason: '',
      }),
    );
    // Word-for-word what the comment thread says. Pinned on BOTH surfaces
    // because reporting is one action and must not read as two different
    // features depending on what you reported. No author name in it either —
    // the copy is deliberately identical regardless of who was reported.
    await waitFor(() =>
      expect(alertSpy).toHaveBeenLastCalledWith(
        'Report sent',
        "Thanks for reporting this. We've received your report and will take a look at this as soon as possible.",
      ),
    );
  });

  // Blocking is mutual and has no unblock surface yet, so it must never fire
  // straight off the menu.
  it('confirms before blocking, then drops the post from the list', async () => {
    await renderCard(buildPost({ authorId: 'author-1' }));

    fireEvent.press(screen.getByTestId('post-card-more-button'));
    await pressById(`${OPTIONS}-block`);

    // Menu choice made, nothing written yet — the confirmation replaced the
    // menu inside the same host modal (a second native modal would collide).
    expect(blockUser as jest.Mock).not.toHaveBeenCalled();
    expect(screen.queryByTestId(OPTIONS)).toBeNull();
    expect(screen.getByTestId(BLOCK_CONFIRM)).toBeTruthy();
    expect(screen.getByText('Block Ash Ketchum?')).toBeTruthy();
    // The half of the anonymity promise that belongs to blocking is here, and
    // it is the comment thread's wording verbatim.
    expect(
      screen.getByText(
        'Their posts and comments disappear from your feed, and yours disappear from theirs. They are not told that you blocked them.',
      ),
    ).toBeTruthy();

    await pressById(`${BLOCK_CONFIRM}-confirm`);

    await waitFor(() => expect(blockUser as jest.Mock).toHaveBeenCalledWith('author-1'));
    // The card leaves the screen so the confirmation copy is true immediately,
    // rather than a promise that waits for the next feed refresh.
    await waitFor(() => expect(screen.queryByTestId('post-card-body')).not.toBeOnTheScreen());
  });

  it('backs out of the menu and out of the block confirmation without writing', async () => {
    await renderCard(buildPost({ authorId: 'author-1' }));

    fireEvent.press(screen.getByTestId('post-card-more-button'));
    await pressById(`${OPTIONS}-cancel`);
    expect(reportContent as jest.Mock).not.toHaveBeenCalled();
    expect(blockUser as jest.Mock).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('post-card-more-button'));
    await pressById(`${OPTIONS}-block`);
    await pressById(`${BLOCK_CONFIRM}-cancel`);
    expect(blockUser as jest.Mock).not.toHaveBeenCalled();
    expect(screen.getByTestId('post-card-body')).toBeTruthy();
  });

  it('leaves the post in place when the block write fails', async () => {
    (blockUser as jest.Mock).mockResolvedValue(false);
    await renderCard(buildPost({ authorId: 'author-1' }));

    fireEvent.press(screen.getByTestId('post-card-more-button'));
    await pressById(`${OPTIONS}-block`);
    await pressById(`${BLOCK_CONFIRM}-confirm`);

    await waitFor(() =>
      expect(alertSpy).toHaveBeenLastCalledWith("Couldn't block", expect.any(String)),
    );
    expect(screen.getByTestId('post-card-body')).toBeTruthy();
  });

  // A guest has no id. `undefined === undefined` must not make a stray post look
  // self-authored, and the inverse must not hand an anonymous viewer two writes
  // they cannot make — so they get no ⋯ at all.
  it('gives a signed-out viewer no ⋯ menu on anyone’s post', async () => {
    mockCurrentUser = null;
    await renderCard(buildPost({ authorId: 'author-1' }), { onRequestDelete: jest.fn() });

    expect(screen.queryByTestId('post-card-more-button')).toBeNull();
  });
});

// Post images are private bytes behind an authenticated proxy that serves a
// NON-author only `approved` media, and new uploads sit at `pending` until a
// 2-minute moderation cron. A reader opening the feed straight after someone
// posts therefore gets a legitimate refusal — which used to render as an empty
// slot that read as a broken app.
describe('PostCard pending media', () => {
  const mediaPost = buildPost({
    authorId: 'author-1',
    media: [{ id: 'media-1', width: 800, height: 1000, blurhash: null }],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentUser = mockSignedInUser;
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
  });

  it('shows a processing placeholder — not an empty frame — when the proxy refuses', async () => {
    await renderCard(mediaPost, { apiBaseUrl: 'https://api.test', accessToken: 'token' });

    fireEvent(screen.getByTestId('post-card-image-media-1'), 'error');

    expect(screen.getByTestId('post-card-image-media-1-placeholder')).toBeTruthy();
    expect(screen.getByText('Photo is still processing')).toBeTruthy();
    // The post itself is never held back: body and metrics stay put.
    expect(screen.getByTestId('post-card-body')).toBeTruthy();
  });

  // The author is authorized for their own pending media, so a failure they see
  // is transport, never moderation — telling them it is "processing" would be a
  // guess about a state the client cannot read.
  it('tells the author the photo didn’t load instead of blaming moderation', async () => {
    await renderCard(
      { ...mediaPost, authorId: 'me' },
      { apiBaseUrl: 'https://api.test', accessToken: 'token' },
    );

    fireEvent(screen.getByTestId('post-card-image-media-1'), 'error');

    expect(screen.getByText("Photo didn't load")).toBeTruthy();
  });
});

describe('PostCard chat icon', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (addComment as jest.Mock).mockResolvedValue({ ok: false, reason: 'nope' });
  });

  // The icon and the count sit a few pixels apart; when the icon opened a
  // composer-only sheet, whether you saw the existing thread depended on which
  // of the two you happened to hit. Both now open the same thread sheet.
  it('opens the full thread — the same sheet the count opens', async () => {
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

  it('posts from the thread sheet and bumps the card count', async () => {
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    await renderCard();

    expect(screen.getByTestId('post-card-comment-count').props.children).toBe(0);

    fireEvent.press(screen.getByTestId('post-card-comment-button'));
    fireEvent.changeText(
      await screen.findByTestId('post-card-comments-input'),
      'Straight to the composer',
    );
    fireEvent.press(screen.getByTestId('post-card-comments-send'));

    await waitFor(() =>
      expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'Straight to the composer', null),
    );
    await waitFor(() =>
      expect(screen.getByTestId('post-card-comment-count').props.children).toBe(1),
    );
  });
});

describe('PostCard comments sheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (addComment as jest.Mock).mockResolvedValue({ ok: false, reason: 'nope' });
  });

  it('loads and shows comments when the comment count is pressed', async () => {
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

    fireEvent.press(screen.getByTestId('post-card-comment-count-button'));

    expect(await screen.findByText('Great card!')).toBeTruthy();
    expect(fetchComments as jest.Mock).toHaveBeenCalledWith('post-1');
  });

  it('shows the empty state when there are no comments', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([]);
    await renderCard();

    fireEvent.press(screen.getByTestId('post-card-comment-count-button'));

    expect(await screen.findByTestId('post-card-comments-empty')).toBeTruthy();
    expect(screen.getByText('Be the first to comment')).toBeTruthy();
  });

  it('optimistically appends a new comment and bumps the card count', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    await renderCard();

    expect(screen.getByTestId('post-card-comment-count').props.children).toBe(0);

    fireEvent.press(screen.getByTestId('post-card-comment-count-button'));
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

describe('PostCard author links', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
    (fetchComments as jest.Mock).mockResolvedValue([]);
  });

  it('opens the author profile from the name and from the avatar', async () => {
    await renderCard();

    fireEvent.press(screen.getByTestId('post-card-author-name-button'));
    expect(mockPush).toHaveBeenLastCalledWith('/u/ash');

    fireEvent.press(screen.getByTestId('post-card-avatar-button'));
    expect(mockPush).toHaveBeenLastCalledWith('/u/ash');
  });

  // The mocked auth context signs in as `me`.
  it('sends you to the You tab when the author is you, not to your public profile', async () => {
    await renderCard(
      buildPost({
        authorId: 'me',
        author: { displayName: 'Ash Ketchum', handle: 'ash', avatarUrl: null, isVerified: false },
      }),
    );

    fireEvent.press(screen.getByTestId('post-card-author-name-button'));
    // NOT `/u/ash` — that is a read-only copy of your own profile pushed on top
    // of the feed, with no Edit and a back button out of somewhere you live.
    expect(mockNavigate).toHaveBeenLastCalledWith('/you');
    expect(mockPush).not.toHaveBeenCalledWith('/u/ash');
  });

  // `/u/[handle]` resolves a UUID slug by id, which is the only thing that makes
  // a collector who never claimed a handle reachable at all.
  it('falls back to the user id when the author has no handle', async () => {
    await renderCard(
      buildPost({
        authorId: 'ffffffff-0000-0000-0000-000000000001',
        author: { displayName: 'Handleless', handle: null, avatarUrl: null, isVerified: false },
      }),
    );

    fireEvent.press(screen.getByTestId('post-card-author-name-button'));
    expect(mockPush).toHaveBeenLastCalledWith('/u/ffffffff-0000-0000-0000-000000000001');
  });

  it('opens a commenter profile, closing the sheet first so it cannot cover the profile', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      {
        id: 'c-1',
        postId: 'post-1',
        authorId: 'author-2',
        author: { displayName: 'Misty', handle: 'misty', avatarUrl: null, isVerified: false },
        body: 'Great card!',
        parentCommentId: null,
        likeCount: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    await renderCard();

    fireEvent.press(screen.getByTestId('post-card-comment-count-button'));
    await screen.findByText('Great card!');

    fireEvent.press(screen.getByTestId('post-card-comments-comment-c-1-name-button'));
    expect(mockPush).toHaveBeenLastCalledWith('/u/misty');
    // The thread is a Modal — left open, it would sit over the profile.
    await waitFor(() => expect(screen.queryByText('Great card!')).not.toBeOnTheScreen());
  });
});

/*
  SHARING IS SEND-TO-DM, NOT A REPOST.

  Nothing is republished: the message carries the post's id and its preview is
  hydrated from `posts` on every read (social_22), so a post that is later
  removed, deleted or hidden by a block stops resolving wherever it was sent.
  A repost, or a link baked into a message body, would have left a copy behind
  that outlives its original in a private thread nobody moderates.

  The first test here is a regression in the strictest sense: this button
  rendered with a label, a hit-slop and a glyph and NO `onPress` at all, so it
  looked like a feature and did nothing.
*/
describe('PostCard share', () => {
  const SHARE_SHEET = 'post-card-share-sheet';

  beforeEach(() => {
    jest.clearAllMocks();
    (fetchLikedPostIds as jest.Mock).mockResolvedValue(new Set());
    (fetchConversations as jest.Mock).mockResolvedValue([]);
    (sendMessage as jest.Mock).mockResolvedValue({ id: 'm-1' });
  });

  function conversationWith(userId: string, displayName: string) {
    return {
      id: `conv-${userId}`,
      otherUserId: userId,
      otherUser: { displayName, handle: displayName.toLowerCase(), avatarUrl: null },
    };
  }

  it('opens the recipient picker from the share button', async () => {
    await renderCard();

    expect(screen.queryByTestId(SHARE_SHEET)).toBeNull();

    await pressById('post-card-share-button');

    expect(await screen.findByTestId(SHARE_SHEET)).toBeTruthy();
  });

  it('sends the post to an existing thread without a caption', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([conversationWith('u-2', 'Misty')]);
    await renderCard();

    await pressById('post-card-share-button');
    await pressById(`${SHARE_SHEET}-recipient-u-2`);

    // Empty body, post id attached — the whole point of the column.
    await waitFor(() =>
      expect(sendMessage as jest.Mock).toHaveBeenCalledWith('conv-u-2', '', {
        sharedPostId: 'post-1',
      }),
    );
  });

  /*
    The sheet is the only confirmation there is — with it dismissed, a send and a
    silently-failed send look exactly the same. It also has to survive the first
    tap because sharing is plural: you send the same pull to the two people who
    would care.
  */
  it('stays open after a send and marks that recipient Sent', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([
      conversationWith('u-2', 'Misty'),
      conversationWith('u-3', 'Brock'),
    ]);
    await renderCard();

    await pressById('post-card-share-button');
    await pressById(`${SHARE_SHEET}-recipient-u-2`);

    await waitFor(() =>
      expect(screen.getByTestId(`${SHARE_SHEET}-state-u-2`).props.children).toBe('Sent'),
    );
    expect(screen.getByTestId(`${SHARE_SHEET}-state-u-3`).props.children).toBe('Send');
    expect(screen.getByTestId(SHARE_SHEET)).toBeTruthy();

    // And the second recipient still works from the same sheet.
    await pressById(`${SHARE_SHEET}-recipient-u-3`);
    await waitFor(() => expect(sendMessage as jest.Mock).toHaveBeenCalledTimes(2));
  });

  // A tapped row is disabled once it says Sent, so an enthusiastic double-tap
  // cannot put the same post in the same thread twice.
  it('will not send the same post to the same person twice', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([conversationWith('u-2', 'Misty')]);
    await renderCard();

    await pressById('post-card-share-button');
    await pressById(`${SHARE_SHEET}-recipient-u-2`);
    await waitFor(() => expect(sendMessage as jest.Mock).toHaveBeenCalledTimes(1));

    await pressById(`${SHARE_SHEET}-recipient-u-2`);
    expect(sendMessage as jest.Mock).toHaveBeenCalledTimes(1);
  });
});
