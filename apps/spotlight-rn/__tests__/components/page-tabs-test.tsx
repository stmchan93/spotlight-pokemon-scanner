import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { PageTabs, colors } from '@spotlight/design-system';

import { renderWithProviders } from '../test-utils';

type TabValue = 'portfolio' | 'recent-sales' | 'favorites';

const TABS: readonly { value: TabValue; label: string }[] = [
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'recent-sales', label: 'Recent Sales' },
  { value: 'favorites', label: 'Favorites' },
];

describe('PageTabs', () => {
  it('renders every tab label from the tabs array', () => {
    renderWithProviders(
      <PageTabs<TabValue>
        tabs={TABS}
        value="portfolio"
        onChange={jest.fn()}
        testID="page-tabs"
      />,
    );

    expect(screen.getByText('Portfolio')).toBeTruthy();
    expect(screen.getByText('Recent Sales')).toBeTruthy();
    expect(screen.getByText('Favorites')).toBeTruthy();
  });

  it('marks the tab matching value as selected via accessibilityState', () => {
    renderWithProviders(
      <PageTabs<TabValue>
        tabs={TABS}
        value="recent-sales"
        onChange={jest.fn()}
        testID="page-tabs"
      />,
    );

    const selectedTab = screen.getByTestId('page-tabs-tab-recent-sales');
    const otherTab = screen.getByTestId('page-tabs-tab-portfolio');

    expect(selectedTab.props.accessibilityState).toMatchObject({ selected: true });
    expect(otherTab.props.accessibilityState).toMatchObject({ selected: false });
  });

  // Figma 3456:3193 gives each tab a box wider than its word and runs the
  // underline edge to edge of it. The rule used to hug the label with a 4pt
  // negative margin, which read as clipped to the word rather than marking the
  // tab. Padding on the TAB is what sets the width now, so the underline must
  // stretch and must NOT claw any of it back.
  it('runs the underline 12pt past the label on each side', () => {
    renderWithProviders(
      <PageTabs<TabValue>
        tabs={TABS}
        value="portfolio"
        onChange={jest.fn()}
        testID="page-tabs"
      />,
    );

    const tabStyle = StyleSheet.flatten(
      screen.getByTestId('page-tabs-tab-portfolio').props.style,
    );
    expect(tabStyle.paddingHorizontal).toBe(12);

    const underlineStyle = StyleSheet.flatten(
      screen.getByTestId('page-tabs-tab-portfolio-underline').props.style,
    );
    expect(underlineStyle.alignSelf).toBe('stretch');
    expect(underlineStyle.marginHorizontal).toBe(-12);
    expect(underlineStyle.height).toBe(2);
  });

  it('calls onChange with the tapped tab value', () => {
    const onChange = jest.fn();
    renderWithProviders(
      <PageTabs<TabValue>
        tabs={TABS}
        value="portfolio"
        onChange={onChange}
        testID="page-tabs"
      />,
    );

    fireEvent.press(screen.getByTestId('page-tabs-tab-favorites'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('favorites');
  });

  it('draws a gray rail spanning the full width under all tabs', () => {
    renderWithProviders(
      <PageTabs<TabValue>
        tabs={TABS}
        value="portfolio"
        onChange={jest.fn()}
        testID="page-tabs"
      />,
    );

    const rail = StyleSheet.flatten(screen.getByTestId('page-tabs-rail').props.style);
    expect(rail.backgroundColor).toBe(colors.gray300);
    // Edge to edge, not inset by the page gutter or the tab widths.
    expect(rail).toMatchObject({ position: 'absolute', left: 0, right: 0, bottom: 0 });
    expect(rail.height).toBeGreaterThan(0);
  });

  // Events (Figma 5476:7154) left-aligns the tabs on the page gutter; every
  // other screen keeps them centered.
  it('centers tabs by default and left-aligns them with align="start"', () => {
    // The row of tabs is the root's second child, after the rail.
    const tabRow = () => {
      const row = screen.getByTestId('page-tabs').children[1];
      return StyleSheet.flatten(typeof row === 'string' ? undefined : row.props.style);
    };

    const { rerender } = renderWithProviders(
      <PageTabs<TabValue> tabs={TABS} value="portfolio" onChange={jest.fn()} testID="page-tabs" />,
    );
    expect(tabRow().justifyContent).not.toBe('flex-start');

    rerender(
      <PageTabs<TabValue> align="start" tabs={TABS} value="portfolio" onChange={jest.fn()} testID="page-tabs" />,
    );
    expect(tabRow()).toMatchObject({ justifyContent: 'flex-start', gap: 14, paddingHorizontal: 14 });
  });

  it('exposes the container testID and per-tab testIDs', () => {
    renderWithProviders(
      <PageTabs<TabValue>
        tabs={TABS}
        value="portfolio"
        onChange={jest.fn()}
        testID="page-tabs"
      />,
    );

    expect(screen.getByTestId('page-tabs')).toBeTruthy();
    expect(screen.getByTestId('page-tabs-tab-portfolio')).toBeTruthy();
    expect(screen.getByTestId('page-tabs-tab-recent-sales')).toBeTruthy();
    expect(screen.getByTestId('page-tabs-tab-favorites')).toBeTruthy();
  });

  // Events region tabs (Figma 5862:6907): a compact rail that can outgrow the screen.
  it('compact + scrollable wraps the row in a horizontal scroll over a gray-100 rail', () => {
    renderWithProviders(
      <PageTabs<TabValue> scrollable size="compact" tabs={TABS} value="portfolio" onChange={jest.fn()} testID="page-tabs" />,
    );
    expect(screen.getByTestId('page-tabs-scroll').props.horizontal).toBe(true);
    expect(StyleSheet.flatten(screen.getByTestId('page-tabs-rail').props.style).backgroundColor).toBe(colors.gray100);
    expect(StyleSheet.flatten(screen.getByTestId('page-tabs-tab-favorites').props.style).paddingHorizontal).toBe(16);
  });
});
