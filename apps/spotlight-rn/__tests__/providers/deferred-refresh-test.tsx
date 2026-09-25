import { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { MockSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

import {
  AppProviders,
  DEFERRED_REFRESH_WINDOW_MS,
  useAppServices,
} from '@/providers/app-providers';
import { useDeferDataRefreshWhileFocused } from '@/providers/use-defer-data-refresh';

// Focus == mounted, blur == unmount: enough to drive the deferral lifecycle.
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  const { useEffect: useReactEffect } = jest.requireActual('react');
  return {
    ...actual,
    useFocusEffect: (effect: () => void | (() => void)) => {
      useReactEffect(effect, [effect]);
    },
  };
});

type Services = ReturnType<typeof useAppServices>;
let services: Services | null = null;

function Probe() {
  const current = useAppServices();
  useEffect(() => {
    services = current;
  });
  return <Text testID="data-version">{String(current.dataVersion)}</Text>;
}

function FocusedScanner() {
  useDeferDataRefreshWhileFocused();
  return null;
}

function renderProviders(scannerFocused: boolean) {
  const repository = new MockSpotlightRepository();
  const tree = (focused: boolean) => (
    <AppProviders spotlightRepository={repository}>
      <Probe />
      {focused ? <FocusedScanner /> : null}
    </AppProviders>
  );
  const view = render(tree(scannerFocused));
  return {
    setScannerFocused: (focused: boolean) => view.rerender(tree(focused)),
  };
}

function dataVersion() {
  return Number(screen.getByTestId('data-version').props.children);
}

describe('deferred refreshData', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    services = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('bumps immediately when no deferral is held (edits, deletes, pull-to-refresh)', () => {
    renderProviders(false);
    expect(dataVersion()).toBe(0);

    act(() => services!.refreshData());
    expect(dataVersion()).toBe(1);

    act(() => services!.refreshData());
    expect(dataVersion()).toBe(2);
  });

  it('coalesces a burst of refreshData calls on the focused scanner into one bump', () => {
    renderProviders(true);

    act(() => {
      for (let index = 0; index < 8; index += 1) {
        services!.refreshData();
      }
    });
    expect(dataVersion()).toBe(0);

    // Spaced adds inside the window still share the one bump.
    act(() => {
      jest.advanceTimersByTime(DEFERRED_REFRESH_WINDOW_MS - 1000);
      services!.refreshData();
    });
    expect(dataVersion()).toBe(0);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(dataVersion()).toBe(1);

    // Nothing pending → no further bumps.
    act(() => {
      jest.advanceTimersByTime(DEFERRED_REFRESH_WINDOW_MS * 3);
    });
    expect(dataVersion()).toBe(1);
  });

  it('flushes a pending refresh immediately when the scanner loses focus', () => {
    const { setScannerFocused } = renderProviders(true);

    act(() => {
      services!.refreshData();
      services!.refreshData();
    });
    expect(dataVersion()).toBe(0);

    act(() => setScannerFocused(false));
    expect(dataVersion()).toBe(1);

    // The flush cancelled the window timer: no second, late bump.
    act(() => {
      jest.advanceTimersByTime(DEFERRED_REFRESH_WINDOW_MS * 2);
    });
    expect(dataVersion()).toBe(1);

    // Off the scanner, refreshData is immediate again.
    act(() => services!.refreshData());
    expect(dataVersion()).toBe(2);
  });

  it('does not bump on blur when nothing is pending', () => {
    const { setScannerFocused } = renderProviders(true);
    act(() => setScannerFocused(false));
    expect(dataVersion()).toBe(0);
  });

  it('flushPendingRefresh bumps right away and is a no-op with nothing pending', () => {
    renderProviders(true);

    act(() => services!.flushPendingRefresh());
    expect(dataVersion()).toBe(0);

    act(() => services!.refreshData());
    expect(dataVersion()).toBe(0);
    act(() => services!.flushPendingRefresh());
    expect(dataVersion()).toBe(1);
  });

  it('drops the Insights performance cache only when the bump actually lands', () => {
    renderProviders(true);
    const performance = { marker: 'cached' } as unknown as NonNullable<Services['portfolioPerformanceCache']>;

    act(() => services!.setPortfolioPerformanceCache(performance));
    expect(services!.portfolioPerformanceCache).toBe(performance);

    act(() => services!.refreshData());
    expect(services!.portfolioPerformanceCache).toBe(performance);

    act(() => services!.flushPendingRefresh());
    expect(services!.portfolioPerformanceCache).toBeNull();
  });
});
