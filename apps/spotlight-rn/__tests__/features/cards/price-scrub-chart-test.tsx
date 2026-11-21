import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import { PriceScrubChart, type PriceChartPoint } from '@/features/cards/components/price-scrub-chart';
import { buildPriceChartModel, priceChartRanges } from '@/features/cards/card-price-chart-model';
import {
  areaFillPath,
  morphFillPath,
  morphPath,
  nearestIndexByX,
  priceYDomain,
  projectPoints,
  resampleSeries,
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

  it('closes the area fill under the first and last points, not the chart corners', () => {
    expect(areaFillPath('M120.0 40.0 L300.0 60.0', 120, 300, 200)).toBe(
      'M120.0 40.0 L300.0 60.0 L300.0 200 L120.0 200 Z',
    );
    // History that also stops early closes under its own last point.
    expect(areaFillPath('M120.0 40.0 L250.0 60.0', 120, 250, 200)).toBe(
      'M120.0 40.0 L250.0 60.0 L250.0 200 L120.0 200 Z',
    );
    expect(areaFillPath('', 0, 300, 200)).toBe('');
  });

  it('morphs over each series\' own x extent: no flat lead-in from x=0', () => {
    const late = resampleSeries([{ x: 150, y: 10 }, { x: 300, y: 50 }], 4)!;
    const full = resampleSeries([{ x: 0, y: 30 }, { x: 300, y: 30 }], 4)!;
    expect([late.x0, late.x1]).toEqual([150, 300]);
    [10, 10 + 40 / 3, 10 + 80 / 3, 50].forEach((y, index) => expect(late.ys[index]).toBeCloseTo(y, 6));
    // Settled on the late series, the path starts at its first point.
    expect(morphPath(full, late, 1).startsWith('M150.0 10.0')).toBe(true);
    expect(morphPath(late, full, 0).startsWith('M150.0 10.0')).toBe(true);
    // Halfway, the start slides from 0 to 150.
    expect(morphPath(full, late, 0.5).startsWith('M75.0')).toBe(true);
    expect(morphFillPath(full, late, 1, 200).endsWith('L300.0 200 L150.0 200 Z')).toBe(true);
    expect(resampleSeries([{ x: 3, y: 3 }])).toBeNull();
  });

  it('keeps a minimum y span so tiny moves stay small', () => {
    const domain = priceYDomain([100, 100.5]);
    expect(domain.max - domain.min).toBeCloseTo(100.5 * 0.08);
  });

  it("'fit' scale blows up a small move, centered with room above and below", () => {
    const domain = priceYDomain([1700, 1712], 'fit');
    // The 12-point move takes the middle ~83% of the height (10% room above and below).
    expect(domain.min).toBeCloseTo(1698.8);
    expect(domain.max).toBeCloseTo(1713.2);
    // A flat series still gets a nonzero span.
    const flat = priceYDomain([1700, 1700], 'fit');
    expect(flat.max - flat.min).toBeGreaterThan(0);
  });

  it('clamps values outside an explicit y-domain to the plot edge', () => {
    const points = linePoints([100, 110, 5000]);
    const coords = projectPoints(points, START, END, 300, 200, 'padded', { min: 90, max: 120 });
    const top = coords[2].y;
    // The outlier sits on the plot's top edge (CHART_PAD_TOP), not off-canvas.
    expect(top).toBe(30);
    expect(coords[0].y).toBeGreaterThan(coords[1].y);
    expect(coords[1].y).toBeGreaterThan(top);
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

  it('renders line data with no end dot and no baseline at rest', () => {
    renderChart();
    expect(screen.getByTestId('price-scrub-chart-canvas')).toBeTruthy();
    expect(screen.queryByTestId('price-scrub-chart-baseline')).toBeNull();
    expect(screen.queryByTestId('price-scrub-chart-dot')).toBeNull();
    expect(screen.queryByTestId('price-scrub-chart-cursor')).toBeNull();
  });

  it('shows the dot under the finger only while scrubbing', () => {
    renderChart();
    const drag = getByGestureTestId('price-scrub-chart-drag');
    act(() => {
      drag.handlers.onStart?.({ x: 98 } as never);
    });
    expect(screen.getByTestId('price-scrub-chart-dot').props.cx).toBeCloseTo(100, 0);
    act(() => {
      drag.handlers.onUpdate?.({ x: 205 } as never);
    });
    expect(screen.getByTestId('price-scrub-chart-dot').props.cx).toBeCloseTo(200, 0);
    act(() => {
      drag.handlers.onEnd?.({} as never, true);
    });
    expect(screen.queryByTestId('price-scrub-chart-dot')).toBeNull();
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

  it.each(priceChartRanges)(
    '%s: partial history starts the line, fill and baseline under the first real point',
    (range) => {
      // 20 days of history ending today: covers 1W fully, starts late on 1M/3M/1Y.
      const nowMs = Date.UTC(2026, 10, 15, 12);
      const allPoints = Array.from({ length: 20 }, (_, index) => ({
        t: nowMs - (19 - index) * DAY,
        v: 10 + (index % 5),
      }));
      const model = buildPriceChartModel({ allPoints, variant: 'line', range, nowMs, currencyCode: 'USD' })!;
      render(
        <PriceScrubChart
          areaFill
          color="purple"
          fillGrid={false}
          onScrub={jest.fn()}
          points={model.points}
          variant="line"
          windowEndMs={model.windowEndMs}
          windowStartMs={model.windowStartMs}
        />,
      );
      fireEvent(screen.getByTestId('price-scrub-chart'), 'layout', {
        nativeEvent: { layout: { width: 300, height: 200, x: 0, y: 0 } },
      });

      const span = model.windowEndMs - model.windowStartMs;
      const expectedX = ((model.points[0].t - model.windowStartMs) / span) * 300;
      if (range === '1W') {
        expect(expectedX).toBe(0);
      } else {
        expect(expectedX).toBeGreaterThan(100);
      }
      const firstX = expectedX.toFixed(1);
      const fill: string = screen.getByTestId('price-scrub-chart-fill').props.d;
      // Line part starts AT the first point (no segment in from the left edge)…
      expect(fill.startsWith(`M${firstX} `)).toBe(true);
      // …and the polygon closes straight down under it, never via (0, bottom).
      expect(fill.endsWith(`L300.0 200 L${firstX} 200 Z`)).toBe(true);
      if (range !== '1W') {
        expect(fill).not.toMatch(/L0(\.0)? /);
      }
    },
  );

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
    expect(screen.getByTestId('price-scrub-chart-canvas')).toBeTruthy();
    expect(screen.queryByTestId('price-scrub-chart-dot')).toBeNull();
  });
});
