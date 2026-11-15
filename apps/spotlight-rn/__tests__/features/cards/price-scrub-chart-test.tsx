import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import { PriceScrubChart, type PriceChartPoint } from '@/features/cards/components/price-scrub-chart';
import {
  nearestIndexByX,
  priceYDomain,
  resampleY,
  samePoints,
  salesGapThresholdMs,
  segmentPaths,
} from '@/features/cards/components/price-scrub-chart-geometry';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const END = START + 30 * DAY;

function linePoints(values: number[]): PriceChartPoint[] {
  return values.map((v, index) => ({ t: START + (index * 30 * DAY) / (values.length - 1), v }));
}

function renderChart(props: Partial<Parameters<typeof PriceScrubChart>[0]> = {}) {
  const onScrub = jest.fn();
  const utils = render(
    <PriceScrubChart
      color="green"
      onScrub={onScrub}
      points={linePoints([10, 12, 9, 14])}
      variant="line"
      windowEndMs={END}
      windowStartMs={START}
      {...props}
    />,
  );
  fireEvent(screen.getByTestId('price-scrub-chart'), 'layout', {
    nativeEvent: { layout: { width: 300, height: 200, x: 0, y: 0 } },
  });
  return { ...utils, onScrub };
}

describe('price-scrub-chart geometry', () => {
  it('finds the nearest index by x', () => {
    const xs = [0, 10, 20, 100];
    expect(nearestIndexByX(xs, -5)).toBe(0);
    expect(nearestIndexByX(xs, 4)).toBe(0);
    expect(nearestIndexByX(xs, 6)).toBe(1);
    expect(nearestIndexByX(xs, 59)).toBe(2);
    expect(nearestIndexByX(xs, 61)).toBe(3);
    expect(nearestIndexByX(xs, 500)).toBe(3);
    expect(nearestIndexByX([], 5)).toBe(-1);
  });

  it('dashes segments whose time gap exceeds the threshold', () => {
    const points = [{ t: 0 }, { t: 1 }, { t: 10 }, { t: 11 }];
    const coords = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 10, y: 2 },
      { x: 11, y: 3 },
    ];
    const { solid, dashed } = segmentPaths(points, coords, 5);
    expect(solid).toBe('M0.0 0.0 L1.0 1.0 M10.0 2.0 L11.0 3.0');
    expect(dashed).toBe('M1.0 1.0 L10.0 2.0');
  });

  it('dashes only gaps past 2 weeks, or a quarter of long windows', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(salesGapThresholdMs(30 * day)).toBe(14 * day);
    expect(salesGapThresholdMs(365 * day)).toBe(365 * day * 0.25);
  });

  it('resamples y evenly across the width', () => {
    const ys = resampleY(
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      100,
      5,
    );
    expect(ys).toEqual([0, 25, 50, 75, 100]);
    // Flat beyond the last point.
    expect(resampleY([{ x: 0, y: 4 }, { x: 50, y: 8 }], 100, 3)).toEqual([4, 8, 8]);
  });

  it('keeps a minimum y span so tiny moves stay small', () => {
    const domain = priceYDomain([100, 100.5]);
    expect(domain.max - domain.min).toBeCloseTo(100.5 * 0.08);
  });

  it("'fit' scale stretches a small move to the full height", () => {
    const domain = priceYDomain([1700, 1712], 'fit');
    expect(domain).toEqual({ min: 1700, max: 1712 });
    // A flat series still gets a nonzero span.
    const flat = priceYDomain([1700, 1700], 'fit');
    expect(flat.max - flat.min).toBeGreaterThan(0);
  });

  it('compares points by content', () => {
    expect(samePoints([{ t: 1, v: 2 }], [{ t: 1, v: 2 }])).toBe(true);
    expect(samePoints([{ t: 1, v: 2 }], [{ t: 1, v: 3 }])).toBe(false);
  });
});

describe('PriceScrubChart', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders an empty view for fewer than two points', () => {
    render(
      <PriceScrubChart
        color="green"
        onScrub={jest.fn()}
        points={[{ t: START, v: 1 }]}
        variant="line"
        windowEndMs={END}
        windowStartMs={START}
      />,
    );
    expect(screen.getByTestId('price-scrub-chart-empty')).toBeTruthy();
    expect(screen.queryByTestId('price-scrub-chart-canvas')).toBeNull();
  });

  it('renders line data with a baseline and end dot', () => {
    renderChart();
    expect(screen.getByTestId('price-scrub-chart-baseline')).toBeTruthy();
    expect(screen.getByTestId('price-scrub-chart-dot')).toBeTruthy();
    expect(screen.queryByTestId('price-scrub-chart-cursor')).toBeNull();
  });

  it('renders sales data', () => {
    renderChart({
      variant: 'sales',
      points: [
        { t: START + DAY, v: 10 },
        { t: START + 2 * DAY, v: 11 },
        { t: START + 25 * DAY, v: 9 },
      ],
    });
    expect(screen.getByTestId('price-scrub-chart-canvas')).toBeTruthy();
  });

  it('scrubs to the nearest point and releases with null', () => {
    const { onScrub } = renderChart();
    act(() => {
      fireGestureHandler(getByGestureTestId('price-scrub-chart-drag'), [
        { state: State.BEGAN, x: 0 },
        { state: State.ACTIVE, x: 98 },
        { x: 205 },
        { x: 290 },
        { state: State.END, x: 290 },
      ]);
    });
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(onScrub.mock.calls.map((call) => call[0])).toEqual([1, 2, 3, null]);
    // 12 → 9 crosses the baseline (10) once; 9 → 14 crosses again.
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('price-scrub-chart-cursor')).toBeNull();
  });

  it('ticks on every index change in the sales variant', () => {
    const { onScrub } = renderChart({
      variant: 'sales',
      points: linePoints([10, 11, 12, 13]),
    });
    act(() => {
      fireGestureHandler(getByGestureTestId('price-scrub-chart-drag'), [
        { state: State.BEGAN, x: 0 },
        { state: State.ACTIVE, x: 0 },
        { x: 100 },
        { x: 200 },
      ]);
    });
    // fireGestureHandler auto-completes the gesture, hence the trailing release.
    expect(onScrub.mock.calls.map((call) => call[0])).toEqual([0, 1, 2, null]);
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(2);
  });

  it('survives a line → line data change', () => {
    const { rerender } = renderChart();
    rerender(
      <PriceScrubChart
        color="red"
        onScrub={jest.fn()}
        points={linePoints([14, 12, 11, 8, 7])}
        variant="line"
        windowEndMs={END}
        windowStartMs={START}
      />,
    );
    expect(screen.getByTestId('price-scrub-chart-dot')).toBeTruthy();
  });
});
