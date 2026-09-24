import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import {
  mockCalendarFeed,
  mockHotCards,
  mockMetaExposure,
  mockMetaPulse,
  mockNewsFeed,
  mockSetSpotlight,
  type MetaGroup,
} from '@spotlight/api-client';
import {
  CalendarEventRow,
  DeltaPill,
  LaneTag,
  MetaBarRow,
  MetaCalloutCard,
  SpotlightThemeProvider,
} from '@spotlight/design-system';

import { ComingUpBlock } from '@/features/meta-feed/components/coming-up-block';
import {
  HotCardsBlock,
  hotCardAttentionLabel,
} from '@/features/meta-feed/components/hot-cards-block';
import {
  MetaPulseBlock,
  hasMetaPulseContent,
  metaPulseCaption,
  metaPulseFeedGroups,
} from '@/features/meta-feed/components/meta-pulse-block';
import { NewsBlock, newsItemChips } from '@/features/meta-feed/components/news-block';
import { SetSpotlightBlock } from '@/features/meta-feed/components/set-spotlight-block';
import {
  calendarDateParts,
  calloutHighlight,
  groupBarFraction,
} from '@/features/meta-feed/screens/components/meta-format';

function renderThemed(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function group(key: string, medianChangePercent: number): MetaGroup {
  return { ...mockMetaPulse.groups[0], groupKey: key, medianChangePercent };
}

function barWidth(testID: string): string {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style).width as string;
}

