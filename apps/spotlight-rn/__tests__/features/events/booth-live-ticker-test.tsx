import { act, fireEvent, screen } from '@testing-library/react-native';

import type { BoothTickerItem } from '@/features/events/booth-ticker';
import { BoothLiveTicker, TICKER_ROTATE_MS } from '@/features/events/components/booth-live-ticker';
import { useReduceMotion } from '@/features/scanner/use-reduce-motion';

import { renderWithProviders } from '../../test-utils';

jest.mock('@/features/scanner/use-reduce-motion', () => ({ useReduceMotion: jest.fn(() => false) }));

const ITEMS: BoothTickerItem[] = [
  { key: 'post:p1', text: '📸 Island Slabs posted · 3m', vendorId: 'island' },
  { key: 'hot:v', text: '🔥 Mock Vintage is busy right now', vendorId: 'vintage' },
  { key: 'browsing', text: '👀 42 people browsing', vendorId: null },
];

const text = () => screen.getByTestId('booth-live-ticker-text').props.children;

describe('BoothLiveTicker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rotates one line at a time and wraps around', () => {
    renderWithProviders(<BoothLiveTicker items={ITEMS} onSelectVendor={jest.fn()} />);
    expect(text()).toBe(ITEMS[0]!.text);
    act(() => jest.advanceTimersByTime(TICKER_ROTATE_MS));
    expect(text()).toBe(ITEMS[1]!.text);
    act(() => jest.advanceTimersByTime(TICKER_ROTATE_MS * 2));
    expect(text()).toBe(ITEMS[0]!.text);
  });

  it('vendor lines select the vendor; the browsing line does nothing', () => {
    const onSelectVendor = jest.fn();
    renderWithProviders(<BoothLiveTicker items={ITEMS} onSelectVendor={onSelectVendor} />);
    fireEvent.press(screen.getByTestId('booth-live-ticker'));
    expect(onSelectVendor).toHaveBeenCalledWith('island');

    act(() => jest.advanceTimersByTime(TICKER_ROTATE_MS * 2));
    expect(text()).toBe(ITEMS[2]!.text);
    onSelectVendor.mockClear();
    fireEvent.press(screen.getByTestId('booth-live-ticker'));
    expect(onSelectVendor).not.toHaveBeenCalled();
  });

  it('renders nothing without items, and a single item never rotates', () => {
    const { rerender } = renderWithProviders(<BoothLiveTicker items={[]} onSelectVendor={jest.fn()} />);
    expect(screen.queryByTestId('booth-live-ticker')).toBeNull();
    rerender(<BoothLiveTicker items={ITEMS.slice(0, 1)} onSelectVendor={jest.fn()} />);
    act(() => jest.advanceTimersByTime(TICKER_ROTATE_MS * 3));
    expect(text()).toBe(ITEMS[0]!.text);
  });

  it('still rotates with reduced motion on', () => {
    jest.mocked(useReduceMotion).mockReturnValue(true);
    renderWithProviders(<BoothLiveTicker items={ITEMS} onSelectVendor={jest.fn()} />);
    act(() => jest.advanceTimersByTime(TICKER_ROTATE_MS));
    expect(text()).toBe(ITEMS[1]!.text);
  });
});
