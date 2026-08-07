import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { render, screen } from '@testing-library/react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { CollectionNavSymbol } from '@/components/nav-tab-symbols';

jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));
jest.mock('expo-symbols', () => ({
  SymbolView: (props: Record<string, unknown>) => {
    // Required inline because a jest.mock factory is hoisted above the imports
    // and cannot close over one.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { View } = require('react-native');
    return <View testID="sf-symbol" {...props} />;
  },
}));

const probe = requireOptionalNativeModule as jest.Mock;

/**
 * The bar swapped its hand-drawn Figma glyphs for SF Symbols so it reads as the
 * system tab bar. That puts a native module on the render path of the app's most
 * visible chrome, which is exactly the shape of the expo-image-picker bug: a
 * probe that silently never matches disabled photo upload on every build.
 *
 * So these assert the two directions that bug had no test for — the module being
 * present, and the module being absent degrading rather than crashing.
 */
describe('nav tab symbols', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOS;
    probe.mockReset();
  });

  it('probes the module name expo-symbols actually registers', () => {
    // THE test. The first version of this file mocked the probe but never
    // checked WHICH name it asked for, so it passed against 'ExpoSymbols' — the
    // CocoaPod's name, not the module's — and the bar shipped still rendering
    // its old glyphs. Read the name back out of the installed package so a typo
    // or a future rename fails here instead of degrading silently in the field.
    // Read by path, not require.resolve: jest's resolver intercepts that and
    // cannot see a package this file has mocked. Checks both the hoisted root
    // and a local install so pnpm's layout can change without breaking this.
    const candidates = [
      resolvePath(__dirname, '../../../../node_modules/expo-symbols/build/SymbolModule.js'),
      resolvePath(__dirname, '../../node_modules/expo-symbols/build/SymbolModule.js'),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    expect(found).toBeTruthy();
    const source = readFileSync(found as string, 'utf8');
    const registered = /requireNativeModule\(\s*['"]([^'"]+)['"]\s*\)/.exec(source)?.[1];
    expect(registered).toBe('SymbolModule');

    Platform.OS = 'ios';
    probe.mockReturnValue({});
    render(<CollectionNavSymbol color="#1A1A1A" size={22} />);

    expect(probe).toHaveBeenCalledWith(registered);
  });

  it('renders the SF Symbol when the native module is in the binary', () => {
    Platform.OS = 'ios';
    probe.mockReturnValue({});

    render(<CollectionNavSymbol color="#1A1A1A" size={22} />);

    expect(screen.getByTestId('sf-symbol').props.name).toBe('square.grid.2x2');
  });

  it('renders the filled variant when selected, matching UIKit', () => {
    Platform.OS = 'ios';
    probe.mockReturnValue({});

    render(<CollectionNavSymbol color="#1A1A1A" filled size={22} />);

    expect(screen.getByTestId('sf-symbol').props.name).toBe('square.grid.2x2.fill');
  });

  it('falls back to the Figma glyph instead of crashing when the module is missing', () => {
    Platform.OS = 'ios';
    probe.mockReturnValue(null);

    render(<CollectionNavSymbol color="#1A1A1A" size={22} />);

    // The bar still draws — a missing native module must degrade, never take
    // the tab bar down with it.
    expect(screen.queryByTestId('sf-symbol')).toBeNull();
  });

  it('never probes for SF Symbols off iOS', () => {
    Platform.OS = 'android';
    probe.mockReturnValue({});

    render(<CollectionNavSymbol color="#1A1A1A" size={22} />);

    expect(screen.queryByTestId('sf-symbol')).toBeNull();
  });
});
