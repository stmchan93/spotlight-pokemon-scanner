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
};

function HookHarness({ onScroll, scrollTo }: HarnessProps) {
  const ref = useRef<ScrollView | null>({ scrollTo } as unknown as ScrollView);
  const { isVisible, handleScroll, handleLayout, scrollToTop } = useScrollToTop(
    ref,
    onScroll,
  );

  return (
    <View>
      <Text testID="visible">{isVisible ? 'yes' : 'no'}</Text>
      <Pressable testID="layout" onPress={() => handleLayout(layoutEvent(800))} />
      <Pressable testID="scroll-near" onPress={() => handleScroll(scrollEvent(120))} />
      <Pressable testID="scroll-far" onPress={() => handleScroll(scrollEvent(1200))} />
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
