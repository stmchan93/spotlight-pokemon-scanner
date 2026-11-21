import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { LoadDeadlineError, settleWithin, withLoadDeadline } from '@/lib/load-deadline';
import { FOREGROUND_REFETCH_STALE_MS, useForegroundRefetch, type ForegroundRefetchOptions } from '@/lib/use-foreground-refetch';

describe('useForegroundRefetch', () => {
  let listener: ((state: AppStateStatus) => void) | null = null;

  const originalAddEventListener = AppState.addEventListener;

  beforeEach(() => {
    listener = null;
    AppState.addEventListener = ((_type: string, handler: (state: AppStateStatus) => void) => {
      listener = handler;
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener;
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  });

  afterEach(() => {
    AppState.addEventListener = originalAddEventListener;
    jest.restoreAllMocks();
  });

  function cycleToForeground() {
    act(() => {
      listener?.('background');
      listener?.('active');
    });
  }

  function mount(options: ForegroundRefetchOptions) {
    return renderHook((props: ForegroundRefetchOptions) => useForegroundRefetch(props), { initialProps: options });
  }

  it('refetches on return to the foreground after a failed load', () => {
    const onRefetch = jest.fn();
    mount({ failed: true, lastLoadedAt: null, onRefetch });
    cycleToForeground();
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT refetch a fresh, successful load', () => {
    const onRefetch = jest.fn();
    mount({ failed: false, lastLoadedAt: Date.now(), onRefetch });
    cycleToForeground();
    expect(onRefetch).not.toHaveBeenCalled();
  });

  it('refetches a successful load once it is stale', () => {
    const onRefetch = jest.fn();
    mount({ failed: false, lastLoadedAt: Date.now() - FOREGROUND_REFETCH_STALE_MS - 1, onRefetch });
    cycleToForeground();
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while disabled or while a load is already in flight', () => {
    const onRefetch = jest.fn();
    const { rerender } = mount({ enabled: false, failed: true, lastLoadedAt: null, onRefetch });
    cycleToForeground();
    rerender({ failed: true, isLoading: true, lastLoadedAt: null, onRefetch });
    cycleToForeground();
    expect(onRefetch).not.toHaveBeenCalled();
  });

  it('ignores an active → active repeat (no hammering)', () => {
    const onRefetch = jest.fn();
    mount({ failed: true, lastLoadedAt: null, onRefetch });
    act(() => {
      listener?.('active');
    });
    expect(onRefetch).not.toHaveBeenCalled();
  });
});

describe('load deadline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('withLoadDeadline rejects a hung load at the deadline', async () => {
    const hung = new Promise<string>(() => undefined);
    const outcome = withLoadDeadline(hung, 20_000).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toBeInstanceOf(LoadDeadlineError);
  });

  it('settleWithin reports the timeout without rejecting, and passes values through', async () => {
    const hung = new Promise<string>(() => undefined);
    const timedOut = settleWithin(hung, 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await timedOut).toEqual({ timedOut: true });
    expect(await settleWithin(Promise.resolve('ok'))).toEqual({ timedOut: false, value: 'ok' });
    expect(jest.getTimerCount()).toBe(0);
  });
});
