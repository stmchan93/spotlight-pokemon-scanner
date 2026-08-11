import { buildProfileShareMessage } from '@/features/profile/profile-share';

/**
 * The text that accompanies a shared profile.
 *
 * This is now the FALLBACK path. When the sender's id is known the share travels
 * as a reference and the recipient gets a preview card (social_24); this text is
 * what goes out when there is no id to attach — and what still works against a
 * project that has not applied that migration.
 *
 * The copy names the DESTINATION rather than the app: it is always sent beside a
 * link to exactly that page, and "on Ekalight" told the recipient nothing about
 * what they were being invited to open.
 *
 * THE POINT OF THE UNIT IS THE MISSING PARTS. A signed-in user is not guaranteed
 * a handle — handles are claimed separately from sign-up — and the display name
 * falls back to a placeholder before the profile has loaded. Interpolating
 * either straight into a template is how a share reads "@undefined", so every
 * branch is pinned here rather than only the happy one.
 */
describe('buildProfileShareMessage', () => {
  it('names the collection by default, because that is the profile page a bare link opens', () => {
    expect(buildProfileShareMessage({ displayName: 'Ash Ketchum', handle: 'ash' })).toBe(
      "Check out Ash Ketchum's collection",
    );
  });

  it('names the wishlist when that is what was shared', () => {
    expect(
      buildProfileShareMessage({ destination: 'wishlist', displayName: 'Ash Ketchum', handle: 'ash' }),
    ).toBe("Check out Ash Ketchum's wishlist");
  });

  it('prefers the human name over the handle rather than printing both', () => {
    // Was "Ash Ketchum (@ash) on Ekalight". The parenthesised handle was noise
    // next to a link that resolves to the same person.
    expect(buildProfileShareMessage({ displayName: 'Ash Ketchum', handle: 'ash' })).not.toContain(
      '@ash',
    );
  });

  it('drops an empty handle rather than sharing a dangling one', () => {
    // The bug this exists to stop: "Ash Ketchum (@undefined)" / "Ash Ketchum ()".
    for (const handle of [undefined, null, '', '   ']) {
      expect(buildProfileShareMessage({ displayName: 'Ash Ketchum', handle })).toBe(
        "Check out Ash Ketchum's collection",
      );
    }
  });

  it('falls back to the handle when there is no display name', () => {
    expect(buildProfileShareMessage({ displayName: '  ', handle: 'ash' })).toBe(
      "Check out @ash's collection",
    );
  });

  // Handles are stored without the `@`, but a value that arrives carrying one
  // must not produce "@@ash".
  it('tolerates a handle that already carries its @', () => {
    expect(buildProfileShareMessage({ displayName: '', handle: '@ash' })).toBe(
      "Check out @ash's collection",
    );
  });

  // Same contract `buildWishlistShareMessage` uses for an empty list: the caller
  // stays silent rather than sharing "Check out 's collection".
  it('returns null when there is no identity at all', () => {
    expect(buildProfileShareMessage({})).toBeNull();
    expect(buildProfileShareMessage({ displayName: null, handle: null })).toBeNull();
  });
});
