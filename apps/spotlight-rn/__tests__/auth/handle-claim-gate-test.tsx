import { fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { AppUser } from '@/features/auth/auth-models';
import { HandleClaimGate } from '@/features/auth/components/handle-claim-gate';
import { useAccessGate } from '@/features/auth/access-gate-provider';
import { useAuth } from '@/providers/auth-provider';

import { renderWithProviders } from '../test-utils';

jest.mock('@/features/auth/access-gate-provider', () => ({
  useAccessGate: jest.fn(),
}));
jest.mock('@/providers/auth-provider', () => ({
  useAuth: jest.fn(),
}));
// The real screen carries its own debounced availability probe (covered by
// handle-claim-screen-test); the gate tests only care that it is shown and
// wired, so a marker stub keeps them synchronous.
jest.mock('@/features/auth/components/handle-claim-screen', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text: RNText } = require('react-native') as typeof import('react-native');
  return {
    HandleClaimScreen: ({
      errorMessage,
      isBusy,
      onSubmit,
    }: {
      errorMessage: string | null;
      isBusy: boolean;
      onSubmit: (handle: string) => void;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(RNText, { testID: 'claim-screen' }, `busy:${String(isBusy)}`),
        React.createElement(RNText, { testID: 'claim-error' }, `error:${errorMessage ?? 'none'}`),
        React.createElement(Pressable, {
          testID: 'claim-submit',
          onPress: () => onSubmit('misty'),
        }),
      ),
  };
});

const mockUseAccessGate = useAccessGate as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

function makeUser(overrides: Partial<AppUser> = {}): AppUser {
  return {
    adminEnabled: false,
    avatarURL: null,
    displayName: 'Collector',
    email: 'collector@example.com',
    id: 'user-1',
    labelerEnabled: false,
    providers: ['google'],
    handleKnown: true,
    handle: null,
    ...overrides,
  };
}

function renderGate({
  handleClaimRequired = true,
  status = { handleClaimRequired } as Record<string, unknown> | null,
  user = makeUser(),
  isGuest = false,
  errorMessage = null as string | null,
  isBusy = false,
}: {
  handleClaimRequired?: boolean;
  status?: Record<string, unknown> | null;
  user?: AppUser | null;
  isGuest?: boolean;
  errorMessage?: string | null;
  isBusy?: boolean;
} = {}) {
  mockUseAccessGate.mockReturnValue({ state: 'allowed', status, refresh: jest.fn() });
  const submitHandle = jest.fn(async () => {});
  mockUseAuth.mockReturnValue({
    currentUser: user,
    errorMessage,
    isBusy,
    isGuest,
    submitHandle,
  });

  renderWithProviders(
    <HandleClaimGate>
      <Text testID="app-content">the app</Text>
    </HandleClaimGate>,
  );

  return { submitHandle };
}

describe('HandleClaimGate', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders children when the backend flag is off', () => {
    renderGate({ handleClaimRequired: false });

    expect(screen.getByTestId('app-content')).toBeTruthy();
    expect(screen.queryByTestId('claim-screen')).toBeNull();
  });

  it('renders children when there is no access status at all (fail open)', () => {
    renderGate({ status: null });

    expect(screen.getByTestId('app-content')).toBeTruthy();
    expect(screen.queryByTestId('claim-screen')).toBeNull();
  });

  it('renders children for guests even if a status carries the flag', () => {
    renderGate({
      isGuest: true,
      user: makeUser({ handleKnown: false, providers: [] }),
    });

    expect(screen.getByTestId('app-content')).toBeTruthy();
    expect(screen.queryByTestId('claim-screen')).toBeNull();
  });

  // THE false-null guard. A profile-fetch timeout or a degraded select that
  // dropped the handle column reads `handle: null` for users who own one —
  // the gate must treat that as "unknown", never as "go claim".
  it('renders children when the handle is not KNOWN to be absent', () => {
    renderGate({ user: makeUser({ handleKnown: false }) });

    expect(screen.getByTestId('app-content')).toBeTruthy();
    expect(screen.queryByTestId('claim-screen')).toBeNull();
  });

  it('renders children when the user already owns a handle', () => {
    renderGate({ user: makeUser({ handle: 'collector' }) });

    expect(screen.getByTestId('app-content')).toBeTruthy();
    expect(screen.queryByTestId('claim-screen')).toBeNull();
  });

  it('blocks with the claim screen when required, known, and unclaimed — and wires submit', () => {
    const { submitHandle } = renderGate({ errorMessage: 'That handle is already taken.', isBusy: true });

    expect(screen.queryByTestId('app-content')).toBeNull();
    expect(screen.getByTestId('claim-screen').props.children).toBe('busy:true');
    expect(screen.getByTestId('claim-error').props.children).toBe('error:That handle is already taken.');

    fireEvent.press(screen.getByTestId('claim-submit'));
    expect(submitHandle).toHaveBeenCalledWith('misty');
  });
});
