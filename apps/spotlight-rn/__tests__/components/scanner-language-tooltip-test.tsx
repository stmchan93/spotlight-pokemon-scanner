import { fireEvent, render, screen } from '@testing-library/react-native';

import { ScannerLanguageTooltip } from '@/features/scanner/components/scanner-language-tooltip';
import { RoundFlag } from '@/features/scanner/components/round-flag';
import { ScanTargetPill } from '@/features/scanner/components/scan-target-pill';

describe('ScannerLanguageTooltip (Figma 2302:29019)', () => {
  it('renders the coach-mark copy and fires onPress to dismiss', () => {
    const onPress = jest.fn();
    render(<ScannerLanguageTooltip onPress={onPress} visible />);

    expect(screen.getByText('Switch between Pokémon EN/JP!')).toBeTruthy();
    fireEvent.press(screen.getByTestId('scanner-language-tooltip'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders nothing once hidden (after the fade completes)', () => {
    render(<ScannerLanguageTooltip onPress={jest.fn()} visible={false} />);
    expect(screen.queryByTestId('scanner-language-tooltip')).toBeNull();
  });
});

describe('ScanTargetPill round flag (Figma 2302:28968)', () => {
  it('shows the round US flag for EN and the drawn JP flag for JP', () => {
    const { rerender } = render(
      <ScanTargetPill flag="en" label="Pokémon EN" onPress={jest.fn()} testID="pill" />,
    );
    expect(screen.getByTestId('round-flag-en')).toBeTruthy();
    expect(screen.getByText('Pokémon EN')).toBeTruthy();

    rerender(<ScanTargetPill flag="jp" label="Pokémon JP" onPress={jest.fn()} testID="pill" />);
    expect(screen.getByTestId('round-flag-jp')).toBeTruthy();
    expect(screen.getByText('Pokémon JP')).toBeTruthy();
  });
});

describe('RoundFlag', () => {
  it('renders each language variant', () => {
    const { rerender } = render(<RoundFlag language="en" />);
    expect(screen.getByTestId('round-flag-en')).toBeTruthy();
    rerender(<RoundFlag language="jp" />);
    expect(screen.getByTestId('round-flag-jp')).toBeTruthy();
  });
});
