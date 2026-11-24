import { fireEvent, screen } from '@testing-library/react-native';

import SocialRoute from '@/app/(tabs)/social';
import { fetchGlobalFeedItems } from '@/features/social/social-service';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';
import { upcomingFeatured } from '../events/event-fixtures';

const mockPush = jest.fn();
const mockSetParams = jest.fn();
let mockParams: { tab?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ setParams: mockSetParams }),
}));

jest.mock('@/components/focused-status-bar', () => ({ FocusedStatusBar: () => null }));

let mockIsGuest = true;
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null, currentUser: null, ensureGuestSession: jest.fn(), isGuest: mockIsGuest }),
}));

jest.mock('@/features/social/social-service', () => ({
  ...jest.requireActual('@/features/social/social-service'),
  fetchGlobalFeedItems: jest.fn(async () => []),
}));

// The signed-in feed is covered by feed-screen-test; here only the param it gets matters.
jest.mock('@/features/social/screens/feed-screen', () => {
  const actual = jest.requireActual('@/features/social/screens/feed-screen');
  const { Text } = jest.requireActual('react-native');
  return {
    ...actual,
    FeedScreen: ({ requestedTab }: { requestedTab?: string }) => (
      <Text testID="feed-stub">{requestedTab ?? 'none'}</Text>
    ),
  };
});

function renderRoute() {
  return renderWithProviders(<SocialRoute />, {
    spotlightRepository: createTestSpotlightRepository({
      fetchSpotlightEvents: async () => ({ items: [upcomingFeatured] }),
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsGuest = true;
  mockParams = {};
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Social route', () => {
  it('guest: EVENTS only, upcoming list without saved/past/hearts, and no feed reads', async () => {
    renderRoute();
    expect(await screen.findByTestId(`event-card-${upcomingFeatured.id}`)).toBeTruthy();
    expect(screen.getByTestId('feed-tabs-tab-events')).toBeTruthy();
    expect(screen.queryByTestId('feed-tabs-tab-forYou')).toBeNull();
    expect(screen.queryByTestId('feed-tabs-tab-yourPosts')).toBeNull();
    expect(screen.queryByTestId('feed-events-tabs')).toBeNull();
    expect(screen.queryByTestId(`event-card-${upcomingFeatured.id}-save`)).toBeNull();
    expect(screen.getByTestId('feed-events-title').props.children).toBe('UPCOMING SPOTLIGHT EVENTS');
    expect(fetchGlobalFeedItems).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('guest: the bell opens sign-in', async () => {
    renderRoute();
    await screen.findByTestId(`event-card-${upcomingFeatured.id}`);
    fireEvent.press(screen.getByLabelText('Notifications'));
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('signed in: passes ?tab= through and clears it so the same link works again', () => {
    mockIsGuest = false;
    mockParams = { tab: 'events' };
    renderRoute();
    expect(screen.getByTestId('feed-stub').props.children).toBe('events');
    expect(mockSetParams).toHaveBeenCalledWith({ tab: undefined });
  });

  it('signed in: ignores an unknown tab', () => {
    mockIsGuest = false;
    mockParams = { tab: 'nope' };
    renderRoute();
    expect(screen.getByTestId('feed-stub').props.children).toBe('none');
  });
});
