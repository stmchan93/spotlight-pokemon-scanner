import { fireEvent, screen } from '@testing-library/react-native';

import type {
  MetaExposure,
  MetaExposureQuery,
  MetaGroupDetail,
  MetaGroupDetailQuery,
} from '@spotlight/api-client';
import { MetaGroupScreen } from '@/features/meta-feed/screens/meta-group-screen';

import { mockMetaExposure, mockMetaGroupDetail } from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

const GROUP_KEY = 'vintage:graded:psa10:pop_le_50';

function renderGroup({
  fetchMetaGroupDetail = async (query) => mockMetaGroupDetail(query.groupKey),
  fetchMetaExposure = async () => mockMetaExposure,
  groupKey = GROUP_KEY,
}: {
  fetchMetaGroupDetail?: (query: MetaGroupDetailQuery) => Promise<MetaGroupDetail | null>;
  fetchMetaExposure?: (query?: MetaExposureQuery) => Promise<MetaExposure | null>;
  groupKey?: string;
} = {}) {
  const onBack = jest.fn();
  const onOpenCard = jest.fn();
  renderWithProviders(
    <MetaGroupScreen game="pokemon" groupKey={groupKey} onBack={onBack} onOpenCard={onOpenCard} windowDays={7} />,
    { spotlightRepository: createTestSpotlightRepository({ fetchMetaExposure, fetchMetaGroupDetail }) },
  );
  return { onBack, onOpenCard };
}

describe('MetaGroupScreen', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads the group for the route params', async () => {
    const fetchMetaGroupDetail = jest.fn(async (query: MetaGroupDetailQuery) => mockMetaGroupDetail(query.groupKey));
    renderGroup({ fetchMetaGroupDetail });
    await screen.findByTestId('meta-group-content');
    expect(fetchMetaGroupDetail).toHaveBeenCalledWith({ game: 'pokemon', groupKey: GROUP_KEY, lane: undefined, windowDays: 7 });
  });

  it('renders the header: direction, name, description, move and chart', async () => {
    renderGroup();
    expect(await screen.findByText('Vintage PSA 10 · low pop')).toBeTruthy();
    expect(screen.getByText('ON THE WAY UP · PAST 7 DAYS')).toBeTruthy();
    expect(screen.getByText('PSA 10s from before 2003 with 50 or fewer graded')).toBeTruthy();
    expect(screen.getByTestId('meta-group-change').props.children).toBe('+18.4%');
    expect(screen.getByTestId('meta-group-value').props.children).toBe('+$412k');
    expect(screen.getByTestId('meta-group-chart')).toBeTruthy();
  });

  it('shows two of your cards, then all of them on "See all"', async () => {
    const { onOpenCard } = renderGroup();
    await screen.findByTestId('meta-group-owned');
    expect(screen.getByText('Your cards in this group')).toBeTruthy();
    expect(screen.getAllByTestId(/^meta-group-owned-[a-z0-9]+-\d+$/)).toHaveLength(2);

    fireEvent.press(screen.getByTestId('meta-group-owned-see-all'));
    expect(screen.getAllByTestId(/^meta-group-owned-[a-z0-9]+-\d+$/)).toHaveLength(4);
    expect(screen.queryByTestId('meta-group-owned-see-all')).toBeNull();

    fireEvent.press(screen.getByTestId('meta-group-owned-neo1-9'));
    expect(onOpenCard).toHaveBeenCalledWith('neo1-9');
  });

  it('lists the biggest movers and tags the ones you own', async () => {
    const { onOpenCard } = renderGroup();
    await screen.findByTestId('meta-group-movers');
    expect(screen.getByText('Biggest movers')).toBeTruthy();
    expect(screen.getByText('Latios ☆ · PSA 10')).toBeTruthy();
    expect(screen.getByText('Deoxys · pop 27')).toBeTruthy();
    expect(screen.getByText('$11,800.00')).toBeTruthy();
    expect(screen.getByTestId('meta-group-mover-ecard3-146-owned')).toBeTruthy();
    expect(screen.queryByTestId('meta-group-mover-ex8-106-owned')).toBeNull();

    fireEvent.press(screen.getByTestId('meta-group-mover-ex8-106'));
    expect(onOpenCard).toHaveBeenCalledWith('ex8-106');
  });

  it('hides "Your cards" when you own none of the group (or are signed out)', async () => {
    renderGroup({ fetchMetaExposure: async () => null });
    await screen.findByTestId('meta-group-movers');
    expect(screen.queryByTestId('meta-group-owned')).toBeNull();
    expect(screen.queryByText('In your collection')).toBeNull();
  });

  it('labels a cooling group and says so when the group is unavailable', async () => {
    renderGroup({ groupKey: 'modern:raw:sir' });
    expect(await screen.findByText('COOLING OFF · PAST 7 DAYS')).toBeTruthy();
  });

  it('shows the unavailable state for an unknown group', async () => {
    renderGroup({ fetchMetaGroupDetail: async () => null });
    expect(await screen.findByTestId('meta-group-disabled')).toBeTruthy();
  });
});
