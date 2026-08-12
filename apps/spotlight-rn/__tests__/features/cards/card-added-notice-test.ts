import {
  clearCardAddedNotice,
  consumeCardAddedNotice,
  noteCardAdded,
} from '@/features/cards/card-added-notice';

/*
  The handoff that carries "Added to your collection" from the card page — which
  is unmounting — to whichever screen it popped back to.

  The expiry is the part worth pinning. Nothing guarantees a reader: adding from
  the Collection pops back to a screen that is not listening, so without a
  deadline the message would sit in the module and then appear, stale, the next
  time catalog search happened to open.
*/
describe('card-added notice', () => {
  afterEach(() => {
    clearCardAddedNotice();
  });

  it('hands the message to the next reader', () => {
    noteCardAdded('Added to your collection', 1_000);
    expect(consumeCardAddedNotice(1_200)).toBe('Added to your collection');
  });

  it('is read at most once, so returning again does not re-announce', () => {
    noteCardAdded('Added to your collection', 1_000);
    consumeCardAddedNotice(1_200);
    expect(consumeCardAddedNotice(1_300)).toBeNull();
  });

  it('expires rather than waiting indefinitely for a reader', () => {
    noteCardAdded('Added to your collection', 1_000);
    // Long enough to have gone somewhere else entirely — the message is no
    // longer about anything the user is looking at.
    expect(consumeCardAddedNotice(30_000)).toBeNull();
  });

  it('clears an expired message instead of leaving it to surface later', () => {
    noteCardAdded('Added to your collection', 1_000);
    expect(consumeCardAddedNotice(30_000)).toBeNull();
    // The read that expired it must also have dropped it, or the very next
    // reader would get a message from minutes ago.
    expect(consumeCardAddedNotice(30_001)).toBeNull();
  });

  it('keeps only the most recent add', () => {
    noteCardAdded('first', 1_000);
    noteCardAdded('second', 1_100);
    expect(consumeCardAddedNotice(1_200)).toBe('second');
  });

  it('reads as nothing when no card was added', () => {
    expect(consumeCardAddedNotice(1_000)).toBeNull();
  });
});
