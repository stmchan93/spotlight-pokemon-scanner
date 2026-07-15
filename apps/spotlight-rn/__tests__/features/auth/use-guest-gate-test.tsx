import { renderHook } from '@testing-library/react-native';

import { useGuestGate } from '@/features/auth/use-guest-gate';

const mockPush = jest.fn();
// Prefixed `mock*` so the jest.mock factory may reference it (hoisting rule).
let mockIsGuest = false;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ isGuest: mockIsGuest }),
}));

describe('useGuestGate', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockIsGuest = false;
  });

  it('runs the wrapped action (forwarding args) for a real user, with no login push', () => {
    const { result } = renderHook(() => useGuestGate());
    const action = jest.fn();

    result.current.gate(action)('a', 'b');

    expect(action).toHaveBeenCalledWith('a', 'b');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens the login modal for a guest and does NOT run the wrapped action', () => {
    mockIsGuest = true;
    const { result } = renderHook(() => useGuestGate());
    const action = jest.fn();

    result.current.gate(action)('x');

    expect(action).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('exposes isGuest and an imperative openLogin', () => {
    mockIsGuest = true;
    const { result } = renderHook(() => useGuestGate());

    expect(result.current.isGuest).toBe(true);
    result.current.openLogin();
    expect(mockPush).toHaveBeenCalledWith('/login');
  });
});
