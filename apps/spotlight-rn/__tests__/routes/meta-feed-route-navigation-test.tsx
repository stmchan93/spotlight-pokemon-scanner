import { fireEvent, render, screen } from '@testing-library/react-native';

import CalendarRoute from '@/app/(stack)/calendar';
import MetaRoute from '@/app/(stack)/meta';
import MetaGroupRoute from '@/app/(stack)/meta/group/[groupKey]';
import NewsRoute from '@/app/(stack)/news';
import SetSpotlightRoute from '@/app/(stack)/set-spotlight/[setId]';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockUseLocalSearchParams = jest.fn();

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    const { Text } = require('react-native');
    return <Text testID="redirect">{href}</Text>;
  },
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

type MockScreenProps = Record<string, unknown> & {
  onBack: () => void;
  onOpenCard?: (cardId: string) => void;
  onOpenEvent?: (event: unknown) => void;
  onOpenGroup?: (target: unknown) => void;
};

function mockScreen(name: string) {
  return function MockScreen(props: MockScreenProps) {
    const { Pressable, Text } = require('react-native');
    const { onBack, onOpenCard, onOpenEvent, onOpenGroup, ...rest } = props;
    return (
      <>
        <Text testID={`${name}-props`}>{JSON.stringify(rest)}</Text>
        <Pressable onPress={onBack} testID={`${name}-back`} />
        <Pressable onPress={() => onOpenCard?.('sm7-1')} testID={`${name}-card`} />
        <Pressable
          onPress={() => onOpenGroup?.({ game: 'pokemon', groupKey: 'modern:raw:sir', lane: 'raw', windowDays: 30 })}
          testID={`${name}-group`}
        />
        <Pressable
          onPress={() => onOpenEvent?.({ id: 'e', setId: 'cel25', url: 'https://example.test' })}
          testID={`${name}-event`}
        />
      </>
    );
  };
}

jest.mock('@/features/meta-feed/screens/meta-screen', () => ({ MetaScreen: mockScreen('meta') }));
jest.mock('@/features/meta-feed/screens/meta-group-screen', () => ({ MetaGroupScreen: mockScreen('group') }));
jest.mock('@/features/meta-feed/screens/calendar-screen', () => ({ CalendarScreen: mockScreen('calendar') }));
jest.mock('@/features/meta-feed/screens/news-screen', () => ({ NewsScreen: mockScreen('news') }));
jest.mock('@/features/meta-feed/screens/set-spotlight-screen', () => ({ SetSpotlightScreen: mockScreen('set') }));

function propsOf(name: string) {
  return JSON.parse(screen.getByTestId(`${name}-props`).props.children as string);
}

describe('meta feed routes', () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockPush.mockReset();
    mockUseLocalSearchParams.mockReset();
  });

  it('/meta parses filters, ignores junk, and wires back + group pushes', () => {
    mockUseLocalSearchParams.mockReturnValue({ game: 'onepiece', lane: 'bogus', window: '30' });
    render(<MetaRoute />);
    expect(propsOf('meta')).toEqual({ initialGame: 'onepiece' });

    fireEvent.press(screen.getByTestId('meta-group'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/meta/group/[groupKey]',
      params: { game: 'pokemon', groupKey: 'modern:raw:sir', lane: 'raw', window: '30' },
    });
    fireEvent.press(screen.getByTestId('meta-back'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('/meta/group/[groupKey] parses the group, game, window and lane, and opens cards', () => {
    mockUseLocalSearchParams.mockReturnValue({ game: 'pokemon', groupKey: 'modern:raw:sir', lane: 'graded', window: '7' });
    render(<MetaGroupRoute />);
    expect(propsOf('group')).toEqual({
      game: 'pokemon', groupKey: 'modern:raw:sir', lane: 'graded', mineOnly: false, windowDays: 7,
    });

    fireEvent.press(screen.getByTestId('group-card'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/cards/[cardId]', params: { cardId: 'sm7-1' } });
    fireEvent.press(screen.getByTestId('group-back'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('/calendar opens a set event on its spotlight page', () => {
    mockUseLocalSearchParams.mockReturnValue({});
    render(<CalendarRoute />);
    fireEvent.press(screen.getByTestId('calendar-event'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/set-spotlight/[setId]', params: { setId: 'cel25' } });
  });

  it('/news passes kind and game', () => {
    mockUseLocalSearchParams.mockReturnValue({ kind: 'video' });
    render(<NewsRoute />);
    expect(propsOf('news')).toEqual({ initialGame: null, initialKind: 'video' });
  });

  it('/set-spotlight/[setId] passes the set id; "current" means this week\'s pick', () => {
    mockUseLocalSearchParams.mockReturnValue({ setId: 'cel25' });
    const { unmount } = render(<SetSpotlightRoute />);
    expect(propsOf('set')).toEqual({ setId: 'cel25' });
    unmount();

    mockUseLocalSearchParams.mockReturnValue({ setId: 'current' });
    render(<SetSpotlightRoute />);
    expect(propsOf('set')).toEqual({ setId: null });
  });
});

describe('meta feed routes with the market blocks switched off', () => {
  const FLAG = 'EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS';

  beforeEach(() => {
    process.env[FLAG] = '0';
    mockUseLocalSearchParams.mockReturnValue({ game: 'pokemon', groupKey: 'modern:raw:sir', setId: 'cel25' });
  });

  afterEach(() => {
    delete process.env[FLAG];
  });

  it.each([
    ['/meta', MetaRoute, 'meta'],
    ['/meta/group/[groupKey]', MetaGroupRoute, 'group'],
    ['/calendar', CalendarRoute, 'calendar'],
    ['/news', NewsRoute, 'news'],
    ['/set-spotlight/[setId]', SetSpotlightRoute, 'set'],
  ])('%s sends a deep link back to the feed without mounting the page', (_path, Route, name) => {
    render(<Route />);
    expect(screen.getByTestId('redirect').props.children).toBe('/social');
    expect(screen.queryByTestId(`${name}-props`)).toBeNull();
  });
});

// The market sections default off in every build; the tests above that exercise
// them switch them on here (the "switched off" suites set '0' after this runs).
beforeEach(() => {
  process.env.EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS = '1';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS;
});
