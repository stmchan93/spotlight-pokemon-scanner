import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { usePathname, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, View } from 'react-native';

import { AppDrawer } from '@/components/app-drawer';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAuth } from '@/providers/auth-provider';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  usePathname: jest.fn(),
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

    expect(screen.getByTestId('app-drawer-nav-collection')).toBeTruthy();
    expect(screen.getByTestId('app-drawer-nav-insights')).toBeTruthy();
    expect(screen.getByTestId('app-drawer-nav-wishlist')).toBeTruthy();
    expect(screen.getByTestId('app-drawer-nav-scan')).toBeTruthy();
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

  it('marks the Collection row active when pathname is /portfolio', () => {
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

    expect(screen.queryByTestId('app-drawer-nav-collection-active-dot')).toBeTruthy();
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
    expect(screen.queryByTestId('app-drawer-nav-collection-active-dot')).toBeNull();
  });

  it('navigates back to /portfolio when Collection is tapped from a stack route', () => {
    jest.useFakeTimers();
    try {
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

      fireEvent.press(screen.getByTestId('app-drawer-nav-collection'));

      act(() => {
        jest.advanceTimersByTime(500);
      });

      // Pop the stack down to the tabs and select Collection, which is the
      // `/you` TAB — not `/`, which is the Home feed now. `replace('/portfolio')`
      // would leave both the tabs entry AND the redirected one in the stack
      // (both render Collection visually), causing the "Collections Collections
      // Collections" swipe-back bug. The `page: 'portfolio'` param that used to
      // ride along was the retired pager's addressing and is read by nothing.
      expect(dismissTo).toHaveBeenCalledWith('/you');
      expect(replace).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not navigate when Collection is tapped while already on /portfolio', () => {
    jest.useFakeTimers();
    try {
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

      fireEvent.press(screen.getByTestId('app-drawer-nav-collection'));

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(replace).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(dismissTo).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

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
});
