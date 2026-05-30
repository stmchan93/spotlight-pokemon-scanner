import { fireEvent, render, screen } from '@testing-library/react-native';

import { ListPaginationFooter, SpotlightThemeProvider } from '@spotlight/design-system';

import * as mockApiClient from '../mock-api-client';

jest.mock('@spotlight/api-client', () => mockApiClient);

type RenderOptions = Partial<React.ComponentProps<typeof ListPaginationFooter>>;

function renderFooter(overrides: RenderOptions = {}) {
  const props: React.ComponentProps<typeof ListPaginationFooter> = {
    canViewMore: true,
    onViewMore: jest.fn(),
    ...overrides,
  };

  const utils = render(
    <SpotlightThemeProvider>
      <ListPaginationFooter {...props} />
    </SpotlightThemeProvider>,
  );

  return { ...utils, props };
}

describe('ListPaginationFooter', () => {
  it('renders the View More button with the default label and calls onViewMore when pressed', () => {
    const onViewMore = jest.fn();
    renderFooter({ canViewMore: true, onViewMore });

    const button = screen.getByTestId('list-pagination-footer-view-more');
    expect(button).toBeTruthy();
    expect(screen.getByText('View More')).toBeTruthy();

    fireEvent.press(button);
    expect(onViewMore).toHaveBeenCalledTimes(1);
  });

  it('renders a custom viewMoreLabel', () => {
    renderFooter({ canViewMore: true, viewMoreLabel: 'Show all 24' });

    expect(screen.getByText('Show all 24')).toBeTruthy();
    expect(screen.queryByText('View More')).toBeNull();
  });

  it('renders the Back to top button and calls onBackToTop when pressed', () => {
    const onBackToTop = jest.fn();
    renderFooter({ canViewMore: true, onBackToTop });

    const button = screen.getByTestId('list-pagination-footer-back-to-top');
    expect(button).toBeTruthy();

    fireEvent.press(button);
    expect(onBackToTop).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when canViewMore is false and no onBackToTop is provided', () => {
    renderFooter({ canViewMore: false, onBackToTop: undefined });

    expect(screen.queryByTestId('list-pagination-footer')).toBeNull();
    expect(screen.queryByTestId('list-pagination-footer-view-more')).toBeNull();
    expect(screen.queryByTestId('list-pagination-footer-back-to-top')).toBeNull();
  });
});
