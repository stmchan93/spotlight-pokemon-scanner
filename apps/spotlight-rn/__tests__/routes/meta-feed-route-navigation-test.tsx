import { fireEvent, render, screen } from '@testing-library/react-native';

import MetaRoute from '@/app/(stack)/meta';
import NewsRoute from '@/app/(stack)/news';
import SetSpotlightRoute from '@/app/(stack)/set-spotlight/[setId]';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockUseLocalSearchParams = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

function mockScreen(name: string) {
  return function MockScreen(props: Record<string, unknown> & { onBack: () => void; onOpenCard: (cardId: string) => void }) {
    const { Pressable, Text } = require('react-native');
    const { onBack, onOpenCard, ...rest } = props;
    return (
      <>
        <Text testID={`${name}-props`}>{JSON.stringify(rest)}</Text>
        <Pressable onPress={onBack} testID={`${name}-back`} />
        <Pressable onPress={() => onOpenCard('sm7-1')} testID={`${name}-card`} />
      </>
    );
  };
}

jest.mock('@/features/meta-feed/screens/meta-screen', () => ({ MetaScreen: mockScreen('meta') }));
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

  it('/meta parses filters, ignores junk, and wires back + card pushes', () => {
    mockUseLocalSearchParams.mockReturnValue({ game: 'onepiece', lane: 'bogus', window: '30' });
    render(<MetaRoute />);
    expect(propsOf('meta')).toEqual({ initialGame: 'onepiece', initialWindowDays: 30 });

    fireEvent.press(screen.getByTestId('meta-card'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/cards/[cardId]', params: { cardId: 'sm7-1' } });
    fireEvent.press(screen.getByTestId('meta-back'));
    expect(mockBack).toHaveBeenCalled();
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
