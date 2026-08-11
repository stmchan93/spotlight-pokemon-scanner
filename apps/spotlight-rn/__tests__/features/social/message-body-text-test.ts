import { splitMessageBody } from '@/features/social/components/message-body-text';

describe('splitMessageBody', () => {
  it('leaves an ordinary message as a single plain run', () => {
    expect(splitMessageBody('want to trade?')).toEqual([
      { kind: 'text', value: 'want to trade?' },
    ]);
  });

  it('pulls a profile link out of the surrounding text', () => {
    expect(
      splitMessageBody("Cards I'm looking for:\n\nspotlight://u/ash?tab=wishlist"),
    ).toEqual([
      { kind: 'text', value: "Cards I'm looking for:\n\n" },
      {
        kind: 'link',
        value: 'spotlight://u/ash?tab=wishlist',
        path: '/u/ash?tab=wishlist',
      },
    ]);
  });

  it('keeps text on both sides of a link', () => {
    expect(splitMessageBody('see spotlight://u/ash now')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'spotlight://u/ash', path: '/u/ash' },
      { kind: 'text', value: ' now' },
    ]);
  });

  // A refused link must still be VISIBLE — dropping it would hide part of what
  // the sender actually wrote.
  it('renders an unfollowable scheme link as plain text', () => {
    expect(splitMessageBody('spotlight://account')).toEqual([
      { kind: 'text', value: 'spotlight://account' },
    ]);
  });

  it('handles several links in one body', () => {
    const segments = splitMessageBody('spotlight://u/ash and spotlight://u/misty');
    expect(segments.filter((segment) => segment.kind === 'link')).toHaveLength(2);
  });

  // PROFILE_LINK_PATTERN is a /g regex, so a shared `lastIndex` between calls
  // would make every other call miss the link.
  it('is not affected by regex state across calls', () => {
    const body = 'spotlight://u/ash';
    expect(splitMessageBody(body)).toEqual(splitMessageBody(body));
  });
});
