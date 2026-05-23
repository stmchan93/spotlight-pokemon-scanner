import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SpotlightThemeProvider, TrendPill } from '@spotlight/design-system';

function renderTrendPill(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

describe('TrendPill', () => {
  it('renders the up arrow icon when direction is up', () => {
    renderTrendPill(<TrendPill direction="up" label="28%" testID="pill-up" />);

    expect(screen.getByTestId('pill-up')).toBeTruthy();
    expect(screen.getByTestId('iconoir-arrow-up')).toBeTruthy();
    expect(screen.queryByTestId('iconoir-arrow-down')).toBeNull();
    expect(screen.queryByTestId('iconoir-minus')).toBeNull();
    expect(screen.getByText('28%')).toBeTruthy();
  });

  it('renders the down arrow icon when direction is down', () => {
    renderTrendPill(<TrendPill direction="down" label="$403.99" testID="pill-down" />);

    expect(screen.getByTestId('pill-down')).toBeTruthy();
    expect(screen.getByTestId('iconoir-arrow-down')).toBeTruthy();
    expect(screen.queryByTestId('iconoir-arrow-up')).toBeNull();
    expect(screen.queryByTestId('iconoir-minus')).toBeNull();
    expect(screen.getByText('$403.99')).toBeTruthy();
  });

  it('renders a minus icon when direction is flat', () => {
    renderTrendPill(<TrendPill direction="flat" label="0%" testID="pill-flat" />);

    expect(screen.getByTestId('pill-flat')).toBeTruthy();
    expect(screen.getByTestId('iconoir-minus')).toBeTruthy();
    expect(screen.queryByTestId('iconoir-arrow-up')).toBeNull();
    expect(screen.queryByTestId('iconoir-arrow-down')).toBeNull();
  });

  it('renders the positive tone (just verifies testID and presence)', () => {
    renderTrendPill(
      <TrendPill direction="up" tone="positive" label="28%" testID="pill-positive" />,
    );

    const pill = screen.getByTestId('pill-positive');
    expect(pill).toBeTruthy();
    // The container style includes a backgroundColor for the positive tone.
    const flattened = StyleSheet.flatten(pill.props.style);
    expect(typeof flattened.backgroundColor).toBe('string');
  });

  it('renders percent and dollar labels correctly', () => {
    const { rerender } = renderTrendPill(
      <TrendPill direction="up" label="28%" testID="pill" />,
    );
    expect(screen.getByText('28%')).toBeTruthy();

    rerender(
      <SpotlightThemeProvider>
        <TrendPill direction="up" label="$403.99" testID="pill" />
      </SpotlightThemeProvider>,
    );
    expect(screen.getByText('$403.99')).toBeTruthy();
  });

  it('renders without crashing at size sm', () => {
    renderTrendPill(
      <TrendPill direction="up" size="sm" label="28%" testID="pill-sm" />,
    );
    expect(screen.getByTestId('pill-sm')).toBeTruthy();
  });

  it('renders without crashing at size md', () => {
    renderTrendPill(
      <TrendPill direction="up" size="md" label="28%" testID="pill-md" />,
    );
    expect(screen.getByTestId('pill-md')).toBeTruthy();
  });
});
