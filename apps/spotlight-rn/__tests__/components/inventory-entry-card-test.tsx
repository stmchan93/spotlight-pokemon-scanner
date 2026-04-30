import { render, screen } from '@testing-library/react-native';
import * as mockApiClient from '../mock-api-client';
import { mockInventoryEntries } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import { InventoryEntryCard } from '@/features/inventory/components/inventory-entry-card';

jest.mock('@spotlight/api-client', () => mockApiClient);

describe('InventoryEntryCard', () => {
  it('shows full raw condition labels instead of short labels when requested', () => {
    const entry = {
      ...mockInventoryEntries[0],
      conditionCode: 'near_mint' as const,
      conditionLabel: null,
      conditionShortLabel: 'NM',
    };

    render(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={entry} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('Near Mint')).toBeTruthy();
    expect(screen.queryByText(/^NM$/)).toBeNull();
  });

  it('maps remaining shorthand condition codes to full labels', () => {
    const baseEntry = {
      ...mockInventoryEntries[0],
      conditionCode: null,
      conditionLabel: null,
    };

    const { rerender } = render(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={{ ...baseEntry, conditionShortLabel: 'MP' }} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('Moderately Played')).toBeTruthy();

    rerender(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={{ ...baseEntry, conditionShortLabel: 'HP' }} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('Heavily Played')).toBeTruthy();

    rerender(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={{ ...baseEntry, conditionShortLabel: 'D' }} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('Damaged')).toBeTruthy();
  });

  it('combines condition and meaningful variant labels on raw entries', () => {
    const entry = {
      ...mockInventoryEntries[0],
      conditionCode: 'lightly_played' as const,
      conditionLabel: null,
      conditionShortLabel: 'LP',
      variantName: 'Reverse Holofoil',
    };

    render(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={entry} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('Lightly Played • Reverse Holofoil')).toBeTruthy();
  });

  it('omits generic raw variant labels from the descriptor line', () => {
    const entry = {
      ...mockInventoryEntries[0],
      conditionCode: 'near_mint' as const,
      conditionLabel: null,
      conditionShortLabel: 'NM',
      variantName: 'raw',
    };

    render(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={entry} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('Near Mint')).toBeTruthy();
    expect(screen.queryByText('Near Mint • raw')).toBeNull();
  });

  it('shows a dash when a row-specific market price is unavailable', () => {
    const entry = {
      ...mockInventoryEntries[0],
      marketPrice: 0,
      hasMarketPrice: false,
    };

    render(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={entry} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders a stable raw smoke selector keyed by card id', () => {
    render(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={mockInventoryEntries[0]} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByTestId('inventory-entry-smoke-raw-mcdonalds25-16')).toBeTruthy();
  });

  it('renders a stable graded smoke selector keyed by grader tuple', () => {
    const entry = {
      ...mockInventoryEntries[0],
      cardId: 'base1-4',
      id: 'entry-graded',
      kind: 'graded' as const,
      slabContext: {
        grader: ' PSA ',
        grade: ' 10 ',
        certNumber: ' 1234 5678 ',
      },
      variantName: 'Unlimited',
    };

    render(
      <SpotlightThemeProvider>
        <InventoryEntryCard entry={entry} showConditionLabel />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByTestId('inventory-entry-smoke-graded-base1-4-psa-10-1234-5678')).toBeTruthy();
  });
});
