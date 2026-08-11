import { Image, StyleSheet } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

import { SharedProfileBubble } from '@/features/social/components/shared-profile-bubble';

const mockFetchProfileById = jest.fn();
jest.mock('@/features/profile/profile-service', () => ({
  fetchProfileById: (...args: unknown[]) => mockFetchProfileById(...args),
}));

function buildCard(id: string) {
  return {
    id,
    cardId: `card-${id}`,
    name: `Card ${id}`,
    cardNumber: '1/1',
    setName: 'Set',
    imageUrl: `https://img.test/${id}.png`,
    smallImageUrl: `https://img.test/${id}-small.png`,
    marketPrice: 1,
    hasMarketPrice: true,
    currencyCode: 'USD',
  };
}

function buildRepository(overrides: Record<string, unknown> = {}) {
  return {
    getProfileWishlistEntries: jest.fn(async () => [buildCard('a'), buildCard('b')]),
    getProfileDeckEntries: jest.fn(async () => [buildCard('c')]),
    ...overrides,
  } as never;
}

describe('SharedProfileBubble', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    /*
      The card PREFETCHES its art before mounting the tiles, so all four appear
      together instead of popping in one at a time. Unmocked, `prefetch` never
      settles here and every card waits out its full deadline — so this is not
      incidental plumbing, it is the thing that keeps these tests off a timer.
    */
    jest.spyOn(Image, 'prefetch').mockResolvedValue(true);
    mockFetchProfileById.mockResolvedValue({
      userID: 'owner-1',
      displayName: 'Misty',
      handle: 'misty',
      avatarURL: null,
    });
  });

  it('reads as an invitation naming whose list it is and which one', async () => {
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository()}
        tab="wishlist"
        testID="bubble"
        userId="owner-1"
      />,
    );

    expect(await screen.findByTestId('bubble-card')).toBeTruthy();
    // An invitation, not a caption — no body text travels beside the card, so
    // this line IS the message.
    expect(screen.getByText("See Misty's wishlist!")).toBeTruthy();
  });

  it('reads the WISHLIST for a wishlist share and the collection for a collection share', async () => {
    const repository = buildRepository();
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={repository}
        tab="collection"
        testID="bubble"
        userId="owner-1"
      />,
    );

    await screen.findByTestId('bubble-card');
    expect((repository as never as Record<string, jest.Mock>).getProfileDeckEntries).toHaveBeenCalled();
    expect(
      (repository as never as Record<string, jest.Mock>).getProfileWishlistEntries,
    ).not.toHaveBeenCalled();
  });

  /*
    Four slots whatever the list holds. A two-card wishlist rendering a ragged
    row would change the card's height between messages, so the grid is fixed and
    the empty slots simply stay blank.
  */
  it('keeps a 2x2 grid even when the list is shorter than four cards', async () => {
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository()}
        tab="wishlist"
        testID="bubble"
        userId="owner-1"
      />,
    );

    await screen.findByTestId('bubble-card');
    // Two cards -> two images, but the collage itself still rendered.
    expect(screen.getByTestId('bubble-collage')).toBeTruthy();
    expect(screen.getByTestId('bubble-slot-0')).toBeTruthy();
    expect(screen.getByTestId('bubble-slot-1')).toBeTruthy();
    expect(screen.queryByTestId('bubble-slot-2')).toBeNull();
  });

  /*
    ONE TILE PER CARD — no padding out to four.

    The collage used to build a fixed 2×2 and fill the unused slots with `null`,
    which drew an empty grey tile for each. On a one-item wishlist that is a card
    beside a PHANTOM card, and it reads as something that failed to load rather
    than as blank space. Reported from a real shared wishlist.

    The `-slot-N` testIDs above cannot see this: they sit on the IMAGE, which an
    empty slot never renders — the empty tile is a bare `View`. So the assertion
    has to count the collage's CHILDREN, which is exactly why nothing caught it.
  */
  it('draws no empty tiles for a list shorter than the grid', async () => {
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository({
          getProfileWishlistEntries: jest.fn(async () => [buildCard('only')]),
        })}
        tab="wishlist"
        testID="bubble"
        userId="owner-1"
      />,
    );

    await screen.findByTestId('bubble-card');
    const collage = screen.getByTestId('bubble-collage');
    // One card in the list, one tile in the grid — not one tile and three ghosts.
    expect(collage.children).toHaveLength(1);
    expect(screen.getByTestId('bubble-slot-0')).toBeTruthy();
  });

  /*
    ───────────────────────────────────────────────────────────────────────────
    THE SKELETON MUST NOT CHANGE SHAPE WHEN IT RESOLVES
    ───────────────────────────────────────────────────────────────────────────
    Reported as "opening my messages flickers". The loading state was a flat
    220pt box and the resolved card is ~375, so every shared card grew ~155pt on
    load — and the thread auto-scrolls on content-size change, so it scrolled,
    reflowed and scrolled again.

    Pinned by STRUCTURE rather than by asserting a height: the skeleton renders
    the same header, the same four tiles and the same footer, so the two agree by
    construction and keep agreeing when the tile ratio changes.
  */
  it('renders the same structure while loading as it does once resolved', async () => {
    // A fresh identity, because the preview cache is module state that outlives
    // a single test — a warm entry renders content on the first frame and there
    // is no skeleton to assert. That is the cache working, not a failure.
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository()}
        tab="wishlist"
        testID="bubble"
        userId="owner-cold-1"
      />,
    );

    // Four tiles are already laid out before anything has been fetched.
    const skeleton = screen.getByTestId('bubble-loading');
    expect(skeleton).toBeTruthy();

    await screen.findByTestId('bubble-card');
    // ...and the resolved card lays out the same four slots.
    expect(screen.getByTestId('bubble-collage')).toBeTruthy();
    expect(screen.queryByTestId('bubble-loading')).toBeNull();
  });

  /*
    ───────────────────────────────────────────────────────────────────────────
    A SECOND LOOK AT THE SAME LIST SHOWS NO SKELETON
    ───────────────────────────────────────────────────────────────────────────
    Every card used to fetch from scratch on every mount, and the COLLECTION read
    is served behind the backend's heavy-read semaphore — so two cards in one
    thread queued behind each other. A screen recording showed the wishlist card
    resolve at once while the collection card sat on its skeleton for another
    second, and scrolling a card out and back re-ran the whole thing.

    Stale-while-revalidate: a hit paints immediately AND still refetches, so the
    visibility check runs exactly as often as before. Only the blank frame goes.
  */
  it('paints from cache on a second mount, and still revalidates underneath', async () => {
    const first = buildRepository();
    const { unmount } = render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={first}
        tab="wishlist"
        testID="bubble"
        userId="owner-warm-1"
      />,
    );
    await screen.findByTestId('bubble-card');
    unmount();

    const second = buildRepository();
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={second}
        tab="wishlist"
        testID="bubble-2"
        userId="owner-warm-1"
      />,
    );

    // Content on the FIRST frame — no skeleton was ever mounted.
    expect(screen.queryByTestId('bubble-2-loading')).toBeNull();
    expect(screen.getByTestId('bubble-2-card')).toBeTruthy();

    // ...and the check still ran.
    await waitFor(() => {
      expect(
        (second as never as Record<string, jest.Mock>).getProfileWishlistEntries,
      ).toHaveBeenCalled();
    });
  });

  /*
    ───────────────────────────────────────────────────────────────────────────
    NOTHING WAITS FOR THE TILES ANY MORE
    ───────────────────────────────────────────────────────────────────────────
    The collage used to sit invisible until all four tiles reported `onLoad`,
    then fade in as a unit, with a 1200ms deadline underneath and a Set
    recording which collages had completed so a later mount could start shown.

    That worked with ONE card and failed with several — reported as "the flicker
    happens when I have multiple shares, not if I only have one message". N cards
    put 4N images in flight, and the collection read queues behind the backend's
    heavy-read semaphore, so cards routinely missed the deadline. A card revealed
    BY the deadline was deliberately not recorded as shown, so it repeated the
    blank-then-pop on every open, forever.

    The slots are laid out at final size the whole time, so a tile painting into
    its own grey square moves nothing. There is no reflow left for a fade to
    hide — only a card-sized blink for it to cause.
  */
  it('shows its collage immediately, without waiting for any tile to load', async () => {
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository()}
        tab="wishlist"
        testID="bubble"
        userId="owner-nowait-1"
      />,
    );

    await screen.findByTestId('bubble-card');

    // Visible with no tile having reported anything. Under the old fade this
    // was opacity 0 until four `onLoad`s or a 1200ms timer.
    const collage = screen.getByTestId('bubble-collage');
    expect(StyleSheet.flatten(collage.props.style)?.opacity ?? 1).toBe(1);
  });

  /*
    The tiles carry the app's `thumbnail` policy — `memory-disk` — which is what
    actually makes a revisited thread instant: the bytes are already decoded, so
    the art paints on the first frame. This replaced counting `onLoad`s, which
    tried to infer the same thing and got it wrong under load.
  */
  it('caches tile art to disk, so a reopened thread paints it at once', async () => {
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository()}
        tab="wishlist"
        testID="bubble"
        userId="owner-cachepolicy-1"
      />,
    );

    await screen.findByTestId('bubble-card');
    expect(screen.getByTestId('bubble-slot-0').props.cachePolicy).toBe('memory-disk');
  });

  /*
    A dropped request must not blank a card that is already on screen. Turning a
    network blip into "this is no longer available" reads as content being taken
    away, which is a worse lie than a slightly stale preview.
  */
  it('keeps a cached card on screen when the revalidation fails', async () => {
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository()}
        tab="wishlist"
        testID="bubble"
        userId="owner-warm-2"
      />,
    );
    await screen.findByTestId('bubble-card');

    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository({
          getProfileWishlistEntries: jest.fn(async () => {
            throw new Error('network');
          }),
        })}
        tab="wishlist"
        testID="bubble-3"
        userId="owner-warm-2"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('bubble-3-card')).toBeTruthy();
    });
    expect(screen.queryByTestId('bubble-3-unavailable')).toBeNull();
  });

  /*
    A profile that will not resolve is a profile the reader may no longer see —
    deleted, hidden, or blocked since the send. All three render identically:
    saying WHICH would disclose the block.
  */
  it('renders an unavailable card rather than a broken one when the profile will not resolve', async () => {
    mockFetchProfileById.mockResolvedValue(null);
    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={buildRepository()}
        tab="wishlist"
        testID="bubble"
        userId="owner-1"
      />,
    );

    expect(await screen.findByTestId('bubble-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('bubble-card')).toBeNull();
  });

  it('survives a failed read the same way, without surfacing the error', async () => {
    const repository = buildRepository({
      getProfileWishlistEntries: jest.fn(async () => {
        throw new Error('network');
      }),
    });

    render(
      <SharedProfileBubble
        onOpen={jest.fn()}
        repository={repository}
        tab="wishlist"
        testID="bubble"
        userId="owner-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('bubble-unavailable')).toBeTruthy();
    });
  });
});
