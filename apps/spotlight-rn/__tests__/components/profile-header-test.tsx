import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, StyleSheet } from 'react-native';

import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider, colors } from '@spotlight/design-system';

import { ProfileHeader } from '../../src/features/profile/components/profile-header';

function renderHeader(node: React.ReactElement) {
  // SafeAreaProvider is required: the cover bleeds under the status bar by
  // -insets.top, so the header reads real insets now. `initialMetrics` keeps
  // them deterministic instead of waiting on an onLayout that never fires here.
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 393, height: 852 },
        insets: { top: 59, left: 0, right: 0, bottom: 34 },
      }}
    >
      <SpotlightThemeProvider>{node}</SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

/**
 * The cover skeleton resolves the reduce-motion preference on a microtask.
 * Tests that mount it settle that promise inside `act` so the state update it
 * schedules is not reported as an un-acted update once the test body returns.
 */
async function flushMotionProbe() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ProfileHeader', () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bleeds the cover under the status bar with AND without a photo', () => {
    // These two branches drifted: the photo branch bled, the fallback did not,
    // so a profile with no cover showed a white strip above the grey band and
    // everything below it sat insets.top too low. Assert both, together, so they
    // cannot diverge again.
    const withPhoto = renderHeader(
      <ProfileHeader coverUrl="https://cdn.test/c.jpg" displayName="Ash" initials="AK" />,
    );
    const photoFrame = StyleSheet.flatten(
      screen.getByTestId('profile-header-cover-frame').props.style,
    );
    expect(photoFrame.marginTop).toBe(-59);
    expect(photoFrame.height).toBe(176 + 59);
    withPhoto.unmount();

    renderHeader(<ProfileHeader displayName="Ash" initials="AK" />);
    const placeholder = StyleSheet.flatten(
      screen.getByTestId('profile-header-cover-placeholder').props.style,
    );
    expect(placeholder.marginTop).toBe(-59);
    expect(placeholder.height).toBe(176 + 59);
  });

  it('renders the display name', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" />);

    expect(screen.getByText('Ash Ketchum')).toBeTruthy();
  });

  /*
    NO EDIT PENCIL BESIDE THE NAME. This block carried an owner-only pencil at
    `profile-header-edit`, on the argument that the top bar of the day (Figma
    3505:14521) had four slots and none of them was edit. The profile toolbar
    (3670:47454) now gives edit a slot of its own, so the screen that owns the
    bar owns the affordance and this block draws identity only.
  */
  it('draws no edit control of its own', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" handle="ash" initials="AK" />);

    expect(screen.queryByTestId('profile-header-edit')).toBeNull();
    expect(screen.queryByLabelText('Edit profile')).toBeNull();
    // The identity it used to sit next to is untouched.
    expect(screen.getByText('Ash Ketchum')).toBeTruthy();
    expect(screen.getByText('@ash')).toBeTruthy();
  });

  it('renders the Verified badge when isVerified is set', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" isVerified />);

    expect(screen.getByText('Verified')).toBeTruthy();
  });

  it('renders the bio text', () => {
    renderHeader(
      <ProfileHeader
        bio="Gotta collect them all."
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );

    expect(screen.getByText('Gotta collect them all.')).toBeTruthy();
  });

  it('renders the three stat counts', () => {
    renderHeader(
      <ProfileHeader
        displayName="Ash Ketchum"
        followerCount={12}
        followingCount={34}
        initials="AK"
        reputation={56}
      />,
    );

    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('34')).toBeTruthy();
    expect(screen.getByText('56')).toBeTruthy();
  });

  it('renders the initials when avatarUrl is absent', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" />);

    expect(screen.getByText('AK')).toBeTruthy();
  });

  it('falls back to a very light gray cover banner, not the tinted surface', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" />);

    const placeholder = screen.getByTestId('profile-header-cover-placeholder');
    expect(StyleSheet.flatten(placeholder.props.style).backgroundColor).toBe(colors.gray100);
  });

  it('renders the uploaded cover banner instead of the placeholder', async () => {
    renderHeader(
      <ProfileHeader
        coverUrl="https://cdn.test/covers/user-1.jpg"
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );

    const cover = screen.getByTestId('profile-header-cover');
    // Cropped to fill the banner band — a portrait photo must not letterbox.
    expect(cover.props.contentFit).toBe('cover');
    expect(cover.props.source).toEqual({ uri: 'https://cdn.test/covers/user-1.jpg' });
    expect(screen.queryByTestId('profile-header-cover-placeholder')).toBeNull();
    await flushMotionProbe();
  });

  it('shows a skeleton over the cover band while the photo is still loading', async () => {
    renderHeader(
      <ProfileHeader
        coverUrl="https://cdn.test/covers/user-1.jpg"
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );

    expect(screen.getByTestId('profile-header-cover-skeleton')).toBeTruthy();
    await flushMotionProbe();
  });

  it('drops the skeleton once the cover photo loads', async () => {
    renderHeader(
      <ProfileHeader
        coverUrl="https://cdn.test/covers/user-1.jpg"
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );
    await flushMotionProbe();

    act(() => {
      fireEvent(screen.getByTestId('profile-header-cover'), 'load');
    });

    expect(screen.queryByTestId('profile-header-cover-skeleton')).toBeNull();
    expect(screen.getByTestId('profile-header-cover')).toBeTruthy();
  });

  it('drops the skeleton when the cover photo fails, leaving the plain band', async () => {
    renderHeader(
      <ProfileHeader
        coverUrl="https://cdn.test/covers/user-1.jpg"
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );
    await flushMotionProbe();

    act(() => {
      fireEvent(screen.getByTestId('profile-header-cover'), 'error');
    });

    // A failed cover must not pulse forever — the band settles to the same flat
    // neutral a cover-less profile shows.
    expect(screen.queryByTestId('profile-header-cover-skeleton')).toBeNull();
    const frame = screen.getByTestId('profile-header-cover-frame');
    expect(StyleSheet.flatten(frame.props.style).backgroundColor).toBe(colors.gray100);
  });

  it('re-enters the loading state when a newly uploaded cover replaces the old one', async () => {
    const { rerender } = renderHeader(
      <ProfileHeader
        coverUrl="https://cdn.test/covers/user-1.jpg"
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );
    await flushMotionProbe();

    act(() => {
      fireEvent(screen.getByTestId('profile-header-cover'), 'load');
    });
    expect(screen.queryByTestId('profile-header-cover-skeleton')).toBeNull();

    // Same provider stack as the initial render — `rerender` replaces the whole
    // tree, so dropping SafeAreaProvider here would strip the insets the cover
    // bleed depends on.
    rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 393, height: 852 },
          insets: { top: 59, left: 0, right: 0, bottom: 34 },
        }}
      >
        <SpotlightThemeProvider>
          <ProfileHeader
            coverUrl="https://cdn.test/covers/user-1.jpg?t=2"
            displayName="Ash Ketchum"
            initials="AK"
          />
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    expect(screen.getByTestId('profile-header-cover-skeleton')).toBeTruthy();
    await flushMotionProbe();
  });

  it('renders no skeleton at all when the profile has no cover', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" />);

    expect(screen.queryByTestId('profile-header-cover-skeleton')).toBeNull();
    expect(screen.queryByTestId('profile-header-cover')).toBeNull();
    expect(screen.getByTestId('profile-header-cover-placeholder')).toBeTruthy();
  });

  it('caches the cover and cross-fades it in instead of popping', async () => {
    renderHeader(
      <ProfileHeader
        coverUrl="https://cdn.test/covers/user-1.jpg"
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );

    const cover = screen.getByTestId('profile-header-cover');
    // memory-disk keeps the banner network-free after the first fetch, so a
    // relaunch or a tab switch never re-downloads it.
    expect(cover.props.cachePolicy).toBe('memory-disk');
    expect(cover.props.transition).toBeGreaterThan(0);
    await flushMotionProbe();
  });

  it('paints the just-picked local cover immediately instead of a skeleton', () => {
    renderHeader(
      <ProfileHeader
        coverPreviewUri="file:///tmp/picked-cover.jpg"
        coverUrl="https://cdn.test/covers/user-1.jpg"
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );

    const cover = screen.getByTestId('profile-header-cover');
    expect(cover.props.placeholder).toEqual({ uri: 'file:///tmp/picked-cover.jpg' });
    expect(cover.props.placeholderContentFit).toBe('cover');
    // The user is already looking at their own photo — no skeleton over it.
    expect(screen.queryByTestId('profile-header-cover-skeleton')).toBeNull();
  });

  /*
    The field is free text, so whether a value is a LINK is decided here. Every
    value used to render blue inside a `Pressable`, so unopenable text advertised
    a destination and did nothing when tapped.
  */
  describe('the social row', () => {
    it('draws an openable value as a tappable blue link', async () => {
      const onSocialLinkPress = jest.fn();
      renderHeader(
        <ProfileHeader
          displayName="Ash Ketchum"
          initials="AK"
          onSocialLinkPress={onSocialLinkPress}
          socialLink="instagram.com/ash"
        />,
      );

      const row = screen.getByTestId('profile-header-social-link');
      fireEvent.press(row);
      expect(onSocialLinkPress).toHaveBeenCalled();
      expect(screen.queryByTestId('profile-header-social-text')).toBeNull();
      await flushMotionProbe();
    });

    it('draws a value that is not a link as plain, untappable text', async () => {
      const onSocialLinkPress = jest.fn();
      renderHeader(
        <ProfileHeader
          displayName="Ash Ketchum"
          initials="AK"
          onSocialLinkPress={onSocialLinkPress}
          // A bare word: valid to store, impossible to open. Before this it was
          // stored as '' and vanished; now it survives and shows as itself.
          socialLink="instagram"
        />,
      );

      expect(screen.getByText('instagram')).toBeTruthy();
      // The whole point: no link row, so nothing to tap and nothing to promise.
      expect(screen.queryByTestId('profile-header-social-link')).toBeNull();
      expect(screen.getByTestId('profile-header-social-text')).toBeTruthy();
      expect(onSocialLinkPress).not.toHaveBeenCalled();
      await flushMotionProbe();
    });
  });
});
