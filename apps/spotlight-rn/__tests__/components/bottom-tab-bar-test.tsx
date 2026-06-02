import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import {
  BottomTabBar,
  type BottomTabBarItem,
  SpotlightThemeProvider,
} from '@spotlight/design-system';

function makeItems(overrides: Partial<BottomTabBarItem>[] = []): BottomTabBarItem[] {
  const base: BottomTabBarItem[] = [
    {
      key: 'home',
      label: 'Home',
      icon: <Text>home-icon</Text>,
      selected: true,
      onPress: jest.fn(),
      testID: 'tab-home',
    },
    {
      key: 'scan',
      label: 'Scan',
      icon: <Text>scan-icon</Text>,
      onPress: jest.fn(),
      testID: 'tab-scan',
    },
  ];
  return base.map((item, index) => ({ ...item, ...overrides[index] }));
}

function renderBar(items = makeItems()) {
  const utils = render(
    <SpotlightThemeProvider>
      <BottomTabBar items={items} testID="bottom-tab-bar" />
    </SpotlightThemeProvider>,
  );
  return { ...utils, items };
}

describe('BottomTabBar', () => {
  it('renders each tab label and fires onPress', () => {
    const { items } = renderBar();

    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText('Scan')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tab-scan'));
    expect(items[1].onPress).toHaveBeenCalledTimes(1);
  });

  it('renders an indicator behind the selected tab', () => {
    renderBar();
    // The selected (Home) tab renders an icon-slot indicator.
    expect(screen.getByTestId('tab-home-indicator')).toBeTruthy();
  });

  it('exposes the full bar and collapsed pill via testID hooks', () => {
    renderBar();
    expect(screen.getByTestId('bottom-tab-bar')).toBeTruthy();
    expect(screen.getByTestId('bottom-tab-bar-collapsed')).toBeTruthy();
  });

  it('falls back to the first item as the collapsed-pill icon when none selected', () => {
    const items = makeItems([{ selected: false }, { selected: false }]);
    renderBar(items);
    // First item (Home) icon is shown both in the row and the collapsed pill.
    expect(screen.getAllByText('home-icon').length).toBeGreaterThanOrEqual(2);
  });
});
