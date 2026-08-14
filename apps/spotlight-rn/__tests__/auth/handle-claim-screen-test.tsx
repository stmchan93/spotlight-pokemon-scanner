import { act, fireEvent, screen } from '@testing-library/react-native';

import { HandleClaimScreen } from '@/features/auth/components/handle-claim-screen';
import { checkHandleAvailability } from '@/features/profile/profile-service';

import { renderWithProviders } from '../test-utils';

jest.mock('@/features/profile/profile-service', () => ({
  checkHandleAvailability: jest.fn(async () => 'available'),
}));

const mockCheckAvailability = checkHandleAvailability as jest.MockedFunction<
  typeof checkHandleAvailability
>;

function renderScreen(overrides: Partial<React.ComponentProps<typeof HandleClaimScreen>> = {}) {
  const onSubmit = jest.fn();
  renderWithProviders(
    <HandleClaimScreen
      errorMessage={null}
      isBusy={false}
      onSubmit={onSubmit}
      user={null}
      {...overrides}
    />,
  );
  return { onSubmit };
}

async function typeAndSettle(text: string) {
  fireEvent.changeText(screen.getByTestId('auth-handle-input'), text);
  // Debounce (400ms) + the probe promise.
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
}

describe('HandleClaimScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCheckAvailability.mockClear();
    mockCheckAvailability.mockResolvedValue('available');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sanitizes input as the user types', () => {
    renderScreen();
    fireEvent.changeText(screen.getByTestId('auth-handle-input'), '@Ash Ketchum!');
    expect(screen.getByTestId('auth-handle-input').props.value).toBe('ashketchum');
  });

  it('blocks submit and explains a reserved handle without probing', async () => {
    const { onSubmit } = renderScreen();
    await typeAndSettle('admin');

    expect(screen.getByTestId('auth-handle-helper').props.children).toMatch(/isn't available/i);
    expect(mockCheckAvailability).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('auth-handle-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('probes availability for a valid handle and submits it', async () => {
    const { onSubmit } = renderScreen();
    await typeAndSettle('ash_99');

    expect(mockCheckAvailability).toHaveBeenCalledWith('ash_99');
    expect(screen.getByTestId('auth-handle-helper').props.children).toMatch(/is available/i);

    fireEvent.press(screen.getByTestId('auth-handle-submit'));
    expect(onSubmit).toHaveBeenCalledWith('ash_99');
  });

  it('blocks submit when the probe says taken', async () => {
    mockCheckAvailability.mockResolvedValue('taken');
    const { onSubmit } = renderScreen();
    await typeAndSettle('ash_99');

    expect(screen.getByTestId('auth-handle-helper').props.children).toMatch(/already taken/i);
    fireEvent.press(screen.getByTestId('auth-handle-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still allows submit when availability is unknown (offline must not trap)', async () => {
    mockCheckAvailability.mockResolvedValue('unknown');
    const { onSubmit } = renderScreen();
    await typeAndSettle('ash_99');

    expect(screen.getByTestId('auth-handle-helper').props.children).toMatch(/still continue/i);
    fireEvent.press(screen.getByTestId('auth-handle-submit'));
    expect(onSubmit).toHaveBeenCalledWith('ash_99');
  });

  it('surfaces a save-time error from the caller', () => {
    renderScreen({ errorMessage: 'That handle is already taken.' });
    expect(screen.getByText('That handle is already taken.')).toBeTruthy();
  });
});
