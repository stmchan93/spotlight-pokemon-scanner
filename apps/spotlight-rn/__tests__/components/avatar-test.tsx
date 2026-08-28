import type { PropsWithChildren } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';
import { Avatar } from '../../../../packages/design-system/src/components/avatar';

function Providers({ children }: PropsWithChildren) {
  return <SpotlightThemeProvider>{children}</SpotlightThemeProvider>;
}

const URI_A = 'https://example.com/avatar-a.png';
const URI_B = 'https://example.com/avatar-b.png';

describe('Avatar', () => {
  it('renders initials when no uri is provided', () => {
    render(<Avatar initials="SC" testID="avatar" uri={null} />, { wrapper: Providers });

    expect(screen.getByText('SC')).toBeTruthy();
    expect(screen.queryByTestId('avatar-image')).toBeNull();
  });

  it('renders the image and no initials when a uri is provided', () => {
    render(<Avatar initials="SC" testID="avatar" uri={URI_A} />, { wrapper: Providers });

    expect(screen.getByTestId('avatar-image')).toBeTruthy();
    expect(screen.queryByText('SC')).toBeNull();
  });

  it('falls back to initials when the image fails to load', () => {
    render(<Avatar initials="SC" testID="avatar" uri={URI_A} />, { wrapper: Providers });

    fireEvent(screen.getByTestId('avatar-image'), 'error');

    expect(screen.getByText('SC')).toBeTruthy();
    expect(screen.queryByTestId('avatar-image')).toBeNull();
  });

  it('retries the image when the uri changes after an error', () => {
    render(<Avatar initials="SC" testID="avatar" uri={URI_A} />, { wrapper: Providers });

    fireEvent(screen.getByTestId('avatar-image'), 'error');
    expect(screen.queryByTestId('avatar-image')).toBeNull();

    screen.rerender(<Avatar initials="SC" testID="avatar" uri={URI_B} />);

    expect(screen.getByTestId('avatar-image')).toBeTruthy();
    expect(screen.queryByText('SC')).toBeNull();
  });
});
