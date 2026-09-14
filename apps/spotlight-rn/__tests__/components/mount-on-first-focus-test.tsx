import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { Platform, Text } from 'react-native';

import { MountOnFirstFocus } from '@/components/mount-on-first-focus';

/*
  Native tabs mount every tab at launch; on Android that pinned the JS thread
  for ~10s and made the tab bar unresponsive (Galaxy A17, 2026-09-13). These
  tests pin the contract: on Android an unfocused tab renders nothing until its
  FIRST focus and stays mounted afterwards; iOS and navigator-less renders are
  untouched.
*/

const mockIsFocused = jest.fn(() => false);
let mockHasNavigator = true;
jest.mock('@react-navigation/native', () => {
  const React = jest.requireActual('react');
  return {
    NavigationContext: React.createContext(undefined),
    useIsFocused: () => mockIsFocused(),
  };
});

const { NavigationContext: NavContext } = jest.requireMock('@react-navigation/native');

function renderInTabs(ui: React.ReactElement) {
  return render(
    mockHasNavigator ? <NavContext.Provider value={{}}>{ui}</NavContext.Provider> : ui,
  );
}

describe('MountOnFirstFocus', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    mockHasNavigator = true;
    mockIsFocused.mockReturnValue(false);
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('on Android, renders nothing until the tab is first focused, then stays mounted', () => {
    Platform.OS = 'android';
    const { rerender } = renderInTabs(
      <MountOnFirstFocus>
        <Text>heavy screen</Text>
      </MountOnFirstFocus>,
    );
    expect(screen.queryByText('heavy screen')).toBeNull();

    mockIsFocused.mockReturnValue(true);
    rerender(
      <NavContext.Provider value={{}}>
        <MountOnFirstFocus>
          <Text>heavy screen</Text>
        </MountOnFirstFocus>
      </NavContext.Provider>,
    );
    expect(screen.getByText('heavy screen')).toBeTruthy();

    mockIsFocused.mockReturnValue(false);
    rerender(
      <NavContext.Provider value={{}}>
        <MountOnFirstFocus>
          <Text>heavy screen</Text>
        </MountOnFirstFocus>
      </NavContext.Provider>,
    );
    expect(screen.getByText('heavy screen')).toBeTruthy();
  });

  it('on iOS, renders immediately even when unfocused', () => {
    Platform.OS = 'ios';
    renderInTabs(
      <MountOnFirstFocus>
        <Text>heavy screen</Text>
      </MountOnFirstFocus>,
    );
    expect(screen.getByText('heavy screen')).toBeTruthy();
  });

  it('renders immediately outside a navigator', () => {
    Platform.OS = 'android';
    mockHasNavigator = false;
    renderInTabs(
      <MountOnFirstFocus>
        <Text>heavy screen</Text>
      </MountOnFirstFocus>,
    );
    expect(screen.getByText('heavy screen')).toBeTruthy();
  });
});
