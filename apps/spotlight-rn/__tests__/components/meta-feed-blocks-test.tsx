import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import {
  mockHotCards,
  mockMetaPulse,
  mockNewsFeed,
  mockSetSpotlight,
  type MetaGroup,
} from '@spotlight/api-client';
import { DeltaPill, LaneTag, SpotlightThemeProvider } from '@spotlight/design-system';

import {
  HotCardsBlock,
  hotCardAttentionLabel,
} from '@/features/meta-feed/components/hot-cards-block';
import {
  MetaPulseBlock,
  metaPulseCaption,
  metaPulseFeedGroups,
} from '@/features/meta-feed/components/meta-pulse-block';
import { NewsBlock, newsItemChips } from '@/features/meta-feed/components/news-block';
import { SetSpotlightBlock } from '@/features/meta-feed/components/set-spotlight-block';

function renderThemed(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function group(key: string, medianChangePercent: number): MetaGroup {
  return { ...mockMetaPulse.groups[0], groupKey: key, medianChangePercent };
}

describe('MetaPulseBlock', () => {
  it('shows the top risers plus the biggest cooler', () => {
    const groups = [group('a', 20), group('b', 10), group('c', 5), group('d', -1), group('e', -9)];
    expect(metaPulseFeedGroups(groups).map((g) => g.groupKey)).toEqual(['a', 'b', 'e']);
    // One-directional weeks just show the first three.
    expect(metaPulseFeedGroups(groups.slice(0, 3)).map((g) => g.groupKey)).toEqual(['a', 'b', 'c']);
    expect(metaPulseFeedGroups([group('x', -1), group('y', -2)]).map((g) => g.groupKey)).toEqual(['x', 'y']);
  });

  it('names the game, window and lanes in the caption', () => {
    expect(metaPulseCaption(mockMetaPulse)).toBe('Pokémon · past 7 days');
    expect(metaPulseCaption({ ...mockMetaPulse, groups: mockMetaPulse.groups.filter((g) => g.lane === 'raw') }))
      .toBe('Pokémon · past 7 days');
  });

  it('renders the headline and three tagged group rows, and opens the meta page', () => {
    const onOpenMeta = jest.fn();
    renderThemed(<MetaPulseBlock onOpenMeta={onOpenMeta} pulse={mockMetaPulse} />);

    expect(screen.getByText('Meta pulse')).toBeTruthy();
    expect(screen.getByText('Vintage low-pop is running. Modern chase cards are cooling.')).toBeTruthy();
    expect(screen.getByText('+18.4%')).toBeTruthy();
    expect(screen.getByText('−4.1%')).toBeTruthy();
    expect(screen.getByText('+$412k value')).toBeTruthy();
    expect(screen.getByText('GRADED')).toBeTruthy();
    expect(screen.getAllByText('RAW')).toHaveLength(2);
    expect(screen.getByTestId('meta-pulse-group-modern:raw:sir-icon-down')).toBeTruthy();

    fireEvent.press(screen.getByTestId('meta-pulse-header-action'));
    expect(onOpenMeta).toHaveBeenCalledWith(mockMetaPulse);
  });

  it('renders nothing without groups, and nothing for a disabled read', () => {
    const { toJSON, rerender } = renderThemed(<MetaPulseBlock pulse={{ ...mockMetaPulse, groups: [] }} />);
    expect(toJSON()).toBeNull();
    rerender(<SpotlightThemeProvider><MetaPulseBlock pulse={null} /></SpotlightThemeProvider>);
    expect(toJSON()).toBeNull();
  });

  it('draws its closing band only when asked', () => {
    const { rerender } = renderThemed(<MetaPulseBlock pulse={mockMetaPulse} />);
    expect(StyleSheet.flatten(screen.getByTestId('meta-pulse').props.style).borderBottomWidth).toBe(4);
    rerender(<SpotlightThemeProvider><MetaPulseBlock pulse={mockMetaPulse} showBand={false} /></SpotlightThemeProvider>);
    expect(StyleSheet.flatten(screen.getByTestId('meta-pulse').props.style).borderBottomWidth).toBe(0);
  });
});

describe('HotCardsBlock', () => {
  it('labels attention as a multiple of usual, or a head count when flat', () => {
    expect(hotCardAttentionLabel({ baselineRatio: 4.2, distinctUsers: 38 })).toBe('4.2× usual checks');
    expect(hotCardAttentionLabel({ baselineRatio: 1, distinctUsers: 7 })).toBe('7 collectors checking');
  });

  it('renders ranked tiles and opens a tapped card', () => {
    const onPressCard = jest.fn();
    renderThemed(<HotCardsBlock hot={mockHotCards} onPressCard={onPressCard} />);

    expect(screen.getByText('Hot on Ekalight')).toBeTruthy();
    expect(screen.getByText('most checked · 24h')).toBeTruthy();
    expect(screen.getByText('4.2× usual checks')).toBeTruthy();
    expect(screen.getByTestId('hot-cards-tile-pop5-17-rank')).toBeTruthy();
    expect(screen.getByText('−6.0%')).toBeTruthy();

    fireEvent.press(screen.getByTestId('hot-cards-tile-pop5-17'));
    expect(onPressCard).toHaveBeenCalledWith('pop5-17');
  });

  // Hidden until the app has enough traffic to trust the ranking.
  it('renders nothing for an ineligible payload', () => {
    const { toJSON } = renderThemed(<HotCardsBlock hot={{ ...mockHotCards, eligible: false }} />);
    expect(toJSON()).toBeNull();
  });
});

describe('SetSpotlightBlock', () => {
  it('renders the set header, top three rows and the video rail', () => {
    const onOpenSet = jest.fn();
    const onOpenLink = jest.fn();
    const onPressCard = jest.fn();
    renderThemed(
      <SetSpotlightBlock
        onOpenLink={onOpenLink}
        onOpenSet={onOpenSet}
        onPressCard={onPressCard}
        spotlight={mockSetSpotlight}
      />,
    );

    expect(screen.getByText('Celebrations')).toBeTruthy();
    expect(screen.getByText('Top 10 by price · 25th anniversary · 2021')).toBeTruthy();
    expect(screen.getByText('$168.40')).toBeTruthy();
    expect(screen.getByText('Watch')).toBeTruthy();
    expect(screen.getByText('18:42')).toBeTruthy();

    fireEvent.press(screen.getByTestId('set-spotlight-header-action'));
    expect(onOpenSet).toHaveBeenCalledWith('cel25');
    fireEvent.press(screen.getByTestId('set-spotlight-row-cel25c-4_A'));
    expect(onPressCard).toHaveBeenCalledWith('cel25c-4_A');
    fireEvent.press(screen.getByTestId('set-spotlight-video-yt-cel25-1'));
    expect(onOpenLink).toHaveBeenCalledWith('https://www.youtube.com/watch?v=mock-cel25-1');
  });

  it('drops the video rail when there are no videos', () => {
    renderThemed(<SetSpotlightBlock spotlight={{ ...mockSetSpotlight, videos: [] }} />);
    expect(screen.getByText('Celebrations')).toBeTruthy();
    expect(screen.queryByText('Watch')).toBeNull();
    expect(screen.queryByTestId('set-spotlight-videos')).toBeNull();
  });

  it('renders nothing without priced cards', () => {
    const { toJSON } = renderThemed(<SetSpotlightBlock spotlight={{ ...mockSetSpotlight, topByPrice: [] }} />);
    expect(toJSON()).toBeNull();
  });
});

describe('NewsBlock', () => {
  it('leads the chips with the game and caps them at three', () => {
    expect(newsItemChips({ game: 'pokemon', tags: ['Set reveal'] })).toEqual(['Pokémon', 'Set reveal']);
    expect(newsItemChips({ game: null, tags: ['Market', 'Vintage', 'Weekly', 'Extra'] }))
      .toEqual(['Market', 'Vintage', 'Weekly']);
  });

  it('shows three headlines and links out on tap', () => {
    const onOpenLink = jest.fn();
    const onOpenNews = jest.fn();
    renderThemed(<NewsBlock feed={mockNewsFeed} onOpenLink={onOpenLink} onOpenNews={onOpenNews} />);

    expect(screen.getByText('Card news')).toBeTruthy();
    expect(screen.getAllByTestId(/^card-news-row-[^-]+-[^-]+-\d$/)).toHaveLength(3);
    expect(screen.getByText('Official ban list update')).toBeTruthy();

    fireEvent.press(screen.getByTestId('card-news-row-news-opgg-1'));
    expect(onOpenLink).toHaveBeenCalledWith('https://onepiece.gg/mock-ban-list');
    fireEvent.press(screen.getByTestId('card-news-header-action'));
    expect(onOpenNews).toHaveBeenCalled();
  });

  it('renders nothing for an empty feed', () => {
    const { toJSON } = renderThemed(<NewsBlock feed={{ items: [], nextCursor: null }} />);
    expect(toJSON()).toBeNull();
  });
});

describe('meta feed primitives', () => {
  it('tints LaneTag by lane', () => {
    renderThemed(
      <>
        <LaneTag lane="graded" testID="graded" />
        <LaneTag label="PSA 10" lane="graded" testID="psa" />
        <LaneTag lane="raw" testID="raw" />
      </>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('graded').props.style).backgroundColor).toBe('#1A1A1A');
    expect(StyleSheet.flatten(screen.getByTestId('raw').props.style).backgroundColor).toBe('#F2F2F2');
    expect(screen.getByText('PSA 10')).toBeTruthy();
  });

  it('tints DeltaPill on the delta ramp', () => {
    renderThemed(
      <>
        <DeltaPill changePercent={3} label="+3.0%" testID="up" />
        <DeltaPill changePercent={-3} label="−3.0%" testID="down" />
        <DeltaPill changePercent={null} label="—" testID="flat" />
      </>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('up').props.style).backgroundColor).toBe('#E2F4E8');
    expect(StyleSheet.flatten(screen.getByTestId('down').props.style).backgroundColor).toBe('#FFE9E9');
    expect(StyleSheet.flatten(screen.getByTestId('flat').props.style).backgroundColor).toBe('#F2F2F2');
  });
});
