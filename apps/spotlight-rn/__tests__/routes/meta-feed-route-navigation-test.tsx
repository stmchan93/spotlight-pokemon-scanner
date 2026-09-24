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
    expect(propsOf('meta')).toEqual({ initialGame: 'onepiece', initialWindowDays: 30 });

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
    expect(propsOf('group')).toEqual({ game: 'pokemon', groupKey: 'modern:raw:sir', lane: 'graded', windowDays: 7 });

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
