import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { TopMoverItem, TopMovers } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import {
  TopTrendsBlock,
  formatChangeLabel,
  formatMoverSubtitle,
  hasTopTrendsContent,
  toTopMoverTileProps,
  topTrendsSlides,
} from '@/features/social/components/top-trends-block';

function buildItem(overrides: Partial<TopMoverItem> = {}): TopMoverItem {
  return {
    cardId: 'sv8-238',
    game: 'pokemon',
    name: 'Pikachu ex',
    number: '238',
    setCode: 'SV8',
    setName: 'Surging Sparks',
    language: 'English',
    imageUrl: null,
    priceNow: 41.16,
    priceThen: 12.95,
    changePercent: 217.9,
    currencyCode: 'USD',
    sparkPoints: [12.95, 20, 33.5, 41.16],
    ...overrides,
  };
}

function buildMovers(games: TopMovers['games']): TopMovers {
  return {
    windowDays: 30,
    computedAt: '2026-05-01T00:00:00.000Z',
    asOfDate: '2026-05-01',
    games,
  };
}

function renderBlock(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

describe('TopTrendsBlock labels', () => {
  // One decimal in the normal range, none once the move is three digits — the
  // decimal stops meaning anything there and pushes the chip over its width.
  it('formats the change with one decimal below 100% and none at or above', () => {
    expect(formatChangeLabel(12.5)).toBe('+12.5%');
    expect(formatChangeLabel(12)).toBe('+12.0%');
    expect(formatChangeLabel(217.9)).toBe('+218%');
    expect(formatChangeLabel(100)).toBe('+100%');
    expect(formatChangeLabel(-11.34)).toBe('-11.3%');
    expect(formatChangeLabel(-150.2)).toBe('-150%');
    expect(formatChangeLabel(0)).toBe('0.0%');
  });

  it('joins set code and set name, dropping whichever is missing', () => {
    expect(formatMoverSubtitle({ setCode: 'SV8', setName: 'Surging Sparks', language: 'English' }))
      .toBe('SV8 · Surging Sparks');
    expect(formatMoverSubtitle({ setCode: null, setName: 'Surging Sparks', language: 'English' }))
      .toBe('Surging Sparks');
    expect(formatMoverSubtitle({ setCode: 'SV8', setName: null, language: null }))
      .toBe('SV8');
    expect(formatMoverSubtitle({ setCode: null, setName: null, language: null }))
      .toBe('');
  });

  // A JP mover must never be mistaken for its (usually pricier) English twin.
  it('marks a Japanese printing', () => {
    expect(formatMoverSubtitle({ setCode: 'SV8a', setName: 'Terastal Festival', language: 'Japanese' }))
      .toBe('SV8a · Terastal Festival · JP');
    expect(formatMoverSubtitle({ setCode: null, setName: null, language: 'Japanese' }))
      .toBe('JP');
  });

  it('maps a mover onto the tile with formatted prices and a from-label', () => {
    const onPressCard = jest.fn();
    const tile = toTopMoverTileProps(buildItem(), onPressCard, 'trends');

    expect(tile).toMatchObject({
      key: 'pokemon:sv8-238',
      name: 'Pikachu ex',
      subtitle: 'SV8 · Surging Sparks',
      changeLabel: '+218%',
      changePercent: 217.9,
      priceLabel: '$41.16',
      fromLabel: 'from $12.95',
      sparkPoints: [12.95, 20, 33.5, 41.16],
      testID: 'trends-tile-sv8-238',
    });
    tile.onPress?.();
    expect(onPressCard).toHaveBeenCalledWith('sv8-238');
  });

  it('honours the payload currency', () => {
    const tile = toTopMoverTileProps(
      buildItem({ priceNow: 1100, priceThen: 1240.5, currencyCode: 'EUR' }),
      undefined,
      'trends',
    );
    expect(tile.priceLabel).toBe('€1,100.00');
    expect(tile.fromLabel).toBe('from €1,240.50');
    expect(tile.onPress).toBeUndefined();
  });
});

describe('TopTrendsBlock', () => {
  it('renders nothing with no payload and no read in flight', () => {
    renderBlock(<TopTrendsBlock loading={false} movers={null} testID="trends" />);
    expect(screen.queryByTestId('trends')).toBeNull();
    expect(hasTopTrendsContent(null, false)).toBe(false);
  });

  it('renders nothing when every game is empty', () => {
    const movers = buildMovers([{ game: 'pokemon', items: [] }, { game: 'lorcana', items: [] }]);
    renderBlock(<TopTrendsBlock loading={false} movers={movers} testID="trends" />);
    expect(screen.queryByTestId('trends')).toBeNull();
    expect(hasTopTrendsContent(movers, false)).toBe(false);
  });

  it('renders nothing while the first read is in flight — no placeholder that can vanish', () => {
    renderBlock(<TopTrendsBlock loading movers={null} testID="trends" />);
    expect(screen.queryByTestId('trends')).toBeNull();
    expect(screen.queryByText('Top Trends')).toBeNull();
    expect(hasTopTrendsContent(null, true)).toBe(false);
  });

  it('shows ONE carousel: each game\'s top gainer, biggest gain first', () => {
    const movers = buildMovers([
      { game: 'pokemon', items: [buildItem({ changePercent: 40 }), buildItem({ cardId: 'p2', changePercent: 30 })] },
      { game: 'onepiece', items: [] },
      { game: 'lorcana', items: [buildItem({ game: 'lorcana', cardId: 'lor-1', changePercent: 90 })] },
      { game: 'gundam', items: [buildItem({ game: 'gundam', cardId: 'gd-1', changePercent: 55 })] },
    ]);
    expect(topTrendsSlides(movers).map((slide) => `${slide.game}:${slide.item.cardId}`)).toEqual([
      'lorcana:lor-1',
      'gundam:gd-1',
      'pokemon:sv8-238',
    ]);

    renderBlock(<TopTrendsBlock autoAdvanceIntervalMs={0} loading={false} movers={movers} testID="trends" />);
    expect(screen.getAllByTestId(/^trends-rail$/)).toHaveLength(1);
    const tiles = screen.getAllByTestId(/^trends-tile-(?!.*-(art|image|change|sparkline)$).+$/);
    expect(tiles.map((tile) => tile.props.testID)).toEqual([
      'trends-tile-lor-1',
      'trends-tile-gd-1',
      'trends-tile-sv8-238',
    ]);
    // The caption names the game on screen — the biggest mover's, to start.
    expect(screen.getByTestId('trends-rail-caption').props.children).toBe('Disney Lorcana');
    expect(screen.queryByText('One Piece')).toBeNull();
    expect(screen.getByText('past 30 days')).toBeTruthy();
  });

  it('flips to the next game every interval and wraps, with the caption following', () => {
    jest.useFakeTimers();
    try {
      const movers = buildMovers([
        { game: 'pokemon', items: [buildItem({ changePercent: 40 })] },
        { game: 'onepiece', items: [buildItem({ game: 'onepiece', cardId: 'op-1', changePercent: 80 })] },
      ]);
      renderBlock(
        <TopTrendsBlock autoAdvanceIntervalMs={5_000} loading={false} movers={movers} testID="trends" />,
      );
      const caption = () => screen.getByTestId('trends-rail-caption').props.children;
      expect(caption()).toBe('One Piece');
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      expect(caption()).toBe('Pokémon');
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      expect(caption()).toBe('One Piece');
    } finally {
      jest.useRealTimers();
    }
  });

  it('follows a manual swipe', () => {
    const movers = buildMovers([
      { game: 'pokemon', items: [buildItem({ changePercent: 40 })] },
      { game: 'onepiece', items: [buildItem({ game: 'onepiece', cardId: 'op-1', changePercent: 80 })] },
    ]);
    renderBlock(<TopTrendsBlock autoAdvanceIntervalMs={0} loading={false} movers={movers} testID="trends" />);
    // Offsets count the head CLONE as slot 0: 362 is the first real tile
    // (One Piece), 724 the second.
    fireEvent(screen.getByTestId('trends-rail-scroll'), 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 724, y: 0 } },
    });
    expect(screen.getByTestId('trends-rail-caption').props.children).toBe('Pokémon');
  });

  it('loops: a swipe past the last tile lands on the first, and past the first on the last', () => {
    const movers = buildMovers([
      { game: 'pokemon', items: [buildItem({ changePercent: 40 })] },
      { game: 'onepiece', items: [buildItem({ game: 'onepiece', cardId: 'op-1', changePercent: 80 })] },
    ]);
    renderBlock(<TopTrendsBlock autoAdvanceIntervalMs={0} loading={false} movers={movers} testID="trends" />);
    const caption = () => screen.getByTestId('trends-rail-caption').props.children;
    const scroll = screen.getByTestId('trends-rail-scroll');
    // Rests one slot in, so the clone before the first tile is off screen.
    expect(scroll.props.contentOffset).toEqual({ x: 362, y: 0 });
    // Only the two real tiles carry testIDs — the clones are scaffolding.
    expect(screen.getAllByTestId(/^trends-tile-(?!.*-(art|image|change|sparkline)$).+$/)).toHaveLength(2);

    // Forward off Pokémon (slot 2, the last real tile) onto the tail clone (slot 3) → One Piece.
    fireEvent(scroll, 'momentumScrollEnd', { nativeEvent: { contentOffset: { x: 3 * 362, y: 0 } } });
    expect(caption()).toBe('One Piece');
    // Back off One Piece (slot 1) onto the head clone (slot 0) → Pokémon.
    fireEvent(scroll, 'momentumScrollEnd', { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
    expect(caption()).toBe('Pokémon');
  });

  it('closes with the 4pt gray100 band by default, and not when told to hand it off', () => {
    const movers = buildMovers([{ game: 'pokemon', items: [buildItem()] }]);
    const { rerender } = renderBlock(
      <TopTrendsBlock autoAdvanceIntervalMs={0} loading={false} movers={movers} testID="trends" />,
    );
    let style = StyleSheet.flatten(screen.getByTestId('trends').props.style);
    expect(style.borderBottomWidth).toBe(4);
    expect(style.borderBottomColor).toBe('#F2F2F2');
    expect(style.paddingTop).toBe(16);
    expect(style.paddingBottom).toBe(16);

    rerender(
      <SpotlightThemeProvider>
        <TopTrendsBlock autoAdvanceIntervalMs={0} loading={false} movers={movers} showBand={false} testID="trends" />
      </SpotlightThemeProvider>,
    );
    style = StyleSheet.flatten(screen.getByTestId('trends').props.style);
    expect(style.borderBottomWidth).toBe(0);
  });

  it('reports the tapped mover by card id', () => {
    const onPressCard = jest.fn();
    const movers = buildMovers([{ game: 'pokemon', items: [buildItem()] }]);
    renderBlock(
      <TopTrendsBlock autoAdvanceIntervalMs={0} loading={false} movers={movers} onPressCard={onPressCard} testID="trends" />,
    );

    fireEvent.press(screen.getByTestId('trends-tile-sv8-238'));
    expect(onPressCard).toHaveBeenCalledWith('sv8-238');
  });
});