describe('MetaPulseBlock', () => {
  it('picks exactly three risers (biggest first) and three coolers (biggest drop first)', () => {
    const groups = [
      group('a', 20), group('b', 10), group('c', 5), group('d', 2), group('flat', 0),
      group('e', -1), group('f', -3), group('g', -6), group('h', -9),
    ];
    const { risers, coolers } = metaPulseFeedGroups(groups);
    expect(risers.map((g) => g.groupKey)).toEqual(['a', 'b', 'c']);
    expect(coolers.map((g) => g.groupKey)).toEqual(['h', 'g', 'f']);
    // Fewer when fewer exist; a flat group is neither.
    const oneWay = metaPulseFeedGroups([group('x', 4), group('y', 0)]);
    expect(oneWay.risers.map((g) => g.groupKey)).toEqual(['x']);
    expect(oneWay.coolers).toEqual([]);
    expect(hasMetaPulseContent({ ...mockMetaPulse, groups: [group('y', 0)] })).toBe(false);
  });

  it('names the game and window in the caption', () => {
    expect(metaPulseCaption(mockMetaPulse)).toBe('Pokémon · past 7 days');
  });

  it('renders the headline, callout and 3 + 3 bar rows, and routes taps', () => {
    const onOpenMeta = jest.fn();
    const onOpenGroup = jest.fn();
    renderThemed(
      <MetaPulseBlock exposure={mockMetaExposure} onOpenGroup={onOpenGroup} onOpenMeta={onOpenMeta} pulse={mockMetaPulse} />,
    );

    expect(screen.getByText('Meta pulse')).toBeTruthy();
    expect(screen.getByText('Pokémon · past 7 days')).toBeTruthy();
    expect(screen.getByText('Vintage low-pop is running. Modern chase cards are cooling.')).toBeTruthy();
    expect(screen.getByText('ON THE WAY UP')).toBeTruthy();
    expect(screen.getByText('COOLING OFF')).toBeTruthy();

    const upRows = screen.getAllByTestId(/^meta-pulse-up-row-[^-]+$/);
    const downRows = screen.getAllByTestId(/^meta-pulse-down-row-[^-]+$/);
    expect(upRows.map((row) => row.props.testID)).toEqual([
      'meta-pulse-up-row-vintage:graded:psa10:pop_le_50',
      'meta-pulse-up-row-ex_era:raw:nm',
      'meta-pulse-up-row-promos:raw:jp',
    ]);
    expect(downRows.map((row) => row.props.testID)).toEqual([
      'meta-pulse-down-row-modern:raw:sir',
      'meta-pulse-down-row-vintage:raw:gold_star',
      'meta-pulse-down-row-modern:raw:ir',
    ]);

    // % bold + $ under it, and the owned tag from the exposure.
    expect(screen.getByText('+18.4%')).toBeTruthy();
    expect(screen.getByText('+$412k')).toBeTruthy();
    expect(screen.getByText('−4.1%')).toBeTruthy();
    expect(screen.getByText('−$188k')).toBeTruthy();
    expect(screen.getByText('You own 4')).toBeTruthy();
    expect(screen.getByText('You own 3')).toBeTruthy();
    expect(screen.queryByTestId('meta-pulse-up-row-ex_era:raw:nm-owned')).toBeNull();

    // Callout with the fanned art.
    expect(screen.getByTestId('meta-pulse-callout')).toBeTruthy();
    expect(screen.getByTestId('meta-pulse-callout-art')).toBeTruthy();
    expect(screen.getByText('4 PSA 10s and 11 raw cards in rising groups')).toBeTruthy();

    fireEvent.press(screen.getByTestId('meta-pulse-header-action'));
    expect(onOpenMeta).toHaveBeenCalledWith(mockMetaPulse);
    fireEvent.press(screen.getByTestId('meta-pulse-down-row-modern:raw:sir'));
    expect(onOpenGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupKey: 'modern:raw:sir' }),
      mockMetaPulse,
    );
  });

  it('scales every bar against the largest |%| of the six shown', () => {
    renderThemed(<MetaPulseBlock pulse={mockMetaPulse} />);
    // 18.4 is the full bar; the rest are |%| / 18.4 (mockup: 67%, 44%, 22%, 11%).
    expect(barWidth('meta-pulse-up-row-vintage:graded:psa10:pop_le_50-bar')).toBe('100%');
    expect(barWidth('meta-pulse-up-row-ex_era:raw:nm-bar')).toBe('67.4%');
    expect(barWidth('meta-pulse-up-row-promos:raw:jp-bar')).toBe('44%');
    expect(barWidth('meta-pulse-down-row-modern:raw:sir-bar')).toBe('22.3%');
    expect(barWidth('meta-pulse-down-row-modern:raw:ir-bar')).toBe('11.4%');
    expect(groupBarFraction(-9, 0)).toBe(0);
    expect(groupBarFraction(-9, 4.5)).toBe(1);
  });

  it('hides the callout and owned tags when signed out or nothing moved', () => {
    const { rerender } = renderThemed(<MetaPulseBlock exposure={null} pulse={mockMetaPulse} />);
    expect(screen.queryByTestId('meta-pulse-callout')).toBeNull();
    expect(screen.queryByText(/^You own/)).toBeNull();

    rerender(
      <SpotlightThemeProvider>
        <MetaPulseBlock exposure={{ ...mockMetaExposure, callout: null }} pulse={mockMetaPulse} />
      </SpotlightThemeProvider>,
    );
    expect(screen.queryByTestId('meta-pulse-callout')).toBeNull();
    expect(screen.getByText('You own 4')).toBeTruthy();

    // Exposure for another game never tags this game's rows.
    rerender(
      <SpotlightThemeProvider>
        <MetaPulseBlock exposure={{ ...mockMetaExposure, game: 'onepiece' }} pulse={mockMetaPulse} />
      </SpotlightThemeProvider>,
    );
    expect(screen.queryByTestId('meta-pulse-callout')).toBeNull();
    expect(screen.queryByText(/^You own/)).toBeNull();
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

describe('ComingUpBlock', () => {
  it('shows the next three dates with kind chips and routes taps', () => {
    const onOpenCalendar = jest.fn();
    const onOpenEvent = jest.fn();
    renderThemed(<ComingUpBlock feed={mockCalendarFeed} onOpenCalendar={onOpenCalendar} onOpenEvent={onOpenEvent} />);

    expect(screen.getByText('Coming up')).toBeTruthy();
    expect(screen.getAllByTestId(/^coming-up-event-.*-date$/)).toHaveLength(3);
    expect(screen.getByText('Delta Reign (English)')).toBeTruthy();
    expect(screen.getByText('Ban list')).toBeTruthy();
    expect(screen.getByText('Reveal')).toBeTruthy();
    expect(screen.getAllByText('SEP')).toHaveLength(2);
    expect(screen.getByText('03')).toBeTruthy();
    // The fourth date waits for the page.
    expect(screen.queryByText('Celebrations anniversary tournament')).toBeNull();

    fireEvent.press(screen.getByTestId('coming-up-header-action'));
    expect(onOpenCalendar).toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('coming-up-event-release-delta-reign-en'));
    expect(onOpenEvent).toHaveBeenCalledWith(mockCalendarFeed.items[0]);
  });

  it('renders nothing when empty or disabled', () => {
    const { toJSON, rerender } = renderThemed(<ComingUpBlock feed={{ items: [] }} />);
    expect(toJSON()).toBeNull();
    rerender(<SpotlightThemeProvider><ComingUpBlock feed={null} /></SpotlightThemeProvider>);
    expect(toJSON()).toBeNull();
  });
});

describe('meta feed v2 formatting', () => {
  it('reads calendar dates without a time-zone shift', () => {
    expect(calendarDateParts('2026-10-03')).toEqual({
      day: '03',
      month: 'OCT',
      monthKey: '2026-10',
      monthTitle: 'October 2026',
    });
    expect(calendarDateParts('bogus').month).toBe('');
  });

  it('finds the $ figure to tint in a callout title', () => {
    expect(calloutHighlight('Your vintage is up +$312 this week')).toBe('+$312');
    expect(calloutHighlight('Your SIRs are down −$1,204 this week')).toBe('−$1,204');
    expect(calloutHighlight('Your vintage is down $85 this week')).toBe('$85');
    expect(calloutHighlight('Nothing to tint')).toBeNull();
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

describe('meta feed v2 primitives', () => {
  it('MetaBarRow clamps the bar and colors it by direction', () => {
    renderThemed(
      <>
        <MetaBarRow barFraction={1.7} changeLabel="+9.0%" changePercent={9} label="Up" testID="up" />
        <MetaBarRow barFraction={-1} changeLabel="−2.0%" changePercent={-2} label="Down" testID="down" />
      </>,
    );
    const up = StyleSheet.flatten(screen.getByTestId('up-bar').props.style);
    const down = StyleSheet.flatten(screen.getByTestId('down-bar').props.style);
    expect(up.width).toBe('100%');
    expect(up.backgroundColor).toBe('#2D9148');
    expect(down.width).toBe('0%');
    expect(down.backgroundColor).toBe('#D93025');
    expect(StyleSheet.flatten(screen.getByTestId('up-change').props.style).color).toBe('#1E7A3C');
    expect(StyleSheet.flatten(screen.getByTestId('down-change').props.style).color).toBe('#B22416');
  });

  it('MetaCalloutCard tints only the highlighted figure', () => {
    renderThemed(
      <MetaCalloutCard highlight="+$312" testID="callout" title="Your vintage is up +$312 this week" />,
    );
    expect(screen.getByText('+$312')).toBeTruthy();
    expect(screen.queryByTestId('callout-art')).toBeNull();
  });

  it('CalendarEventRow tints the kind chip', () => {
    renderThemed(
      <>
        <CalendarEventRow dayLabel="26" kindLabel="Release" kindTone="release" monthLabel="SEP" testID="r" title="A" />
        <CalendarEventRow dayLabel="30" kindLabel="Ban list" kindTone="ban_list" monthLabel="SEP" testID="b" title="B" variant="full" subtitle="Sub" />
      </>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('r-kind').props.style).backgroundColor).toBe('#E2F4E8');
    expect(StyleSheet.flatten(screen.getByTestId('b-kind').props.style).backgroundColor).toBe('#FFE9E9');
    expect(screen.getByText('Sub')).toBeTruthy();
  });
});
