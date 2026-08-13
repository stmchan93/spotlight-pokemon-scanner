import { act, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren, ReactElement } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { CardActionsSheet } from '@/features/cards/components/card-actions-sheet';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function Wrapper({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>{children}</SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

const renderInWrapper = (element: ReactElement) => render(element, { wrapper: Wrapper });

/*
  THE BUG THIS EXISTS FOR

  Long-pressing a Collection card and tapping Share or Delete did NOTHING on
  Android. Both actions are QUEUED by `portfolio-screen` and run from this
  sheet's `onDismiss` — the caller has to wait for the sheet to be gone, because
  presenting a follow-up sheet while this one is still tearing down freezes the
  screen on iOS.

  But `onDismiss` was wired straight to React Native's `Modal`, which calls it
  behind an explicit `Platform.OS === 'ios'` check
  (`react-native/Libraries/Modal/Modal.js`). On Android it never fires, so the
  queued action was dropped every time: the menu closed and nothing happened.

  Nothing caught it. There was no test for this component at all, and on iOS —
  where it was developed — the behaviour was correct.
*/
describe('CardActionsSheet dismissal signal', () => {
  const realOS = Platform.OS;

  function renderSheet(onDismiss: () => void, visible: boolean) {
    return renderInWrapper(
      <CardActionsSheet
        onClose={() => {}}
        onDelete={() => {}}
        onDismiss={onDismiss}
        onEdit={() => {}}
        onShare={() => {}}
        onWishlist={() => {}}
        title="Charizard"
        visible={visible}
      />,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    Platform.OS = realOS;
  });

  /*
    Past the Android delay. Asserted on the CALLBACK, never on the sheet leaving
    the tree: `Modal` renders null the moment `visible` is false, so the testID
    disappears immediately and a test waiting on THAT would pass unfixed.
  */
  const settle = () => act(() => {
    jest.advanceTimersByTime(400);
  });

  it('fires onDismiss on Android, where Modal.onDismiss never will', () => {
    Platform.OS = 'android';
    const onDismiss = jest.fn();
    const { rerender } = renderSheet(onDismiss, true);

    expect(screen.getByTestId('card-actions-sheet')).toBeTruthy();
    // Still up: the caller must not run a queued action yet.
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      rerender(
        <CardActionsSheet
          onClose={() => {}}
          onDelete={() => {}}
          onDismiss={onDismiss}
          onEdit={() => {}}
          onShare={() => {}}
          onWishlist={() => {}}
          title="Charizard"
          visible={false}
        />,
      );
    });
    settle();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire twice when the sheet is reopened and closed again', () => {
    Platform.OS = 'android';
    const onDismiss = jest.fn();
    const props = {
      onClose: () => {},
      onDelete: () => {},
      onDismiss,
      onEdit: () => {},
      onShare: () => {},
      onWishlist: () => {},
      title: 'Charizard',
    };
    const { rerender } = renderInWrapper(<CardActionsSheet {...props} visible />);

    act(() => {
      rerender(<CardActionsSheet {...props} visible={false} />);
    });
    settle();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // Reopening ARMS the signal again — a second Share must still fire. Opening
    // on its own must not.
    act(() => {
      rerender(<CardActionsSheet {...props} visible />);
    });
    expect(screen.getByTestId('card-actions-sheet')).toBeTruthy();
    settle();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    act(() => {
      rerender(<CardActionsSheet {...props} visible={false} />);
    });
    settle();
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('leaves iOS on the native signal — no timer stands in for it', () => {
    // On iOS the queued action is a UIActivityViewController; presenting it
    // before the view controller has finished dismissing freezes the screen, and
    // a timer is a guess at that moment rather than a report of it. So iOS stays
    // on `Modal`'s own `onDismiss` and the timer must never fire here.
    Platform.OS = 'ios';
    const onDismiss = jest.fn();
    const props = {
      onClose: () => {},
      onDelete: () => {},
      onDismiss,
      onEdit: () => {},
      onShare: () => {},
      onWishlist: () => {},
      title: 'Charizard',
    };
    const { rerender } = renderInWrapper(<CardActionsSheet {...props} visible />);

    act(() => {
      rerender(<CardActionsSheet {...props} visible={false} />);
    });
    settle();

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
