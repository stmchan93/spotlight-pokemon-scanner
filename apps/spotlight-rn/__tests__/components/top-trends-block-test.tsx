import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { TopMoverItem, TopMovers } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import {
  TopTrendsBlock,
  formatChangeLabel,
  formatMoverSubtitle,
  hasTopTrendsContent,
  toTopMoverTileProps,
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

  it('holds a loading rail for every game while the first read is in flight', () => {
    renderBlock(<TopTrendsBlock loading movers={null} testID="trends" />);
    expect(screen.getByText('Top Trends')).toBeTruthy();
    expect(screen.getAllByTestId(/^trends-rail-[a-z]+$/)).toHaveLength(5);
    expect(hasTopTrendsContent(null, true)).toBe(true);
  });

  it('lists games in CARD_GAMES order, skipping the empty ones', () => {
    const movers = buildMovers([
      { game: 'lorcana', items: [buildItem({ game: 'lorcana', cardId: 'lor-1' })] },
      { game: 'onepiece', items: [] },
      { game: 'pokemon', items: [buildItem()] },
    ]);
    renderBlock(<TopTrendsBlock loading={false} movers={movers} testID="trends" />);

    const rails = screen.getAllByTestId(/^trends-rail-[a-z]+$/);
    expect(rails.map((rail) => rail.props.testID)).toEqual([
      'trends-rail-pokemon',
      'trends-rail-lorcana',
    ]);
    expect(screen.getByText('Pokémon')).toBeTruthy();
    expect(screen.getByText('Disney Lorcana')).toBeTruthy();
    expect(screen.queryByText('One Piece')).toBeNull();
    expect(screen.getByText('past 30 days')).toBeTruthy();
  });

  it('closes with the 4pt gray100 band by default, and not when told to hand it off', () => {
    const movers = buildMovers([{ game: 'pokemon', items: [buildItem()] }]);
    const { rerender } = renderBlock(
      <TopTrendsBlock loading={false} movers={movers} testID="trends" />,
    );
    let style = StyleSheet.flatten(screen.getByTestId('trends').props.style);
    expect(style.borderBottomWidth).toBe(4);
    expect(style.borderBottomColor).toBe('#F2F2F2');
    expect(style.paddingTop).toBe(16);
    expect(style.paddingBottom).toBe(16);

    rerender(
      <SpotlightThemeProvider>
        <TopTrendsBlock loading={false} movers={movers} showBand={false} testID="trends" />
      </SpotlightThemeProvider>,
    );
    style = StyleSheet.flatten(screen.getByTestId('trends').props.style);
    expect(style.borderBottomWidth).toBe(0);
  });

  it('reports the tapped mover by card id', () => {
    const onPressCard = jest.fn();
    const movers = buildMovers([{ game: 'pokemon', items: [buildItem()] }]);
    renderBlock(
      <TopTrendsBlock loading={false} movers={movers} onPressCard={onPressCard} testID="trends" />,
    );

    fireEvent.press(screen.getByTestId('trends-tile-sv8-238'));
    expect(onPressCard).toHaveBeenCalledWith('sv8-238');
  });
});
