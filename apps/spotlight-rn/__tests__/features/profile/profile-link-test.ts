import {
  buildProfileDeepLink,
  profileLinkToRoutePath,
} from '@/features/profile/profile-link';

describe('buildProfileDeepLink', () => {
  it('prefers the handle and omits the tab for the default page', () => {
    expect(buildProfileDeepLink({ handle: 'ash', userId: 'user-1' })).toBe(
      'spotlight://u/ash',
    );
    expect(buildProfileDeepLink({ handle: 'ash', tab: 'collection' })).toBe(
      'spotlight://u/ash',
    );
  });

  it('names the wishlist tab', () => {
    expect(buildProfileDeepLink({ handle: 'ash', tab: 'wishlist' })).toBe(
      'spotlight://u/ash?tab=wishlist',
    );
  });

  // Handles are claimed separately from sign-up, so a linkable collector may not
  // have one — `/u/<uuid>` is the route's own fallback lane.
  it('falls back to the user id when there is no handle', () => {
    expect(
      buildProfileDeepLink({
        handle: null,
        userId: '25a3f0ec-7046-4b99-9afc-28e39f7066c3',
        tab: 'wishlist',
      }),
    ).toBe('spotlight://u/25a3f0ec-7046-4b99-9afc-28e39f7066c3?tab=wishlist');
  });

  it('tolerates a stored leading @ rather than emitting a double one', () => {
    expect(buildProfileDeepLink({ handle: '@ash' })).toBe('spotlight://u/ash');
  });

  it('percent-encodes the slug', () => {
    expect(buildProfileDeepLink({ handle: 'a b' })).toBe('spotlight://u/a%20b');
  });

  // A link to `/u/` resolves to nobody; the caller stays silent instead.
  it('returns null when there is no identity at all', () => {
    expect(buildProfileDeepLink({})).toBeNull();
    expect(buildProfileDeepLink({ handle: '   ', userId: '' })).toBeNull();
    expect(buildProfileDeepLink({ handle: '@' })).toBeNull();
  });
});

describe('profileLinkToRoutePath', () => {
  it('round-trips a link this app built', () => {
    expect(profileLinkToRoutePath(buildProfileDeepLink({ handle: 'ash' })!)).toBe('/u/ash');
    expect(
      profileLinkToRoutePath(buildProfileDeepLink({ handle: 'ash', tab: 'wishlist' })!),
    ).toBe('/u/ash?tab=wishlist');
  });

  // These links arrive inside DM bodies, which are attacker-controlled text.
  // Following anything but the profile route would hand a stranger a jump to
  // any screen in the app.
  it('refuses every scheme URL that is not a profile route', () => {
    const hostile = [
      'spotlight://account',
      'spotlight://labeling/session',
      'spotlight://u',
      'spotlight://u/ash/followers',
      'spotlight://u/../account',
      'spotlight://u/%2e%2e',
      'spotlight:///u/ash/extra',
      'https://example.com/u/ash',
      'u/ash',
      '',
    ];
    for (const url of hostile) {
      expect(profileLinkToRoutePath(url)).toBeNull();
    }
  });

  it('drops an unrecognised tab rather than forwarding it', () => {
    expect(profileLinkToRoutePath('spotlight://u/ash?tab=forsale')).toBe('/u/ash');
    expect(profileLinkToRoutePath('spotlight://u/ash?tab=../evil')).toBe('/u/ash');
  });
});
