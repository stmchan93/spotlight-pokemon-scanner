import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { usePathname, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, View } from 'react-native';

import { AppDrawer } from '@/components/app-drawer';
import { fetchTotalUnreadMessageCount } from '@/features/social/dm-service';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAuth } from '@/providers/auth-provider';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  usePathname: jest.fn(),
}));

jest.mock('@/features/social/dm-service', () => ({
  fetchTotalUnreadMessageCount: jest.fn(async () => 0),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: jest.fn(),
}));

type DrawerHandle = {
  open: () => void;
  close: () => void;
};

const drawerHandleRef: { current: DrawerHandle | null } = { current: null };

function DrawerController() {
  const { openDrawer, closeDrawer } = useAppDrawer();

  useEffect(() => {
    drawerHandleRef.current = { open: openDrawer, close: closeDrawer };
    return () => {
      drawerHandleRef.current = null;
    };
  }, [openDrawer, closeDrawer]);

  return <View testID="drawer-controller" />;
}

describe('AppDrawer', () => {
  const push = jest.fn();
  const replace = jest.fn();
  const dismissTo = jest.fn();
  const signOut = jest.fn(async () => {});

  beforeEach(() => {
    jest.clearAllMocks();
    drawerHandleRef.current = null;

    (useRouter as jest.Mock).mockReturnValue({ push, replace, dismissTo });
    (usePathname as jest.Mock).mockReturnValue('/portfolio');
    (useAuth as jest.Mock).mockReturnValue({
      currentUser: {
        adminEnabled: false,
        avatarURL: null,
        displayName: 'Spotlight Collector',
        email: 'collector@example.com',
        id: 'user-1',
      },
      currentSession: {
        user: {
          created_at: '2024-01-15T00:00:00Z',
        },
      },
      signOut,
      state: 'authenticated',
    });
  });

  it('does not render the panel before the drawer is ever opened', () => {
    renderWithProviders(
      <>
        <DrawerController />
        <AppDrawer />
      </>,
    );

    expect(screen.queryByTestId('app-drawer-panel')).toBeNull();
  });

  it('renders the panel after openDrawer is called', () => {
    renderWithProviders(
      <>
        <DrawerController />
        <AppDrawer />
      </>,
    );

    act(() => {
      drawerHandleRef.current?.open();
    });

    expect(screen.getByTestId('app-drawer-panel')).toBeTruthy();
  });

  it('renders every nav item with its testID after open', () => {
    renderWithProviders(
      <>
        <DrawerController />
        <AppDrawer />
      </>,
    );

    act(() => {
      drawerHandleRef.current?.open();
    });

    // THE DRAWER HOLDS ONLY WHAT THE TAB BAR DOES NOT. Portfolio, Wishlist and
    // Scan are bottom tabs, and duplicating them here is what produced a
    // silently-dead item: a tab destination has no correct branch in `goTo`, so
    // the Portfolio row hand-rolled `dismissTo`, which the native tabs router
    // drops (see native-tabs-router-contract-test). Asserted absent rather than
    // simply removed, so re-adding one fails here instead of on a device.
    expect(screen.queryByTestId('app-drawer-nav-collection')).toBeNull();
    expect(screen.queryByTestId('app-drawer-nav-wishlist')).toBeNull();
    expect(screen.queryByTestId('app-drawer-nav-scan')).toBeNull();

    expect(screen.getByTestId('app-drawer-nav-insights')).toBeTruthy();
    // The drawer is the only way into the DM inbox.
    expect(screen.getByTestId('app-drawer-nav-messages')).toBeTruthy();
    expect(screen.getByTestId('app-drawer-nav-whos-that-pokemon')).toBeTruthy();
    // Account Settings sits directly above Log Out and routes to /account.
    expect(screen.getByTestId('app-drawer-nav-account-settings')).toBeTruthy();
    expect(screen.getByTestId('app-drawer-nav-logout')).toBeTruthy();
  });

  it("navigates to /whos-that-pokemon when Who's That Pokémon? is tapped", () => {
    jest.useFakeTimers();
    try {
      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      act(() => {
        drawerHandleRef.current?.open();
      });

      fireEvent.press(screen.getByTestId('app-drawer-nav-whos-that-pokemon'));

      act(() => {
        jest.advanceTimersByTime(500);
      });

      // From the Collection root the drawer PUSHES stack routes so swipe-back
      // returns to Collection (same as Wishlist/Insights).
      expect(push).toHaveBeenCalledWith('/whos-that-pokemon');
    } finally {
      jest.useRealTimers();
    }
  });

  it('navigates to /messages when Messages is tapped', () => {
    jest.useFakeTimers();
    try {
      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      act(() => {
        drawerHandleRef.current?.open();
      });

      fireEvent.press(screen.getByTestId('app-drawer-nav-messages'));

      act(() => {
        jest.advanceTimersByTime(500);
      });

      // From the Collection root, stack routes are PUSHED so swipe-back returns
      // to Collection — same as Wishlist/Insights/Who's That Pokémon.
      expect(push).toHaveBeenCalledWith('/messages');
      expect(replace).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders the display name and Member since line from auth + session', () => {
    renderWithProviders(
      <>
        <DrawerController />
        <AppDrawer />
      </>,
    );

    act(() => {
      drawerHandleRef.current?.open();
    });

    expect(screen.getByText('Spotlight Collector')).toBeTruthy();
    expect(screen.getByText('Member since Jan 2024')).toBeTruthy();
  });

  it('opens the account screen when the profile row is tapped', async () => {
    jest.useFakeTimers();
    try {
      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      act(() => {
        drawerHandleRef.current?.open();
      });

      fireEvent.press(screen.getByTestId('app-drawer-profile'));

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(push).toHaveBeenCalledWith('/account');
    } finally {
      jest.useRealTimers();
    }
  });

  it('marks no nav row active when pathname is a tab root', () => {
    (usePathname as jest.Mock).mockReturnValue('/portfolio');

    renderWithProviders(
      <>
        <DrawerController />
        <AppDrawer />
      </>,
    );

    act(() => {
      drawerHandleRef.current?.open();
    });

    // Every remaining drawer row is a STACK route, so standing on a tab root
    // lights none of them. The dot mechanism itself is covered by the /insights
    // case below.
    expect(screen.queryByTestId('app-drawer-nav-insights-active-dot')).toBeNull();
  });

  it('marks the Insights row active when pathname is /insights', () => {
    (usePathname as jest.Mock).mockReturnValue('/insights');

    renderWithProviders(
      <>
        <DrawerController />
        <AppDrawer />
      </>,
    );

    act(() => {
      drawerHandleRef.current?.open();
    });

    expect(screen.queryByTestId('app-drawer-nav-insights-active-dot')).toBeTruthy();
  });

  /*
    Removed with the drawer's Collection/Portfolio row: two tests that asserted
    `dismissTo('/you')` was CALLED. Both passed green while the feature was
    broken on device — the router here is a jest mock, so "was it called" says
    nothing about whether the navigator could handle it. The real constraint is
    now pinned directly in
    `__tests__/routes/native-tabs-router-contract-test.ts`, which drives the
    actual NativeBottomTabsRouter and asserts POP_TO comes back null.
  */

  it('confirms Log Out via an alert before signing out', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      // Simulate the user tapping the destructive "Log Out" button.
      const logOutAction = buttons?.find((button) => button.style === 'destructive');
      void logOutAction?.onPress?.();
    });

    renderWithProviders(
      <>
        <DrawerController />
        <AppDrawer />
      </>,
    );

    act(() => {
      drawerHandleRef.current?.open();
    });

    fireEvent.press(screen.getByTestId('app-drawer-nav-logout'));

    expect(alertSpy).toHaveBeenCalledWith(
      'Log out?',
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Log Out', style: 'destructive' }),
      ]),
    );

    await waitFor(() => {
      expect(signOut).toHaveBeenCalledTimes(1);
    });

    alertSpy.mockRestore();
  });

  it('does not sign out when the confirmation alert is cancelled', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const cancelAction = buttons?.find((button) => button.style === 'cancel');
      void cancelAction?.onPress?.();
    });

    renderWithProviders(
      <>
        <DrawerController />
        <AppDrawer />
      </>,
    );

    act(() => {
      drawerHandleRef.current?.open();
    });

    fireEvent.press(screen.getByTestId('app-drawer-nav-logout'));

    expect(alertSpy).toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('closes the drawer when the scrim is tapped', async () => {
    jest.useFakeTimers();
    try {
      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      act(() => {
        drawerHandleRef.current?.open();
      });

      expect(screen.getByTestId('app-drawer-panel')).toBeTruthy();

      fireEvent.press(screen.getByTestId('app-drawer-scrim'));

      // Allow the close animation to flush.
      act(() => {
        jest.advanceTimersByTime(500);
      });

      // The outer wrapper toggles pointerEvents to 'none' when closed.
      const outerWrapper = screen.getByTestId('app-drawer');
      expect(outerWrapper.props.pointerEvents).toBe('none');
    } finally {
      jest.useRealTimers();
    }
  });
  /*
    Reaching Insights from the drawer must leave a back stack behind it.

    `goTo` may only `replace` when the current route was PUSHED. Wishlist and
    Scan are tabs, so replacing from them swaps the whole `(tabs)` entry out of
    the root stack and Insights ends up with nothing behind it — the back
    button then does nothing. Insights itself IS pushed, so hopping straight
    from it must still replace, or the stack grows one entry per drawer visit.
  */
  describe('reaching Insights from the drawer', () => {
    function openInsightsFrom(pathname: string) {
      (usePathname as jest.Mock).mockReturnValue(pathname);

      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      act(() => {
        drawerHandleRef.current?.open();
      });

      fireEvent.press(screen.getByTestId('app-drawer-nav-insights'));

      act(() => {
        jest.advanceTimersByTime(500);
      });
    }

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it.each([
      ['the Wishlist tab', '/wishlist'],
      ['the Scan tab', '/scan'],
      ['the Home feed', '/'],
      ['the Collection tab', '/you'],
    ])('pushes from %s, so back returns to it', (_label, pathname) => {
      openInsightsFrom(pathname);

      expect(push).toHaveBeenCalledWith('/insights');
      expect(replace).not.toHaveBeenCalled();
    });

    it('replaces when hopping from Insights itself, so the stack cannot grow', () => {
      openInsightsFrom('/insights');

      expect(replace).toHaveBeenCalledWith('/insights');
      expect(push).not.toHaveBeenCalled();
    });
  });

  /*
    ═══════════════════════════════════════════════════════════════════════════
    UNREAD MAIL IS VISIBLE FROM THE DRAWER.
    ═══════════════════════════════════════════════════════════════════════════
    The drawer is the ONLY way into the inbox — `/messages` is reachable from
    nowhere else — so without a count here there is no way to learn you have
    mail short of opening it and looking.

    Purple, matching the inbox's own per-thread badges rather than the bell's
    red one: red is this app's danger colour, and unread mail is not a warning.
  */
  describe('the unread message badge', () => {
    it('totals unread messages on the Messages row', async () => {
      (fetchTotalUnreadMessageCount as jest.Mock).mockResolvedValue(4);
      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      await act(async () => {
        drawerHandleRef.current?.open();
      });

      const badge = await screen.findByTestId('app-drawer-nav-messages-badge');
      expect(badge).toBeTruthy();
      expect(screen.getByText('4')).toBeTruthy();
    });

    // An empty inbox draws nothing at all — a "0" is noise that reads as a
    // number worth looking at.
    it('draws nothing when there is no unread mail', async () => {
      (fetchTotalUnreadMessageCount as jest.Mock).mockResolvedValue(0);
      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      await act(async () => {
        drawerHandleRef.current?.open();
      });

      expect(screen.queryByTestId('app-drawer-nav-messages-badge')).toBeNull();
    });

    // Capped so a busy inbox cannot stretch the row's layout.
    it('caps a busy inbox at 99+', async () => {
      (fetchTotalUnreadMessageCount as jest.Mock).mockResolvedValue(250);
      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      await act(async () => {
        drawerHandleRef.current?.open();
      });

      expect(await screen.findByText('99+')).toBeTruthy();
    });

    /*
      Read when the drawer OPENS, not on a timer. The drawer is the only door to
      the inbox, so that is the only moment the number is looked at — polling it
      would spend requests on a badge nobody is reading.
    */
    it('does not read the count until the drawer opens', async () => {
      renderWithProviders(
        <>
          <DrawerController />
          <AppDrawer />
        </>,
      );

      expect(fetchTotalUnreadMessageCount).not.toHaveBeenCalled();

      await act(async () => {
        drawerHandleRef.current?.open();
      });

      expect(fetchTotalUnreadMessageCount).toHaveBeenCalledTimes(1);
    });
  });
});
