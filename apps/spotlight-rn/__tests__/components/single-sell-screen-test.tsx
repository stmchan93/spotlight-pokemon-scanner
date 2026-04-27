import { act, fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SingleSellScreen } from '@/features/sell/screens/single-sell-screen';

import { renderWithProviders } from '../test-utils';

describe('SingleSellScreen', () => {
  it('renders the sell summary and can reveal the bought price', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Oshawott')).toBeTruthy();
    expect(screen.getByTestId('single-sell-summary-card')).toBeTruthy();
    expect(screen.getByText('Swipe up to confirm sale')).toBeTruthy();
    expect(screen.getByText('*****')).toBeTruthy();
    expect(screen.getByTestId('single-sell-toggle-bought-price-hidden-icon')).toBeTruthy();
    expect(screen.queryByText('Show')).toBeNull();
    expect(screen.getByTestId('single-sell-offer-price').props.placeholder).toBe('$0.00');
    expect(screen.getByTestId('single-sell-your-price').props.placeholder).toBe('$0.00');
    expect(screen.getByTestId('single-sell-sold-price').props.placeholder).toBe('$0.00');
    expect(screen.queryByText('Enter a sell price first.')).toBeNull();

    fireEvent.press(screen.getByTestId('single-sell-toggle-bought-price'));

    expect(screen.getByText('$0.25')).toBeTruthy();
    expect(screen.getByTestId('single-sell-toggle-bought-price-visible-icon')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-toggle-bought-price'));

    expect(screen.getByText('*****')).toBeTruthy();
    expect(screen.getByTestId('single-sell-toggle-bought-price-hidden-icon')).toBeTruthy();
  });

  it('shows the reversed YP percent when offer is lower than your price', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    await screen.findByText('Oshawott');

    fireEvent.changeText(screen.getByTestId('single-sell-offer-price'), '0.45');
    fireEvent.changeText(screen.getByTestId('single-sell-your-price'), '0.51');

    expect(screen.getByText('88.23% YP')).toBeTruthy();
  });

  it('renders the sell-price validation directly under the input', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    await screen.findByText('Oshawott');

    await act(async () => {
      screen.getByTestId('single-sell-swipe-rail').props.onResponderRelease({
        nativeEvent: {},
      });
    });

    expect(screen.getByTestId('single-sell-error-message')).toBeTruthy();
    expect(screen.getByText('Enter a sell price before confirming sale.')).toBeTruthy();
  });

  it('renders a compact photo row and swaps the camera icon for a thumbnail after capture', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    await screen.findByText('Oshawott');

    expect(screen.getByText('Photo (optional)')).toBeTruthy();
    expect(screen.queryByText('Transaction Photo')).toBeNull();
    expect(screen.queryByText('Add photo')).toBeNull();
    expect(screen.getByTestId('single-sell-photo-camera-icon')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-transaction-photo').props.style)).toMatchObject({
      gap: 6,
      paddingVertical: 4,
    });

    fireEvent.press(screen.getByTestId('single-sell-photo-trigger'));
    expect(await screen.findByTestId('single-sell-camera')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText('Capture photo').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByText('Cancel').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('single-sell-capture-photo'));
    });

    expect(screen.getByTestId('single-sell-photo-thumbnail')).toBeTruthy();
    expect(screen.queryByTestId('single-sell-photo-camera-icon')).toBeNull();
  });

  it('supports closing directly from the top chrome', async () => {
    const onClose = jest.fn();

    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={onClose}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('wires the top chrome with responder handlers for swipe-down dismissal', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();
    expect(screen.getByTestId('single-sell-top-chrome').props.onMoveShouldSetResponder).toBeDefined();
    expect(screen.getByTestId('single-sell-top-chrome').props.onResponderMove).toBeDefined();
    expect(screen.getByTestId('single-sell-top-chrome').props.onResponderRelease).toBeDefined();
  });

  it('uses the full swipe rail as the responder surface and body typography for the prompt', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();

    expect(screen.getByTestId('single-sell-swipe-rail').props.onMoveShouldSetResponder).toBeDefined();
    expect(screen.getByTestId('single-sell-swipe-rail').props.onResponderMove).toBeDefined();
    expect(screen.getByTestId('single-sell-swipe-rail').props.onResponderRelease).toBeDefined();
    expect(screen.getByTestId('single-sell-confirmation-prompt').props.pointerEvents).toBe('none');
    expect(
      StyleSheet.flatten(screen.getByText('Swipe up to confirm sale').props.style),
    ).toMatchObject({
      fontSize: 16,
      lineHeight: 22,
    });
  });
});
