import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { AccessibilityInfo, Dimensions, Modal, StyleSheet } from 'react-native';

import {
  POPOVER_MIN_SCALE,
  SpotlightThemeProvider,
  popoverTransformOrigin,
} from '@spotlight/design-system';

import { InventoryEntryMenu } from '@/features/cards/components/inventory-entry-menu';
import { AddAllMenu } from '@/features/scanner/components/add-all-menu';
import { BinderLayoutMenu } from '@/features/scanner/components/binder-layout-menu';
import { AnchoredOptionMenu, PrintingMenu } from '@/features/scanner/components/printing-menu';

function Wrapper({ children }: PropsWithChildren) {
  return <SpotlightThemeProvider>{children}</SpotlightThemeProvider>;
}

// The exit animation's completion hops back to JS on a microtask (worklets mock).
const flushExit = () => act(async () => {});

const anchor = { x: 40, y: 120, width: 80, height: 32 };

function cardStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style) as {
    opacity?: number;
    transform?: { scale: number }[];
    transformOrigin?: unknown;
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('popoverTransformOrigin', () => {
  it('grows from the trigger center on the edge facing it', () => {
    expect(popoverTransformOrigin({ anchor, cardLeft: 40, cardWidth: 180, opensUp: false }))
      .toEqual([40, 0, 0]);
    expect(popoverTransformOrigin({ anchor, cardLeft: 40, cardWidth: 180, opensUp: true }))
      .toEqual([40, '100%', 0]);
  });

  it('clamps to the card and falls back to the top-left without an anchor', () => {
    expect(popoverTransformOrigin({ anchor, cardLeft: 200, cardWidth: 180, opensUp: false }))
      .toEqual([0, 0, 0]);
    expect(popoverTransformOrigin({ anchor: null, cardLeft: 16, cardWidth: 180, opensUp: false }))
      .toEqual([0, 0, 0]);
  });
});

describe('popover menus animate out before reporting', () => {
  it('AddAllMenu anchors its origin to the bottom when it flips up', () => {
    const { height } = Dimensions.get('window');
    render(
      <AddAllMenu
        anchor={{ x: 40, y: height - 40, width: 80, height: 32 }}
        onClose={jest.fn()}
        onSelect={jest.fn()}
        visible
      />,
      { wrapper: Wrapper },
    );
    expect(cardStyle('add-all-menu').transformOrigin).toEqual([40, '100%', 0]);
  });

  it('PrintingMenu: selecting a printing fires onSelect once, not onClose', async () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    const variants = [
      { variant: 'Holofoil', variantKey: 'holofoil' },
      { variant: 'Reverse Holofoil', variantKey: 'reverse' },
    ] as unknown as Parameters<typeof PrintingMenu>[0]['variants'];
    render(
      <PrintingMenu
        anchor={anchor}
        onClose={onClose}
        onSelect={onSelect}
        selectedVariantKey="holofoil"
        variants={variants}
        visible
      />,
      { wrapper: Wrapper },
    );

    fireEvent.press(screen.getByTestId('printing-menu-reverse'));
    fireEvent.press(screen.getByTestId('printing-menu-holofoil'));
    await flushExit();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(variants[1]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('AnchoredOptionMenu: backdrop + Android back close exactly once', async () => {
    const onClose = jest.fn();
    render(
      <AnchoredOptionMenu
        anchor={anchor}
        onClose={onClose}
        onSelect={jest.fn()}
        options={[{ key: 'a', label: 'A' }]}
        selectedKey="a"
        visible
      />,
      { wrapper: Wrapper },
    );

    fireEvent.press(screen.getByTestId('option-menu-backdrop'));
    fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose');
    await flushExit();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('BinderLayoutMenu: selecting a layout fires onSelect once', async () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    render(
      <BinderLayoutMenu
        anchor={anchor}
        onClose={onClose}
        onSelect={onSelect}
        selected="single"
        visible
      />,
      { wrapper: Wrapper },
    );

    fireEvent.press(screen.getByTestId('binder-layout-menu-single'));
    fireEvent.press(screen.getByTestId('binder-layout-menu-backdrop'));
    await flushExit();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('single');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('InventoryEntryMenu: each action fires once; backdrop closes once', async () => {
    const onAdd = jest.fn();
    const onDelete = jest.fn();
    const onClose = jest.fn();
    const { rerender } = render(
      <InventoryEntryMenu
        anchor={anchor}
        onAdd={onAdd}
        onClose={onClose}
        onDelete={onDelete}
        visible
      />,
      { wrapper: Wrapper },
    );

    fireEvent.press(screen.getByTestId('inventory-entry-menu-delete'));
    fireEvent.press(screen.getByTestId('inventory-entry-menu-add'));
    await flushExit();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();

    // Parent closes, then reopens: the menu is live again.
    rerender(
      <InventoryEntryMenu anchor={anchor} onAdd={onAdd} onClose={onClose} onDelete={onDelete} visible={false} />,
    );
    rerender(
      <InventoryEntryMenu anchor={anchor} onAdd={onAdd} onClose={onClose} onDelete={onDelete} visible />,
    );
    fireEvent.press(screen.getByTestId('inventory-entry-menu-backdrop'));
    fireEvent.press(screen.getByTestId('inventory-entry-menu-backdrop'));
    await flushExit();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('reduce motion', () => {
  async function openAfterSettingResolves(reduceMotion: boolean) {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduceMotion);
    const props = { anchor, onClose: jest.fn(), onSelect: jest.fn() };
    const { rerender } = render(<AddAllMenu {...props} visible={false} />, { wrapper: Wrapper });
    await act(async () => {});
    // The first open frame (before the open animation starts) shows the start pose.
    rerender(<AddAllMenu {...props} visible />);
    return props;
  }

  it('starts scaled down and transparent by default', async () => {
    await openAfterSettingResolves(false);
    const style = cardStyle('add-all-menu');
    expect(style.opacity).toBe(0);
    expect(style.transform).toEqual([{ scale: POPOVER_MIN_SCALE }]);
  });

  it('fades only (no scale) when Reduce Motion is on, and still closes once', async () => {
    const props = await openAfterSettingResolves(true);
    const style = cardStyle('add-all-menu');
    expect(style.opacity).toBe(0);
    expect(style.transform).toEqual([{ scale: 1 }]);

    fireEvent.press(screen.getByTestId('add-all-menu-backdrop'));
    fireEvent.press(screen.getByTestId('add-all-menu-backdrop'));
    await flushExit();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
