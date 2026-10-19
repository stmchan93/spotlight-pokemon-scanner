import { screen } from '@testing-library/react-native';

import { ScanCandidateReviewScreen } from '@/features/cards/screens/scan-candidate-review-screen';
import { ExpansionDetailScreen } from '@/features/catalog/screens/expansion-detail-screen';
import { setDevProfileOverrides } from '@/features/profile/profile-service';
import { FollowListScreen } from '@/features/profile/screens/follow-list-screen';
import { setDevDmOverrides } from '@/features/social/dm-service';
import { BlockedAccountsScreen } from '@/features/social/screens/blocked-accounts-screen';
import { DmInboxScreen } from '@/features/social/screens/dm-inbox-screen';
import { NotificationsScreen } from '@/features/social/screens/notifications-screen';
import { PostDetailScreen } from '@/features/social/screens/post-detail-screen';
import { setDevSocialOverrides } from '@/features/social/social-service';
import { createDevRepository, DEV_EXPANSION_ID, DEV_EXPANSION_NAME } from '@/dev/dev-repository';
import { candidateFor } from '@/dev/dev-scanner-screen';
import { DEV_SCAN_BINDER, DEV_SCAN_SINGLE } from '@/dev/dev-scanner-fixtures';
import {
  DEV_POST_ID,
  DEV_PROFILE_ID,
  devDmOverrides,
  devFollowers,
  devProfileOverrides,
  devSocialOverrides,
} from '@/dev/dev-social-data';

import { renderWithProviders } from './test-utils';

/*
  The typography-audit dev routes (`spotlight://dev/<slug>`, 2026-10-18) render
  the REAL screens over fixtures: Supabase-backed screens through the services'
  setDev*Overrides seams, catalog screens through the dev repository. What has to
  hold: with the overrides installed each screen reaches its populated state from
  the fixture (not its empty state), and the scan review renders the fixture
  candidates. Mirrors dev-price-trend-graded-test.tsx.
*/

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
  capturePostHogException: jest.fn(),
}));

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({
      back: jest.fn(),
      canGoBack: jest.fn(() => false),
      push: jest.fn(),
      replace: jest.fn(),
      dismissTo: jest.fn(),
    }),
  };
});

// The placeholder PNGs live under the app's `assets/`, which jest's `@/` alias
// (src-only) cannot reach; the rewrite is cosmetic here, so pass URLs through.
jest.mock('@/dev/dev-fixtures', () => ({
  devImageUriForUrl: (url: string) => url,
}));

describe('typography-audit dev routes', () => {
  beforeEach(() => {
    setDevSocialOverrides(devSocialOverrides);
    setDevProfileOverrides(devProfileOverrides);
    setDevDmOverrides(devDmOverrides);
  });

  afterEach(() => {
    setDevSocialOverrides(null);
    setDevProfileOverrides(null);
    setDevDmOverrides(null);
  });

  it('follow-list: lists the fixture followers', async () => {
    renderWithProviders(<FollowListScreen mode="followers" userID={DEV_PROFILE_ID} />);
    expect(await screen.findByText('Kanto Grader')).toBeTruthy();
    expect(screen.getByTestId(`follow-list-row-${devFollowers[devFollowers.length - 1].userID}`)).toBeTruthy();
  });

  it('post-detail: renders the fixture post, not the missing state', async () => {
    renderWithProviders(<PostDetailScreen postId={DEV_POST_ID} />);
    expect(await screen.findByText(/Anyone still playing Pokémon Go/)).toBeTruthy();
    expect(screen.queryByTestId('post-detail-missing')).toBeNull();
  });

  it('notifications: renders every fixture row kind', async () => {
    renderWithProviders(<NotificationsScreen />);
    // Row copy is nested <Text> spans, and two fixture rows are follows, so
    // match on "at least one" rather than a single element.
    expect((await screen.findAllByText(/started following you/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reposted your post/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/That centering looks dead on/).length).toBeGreaterThan(0);
  });

  it('messages: renders the fixture inbox with previews', async () => {
    renderWithProviders(<DmInboxScreen />);
    expect(await screen.findByText(/see you at the Pomona show/)).toBeTruthy();
    expect(screen.getByText('PSA 10 came back! Posting it tonight.')).toBeTruthy();
  });

  it('blocked-accounts: renders the fixture rows with the name fallbacks', async () => {
    renderWithProviders(<BlockedAccountsScreen />);
    expect(await screen.findByText('Spam Pulls')).toBeTruthy();
    expect(screen.getByText('@lowballer_99')).toBeTruthy();
    expect(screen.getByText('Blocked account')).toBeTruthy();
  });

  it('expansion-detail: lists the dev expansion cards from the dev repository', async () => {
    const spotlightRepository = await createDevRepository();
    renderWithProviders(
      <ExpansionDetailScreen
        expansionId={DEV_EXPANSION_ID}
        expansionName={DEV_EXPANSION_NAME}
        onClose={() => undefined}
        onOpenCard={() => undefined}
      />,
      { spotlightRepository },
    );
    expect(await screen.findByText('Sceptile')).toBeTruthy();
    expect(screen.getByText('#010/168')).toBeTruthy();
  });

  it('scan-review: renders the fixture candidates with the found count', () => {
    const similar = DEV_SCAN_BINDER.slice(0, 5).map(candidateFor);
    renderWithProviders(
      <ScanCandidateReviewScreen
        candidates={similar}
        closestMatch={candidateFor(DEV_SCAN_SINGLE)}
        onBack={() => undefined}
        onOpenCandidate={() => undefined}
        totalCount={similar.length + 1}
      />,
    );
    expect(screen.getByText('6 cards found')).toBeTruthy();
    expect(screen.getByText('5 similar cards')).toBeTruthy();
  });
});
