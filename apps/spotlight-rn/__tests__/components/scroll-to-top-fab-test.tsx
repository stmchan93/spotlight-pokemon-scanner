import { useRef } from 'react';
import { Pressable, Text, View, type ScrollView } from 'react-native';
import { fireEvent, screen } from '@testing-library/react-native';

import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';

import { renderWithProviders } from '../test-utils';

function scrollEvent(y: number) {
  return { nativeEvent: { contentOffset: { y } } } as any;
}

function layoutEvent(height: number) {
  return { nativeEvent: { layout: { height } } } as any;
}

type HarnessProps = {
  onScroll?: (event: any) => void;
  scrollTo?: (args: { y: number; animated: boolean }) => void;
  /** See the hook: negative for a scroller UIKit has inset. */
  topOffset?: number;
};

function HookHarness({ onScroll, scrollTo, topOffset }: HarnessProps) {
  const ref = useRef<ScrollView | null>({ scrollTo } as unknown as ScrollView);
  const { isVisible, handleScroll, handleLayout, scrollToTop } = useScrollToTop(
    ref,
    onScroll,
    topOffset,
  );

  return (
    <View>
      <Text testID="visible">{isVisible ? 'yes' : 'no'}</Text>
      <Pressable testID="layout" onPress={() => handleLayout(layoutEvent(800))} />
      <Pressable testID="scroll-near" onPress={() => handleScroll(scrollEvent(120))} />
      <Pressable testID="scroll-far" onPress={() => handleScroll(scrollEvent(1200))} />
      {/* Just past one viewport of TRAVEL on a page resting at -59 (760 + 59 =
          819 > 800), but short of it by the raw-offset arithmetic (760 < 800) —
          the only band where the fix is observable. */}
      <Pressable testID="scroll-inset-edge" onPress={() => handleScroll(scrollEvent(760))} />
      <Pressable testID="to-top" onPress={scrollToTop} />
    </View>
  );
}

describe('useScrollToTop', () => {
  it('is hidden until the user scrolls past one viewport height', () => {
    renderWithProviders(<HookHarness />);

    expect(screen.getByTestId('visible').props.children).toBe('no');

    // Measure the viewport (800), then a short scroll stays hidden.
    fireEvent.press(screen.getByTestId('layout'));
    fireEvent.press(screen.getByTestId('scroll-near'));
    expect(screen.getByTestId('visible').props.children).toBe('no');

    // Scrolling past the viewport reveals the button.
    fireEvent.press(screen.getByTestId('scroll-far'));
    expect(screen.getByTestId('visible').props.children).toBe('yes');
  });

  it('forwards scroll events to the composed handler', () => {
    const onScroll = jest.fn();
    renderWithProviders(<HookHarness onScroll={onScroll} />);

    fireEvent.press(screen.getByTestId('scroll-near'));
    expect(onScroll).toHaveBeenCalledTimes(1);
  });

  it('scrolls the list to the top via the ref', () => {
    const scrollTo = jest.fn();
    renderWithProviders(<HookHarness scrollTo={scrollTo} />);

    fireEvent.press(screen.getByTestId('to-top'));
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
  });

  /*
    An inset scroller (`contentInsetAdjustmentBehavior="automatic"`) RESTS at
    `-adjustedContentInset.top`, not at 0 — the Portfolio pager's `pageTop`. The
    hook assumed 0 in both places it touched an offset, so "Back to top" stopped
    a status bar short of the top and the button appeared a status bar late.
  */
  describe('on a scroller UIKit has inset', () => {
    it('scrolls to the real top, not to 0', () => {
      const scrollTo = jest.fn();
      renderWithProviders(<HookHarness scrollTo={scrollTo} topOffset={-59} />);

      fireEvent.press(screen.getByTestId('to-top'));
      expect(scrollTo).toHaveBeenCalledWith({ y: -59, animated: true });
    });

    it('measures travel from that top, so the button is not revealed late', () => {
      renderWithProviders(<HookHarness topOffset={-59} />);
      fireEvent.press(screen.getByTestId('layout'));

      // Deliberately inside the 59pt band where the two arithmetics disagree:
      // 760 of raw offset is 819 of real travel, past the 800 viewport. The old
      // code compared 760 > 800 and kept the button hidden. A larger scroll
      // (1200) would pass either way and prove nothing.
      fireEvent.press(screen.getByTestId('scroll-inset-edge'));
      expect(screen.getByTestId('visible').props.children).toBe('yes');
    });

    it('still measures travel from 0 on an ordinary scroller', () => {
      renderWithProviders(<HookHarness />);
      fireEvent.press(screen.getByTestId('layout'));

      // Same 760, no inset: genuinely short of the viewport, so it stays hidden.
      // This is what stops the fix leaking onto every other screen.
      fireEvent.press(screen.getByTestId('scroll-inset-edge'));
      expect(screen.getByTestId('visible').props.children).toBe('no');
    });

    it('leaves an ordinary scroller alone (the default is 0)', () => {
      const scrollTo = jest.fn();
      renderWithProviders(<HookHarness scrollTo={scrollTo} />);

      fireEvent.press(screen.getByTestId('to-top'));
      expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
    });
  });
});

describe('ScrollToTopFab', () => {
  it('invokes onPress when visible', () => {
    const onPress = jest.fn();
    renderWithProviders(
      <ScrollToTopFab onPress={onPress} testID="fab-visible" visible />,
    );

    fireEvent.press(screen.getByTestId('fab-visible'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
