import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import { Alert } from 'react-native';

import type { Collection, SpotlightRepository } from '@spotlight/api-client';

import { exportCollectionCsv } from '@/features/portfolio/export-collection';
import { SettingsScreen } from '@/features/settings/screens/settings-screen';
import { openStoreReviewPage } from '@/features/review-prompt/review-prompt';
import { useAuth } from '@/providers/auth-provider';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/features/portfolio/export-collection', () => ({
  exportCollectionCsv: jest.fn(async () => 'shared'),
}));

function collection(id: string, isDefault = false): Collection {
  return {
    cardCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    hidden: false,
    id,
    isDefault,
    name: `Name ${id}`,
    sortOrder: 0,
    totalValue: 1,
  };
}

function repositoryWith(collections: Collection[]): SpotlightRepository {
  return createTestSpotlightRepository({
    listCollections: async () => ({
      all: { cardCount: collections.length, totalValue: collections.length },
      collections,
      defaultCollectionID: collections[0]?.id ?? '',
    }),
  });
}

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    // The hook passes a stable `useCallback`, so this runs once, like a first focus.
    const { useEffect } = jest.requireActual('react');
    useEffect(() => effect(), [effect]);
  },
  useRouter: jest.fn(),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/features/social/dm-service', () => ({
  fetchTotalUnreadMessageCount: jest.fn(async () => 3),
}));

jest.mock('@/features/review-prompt/review-prompt', () => ({
  openStoreReviewPage: jest.fn(async () => undefined),
}));

const mockCapturePostHogEvent = jest.fn();
jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: (...args: unknown[]) => mockCapturePostHogEvent(...args),
}));

/**
 * Settings replaced the hamburger drawer (2026-11-22). The contract that
 * matters: every destination the drawer had is still reachable from here
 * (minus Find people, which the Search tab replaces), guests are gated the same
 * way, and nothing says "Wishlist".
 */
describe('SettingsScreen', () => {
  const push = jest.fn();
  const back = jest.fn();
  const signOut = jest.fn(async () => undefined);

  function mockUser(isGuest = false) {
    (useAuth as jest.Mock).mockReturnValue({
      currentUser: isGuest
        ? null
        : { avatarURL: null, displayName: 'Wabi Sabi', handle: 'wabisabi', id: 'user-1' },
      ensureGuestSession: jest.fn(),
      isGuest,
      signOut,
    });
  }

  /** Renders and waits for the focus-time unread read to land. */
  async function renderSettings(spotlightRepository?: SpotlightRepository) {
    renderWithProviders(<SettingsScreen />, { spotlightRepository });
    await screen.findByTestId('settings-row-messages-badge');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ back, canGoBack: () => true, push });
    mockUser();
  });

  it('lists every drawer destination except Find people', async () => {
    await renderSettings();

    for (const label of [
      'EDIT PROFILE',
      'INSIGHTS',
      'MESSAGES',
      "WHO'S THAT POKÉMON?",
      'EXPORT COLLECTION',
      'RATE EKALIGHT',
      'SEND FEEDBACK',
      'ACCOUNT SETTINGS',
      'LOG OUT',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText(/find people/i)).toBeNull();
    expect(screen.queryByText(/wishlist/i)).toBeNull();
    expect(mockCapturePostHogEvent).toHaveBeenCalledWith('settings_opened', {});
  });

  it.each([
    ['settings-row-edit-profile', '/edit-profile'],
    ['settings-row-insights', '/insights'],
    ['settings-row-messages', '/messages'],
    ['settings-row-whos-that-pokemon', '/whos-that-pokemon'],
    ['settings-row-account-settings', '/account'],
    ['settings-profile', '/edit-profile'],
  ])('%s pushes %s', async (testID, href) => {
    await renderSettings();
    await act(async () => {
      fireEvent.press(screen.getByTestId(testID));
    });
    expect(push).toHaveBeenCalledWith(href);
  });

  it('sends feedback tagged with where it came from, and opens the store review', async () => {
    await renderSettings();
    fireEvent.press(screen.getByTestId('settings-row-feedback'));
    expect(push).toHaveBeenCalledWith({ pathname: '/feedback', params: { from: '/settings' } });
    fireEvent.press(screen.getByTestId('settings-row-rate'));
    expect(openStoreReviewPage).toHaveBeenCalledTimes(1);
    expect(mockCapturePostHogEvent).toHaveBeenCalledWith('settings_item_tapped', { item: 'rate' });
  });

  it('confirms before logging out', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderSettings();
    fireEvent.press(screen.getByTestId('settings-row-logout'));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();

    const buttons = alert.mock.calls[0]?.[2] ?? [];
    const confirm = buttons.find((button) => button.text === 'Log Out');
    await act(async () => {
      await confirm?.onPress?.();
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

  it('sends a guest to sign-in from gated rows, but lets them send feedback', async () => {
    mockUser(true);
    await renderSettings();

    expect(screen.queryByTestId('settings-profile')).toBeNull();
    // Nothing to log out of; a SIGN IN row instead.
    expect(screen.queryByTestId('settings-row-logout')).toBeNull();
    fireEvent.press(screen.getByTestId('settings-row-sign-in'));
    expect(push).toHaveBeenLastCalledWith('/login');
    push.mockClear();
    fireEvent.press(screen.getByTestId('settings-row-insights'));
    expect(push).not.toHaveBeenCalledWith('/insights');
    expect(push).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('settings-row-feedback'));
    expect(push).toHaveBeenLastCalledWith({ pathname: '/feedback', params: { from: '/settings' } });
  });

  it('exports straight away when there is only one collection', async () => {
    await renderSettings(repositoryWith([collection('c1', true)]));
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-row-export-collection'));
    });

    await waitFor(() => expect(exportCollectionCsv).toHaveBeenCalledWith(expect.anything(), null));
    expect(screen.queryByTestId('export-scope-sheet')).toBeNull();
    expect(mockCapturePostHogEvent).toHaveBeenCalledWith('settings_item_tapped', { item: 'export_collection' });
    expect(mockCapturePostHogEvent).toHaveBeenCalledWith('collection_export_tapped', { scope: 'all', source: 'settings' });
    await waitFor(() => expect(mockCapturePostHogEvent).toHaveBeenCalledWith(
      'collection_export_succeeded',
      { empty: false, scope: 'all', source: 'settings' },
    ));
  });

  it('asks All vs one collection when there are several, and exports the choice', async () => {
    (exportCollectionCsv as jest.Mock).mockResolvedValueOnce('failed');
    await renderSettings(repositoryWith([collection('c1', true), collection('c2')]));
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-row-export-collection'));
    });

    expect(await screen.findByTestId('export-scope-sheet')).toBeTruthy();
    expect(screen.getByText('All collections')).toBeTruthy();
    expect(exportCollectionCsv).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('export-scope-sheet-collection-c2'));

    // Starts once the sheet has slid out.
    await waitFor(() => expect(exportCollectionCsv).toHaveBeenCalledWith(expect.anything(), 'c2'));
    await waitFor(() => expect(mockCapturePostHogEvent).toHaveBeenCalledWith(
      'collection_export_failed',
      { scope: 'single', source: 'settings' },
    ));
  });

  it('sends a guest to sign-in instead of exporting', async () => {
    mockUser(true);
    await renderSettings();
    fireEvent.press(screen.getByTestId('settings-row-export-collection'));
    expect(push).toHaveBeenCalledTimes(1);
    expect(exportCollectionCsv).not.toHaveBeenCalled();
  });
});
