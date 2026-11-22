import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { VendorBoughtLog } from '@spotlight/api-client';

import { VendorBoughtScreen, boughtEntryDetail } from '@/features/vendor/screens/vendor-bought-screen';
import { VendorSettingsScreen, vendorSettingsPatchFromDraft } from '@/features/vendor/screens/vendor-settings-screen';
import { resetVendorSettingsCache } from '@/features/vendor/use-vendor-settings';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

const log: VendorBoughtLog = {
  entries: [
    {
      batchId: 'b1',
      lineIndex: 0,
      cardId: 'sv3pt5-199',
      name: 'Charizard ex',
      setName: '151',
      number: '199/165',
      imageUrl: 'https://cdn.test/c.png',
      variantName: 'Holofoil',
      condition: 'near_mint',
      grader: null,
      grade: null,
      quantity: 1,
      paidUsd: 201.55,
      marketAtBuyUsd: 287.93,
      currentValueUsd: 300,
      profitUsd: 98.45,
      boughtAt: '2026-11-21T18:00:00Z',
    },
    {
      batchId: 'b1',
      lineIndex: 1,
      cardId: 'base1-58',
      name: 'Pikachu',
      setName: 'Base',
      number: '58/102',
      imageUrl: null,
      variantName: null,
      condition: null,
      grader: 'PSA',
      grade: '9',
      quantity: 2,
      paidUsd: 12,
      marketAtBuyUsd: 20,
      currentValueUsd: null,
      profitUsd: null,
      boughtAt: '2026-11-21T18:00:00Z',
    },
  ],
  summary: { count: 2, paidUsd: 213.55, marketAtBuyUsd: 307.93, currentValueUsd: 300 },
};

describe('VendorBoughtScreen', () => {
  it('lists date, cards, paid, market, current value and profit', async () => {
    const repository = createTestSpotlightRepository({ fetchVendorBoughtLog: async () => log });
    renderWithProviders(<VendorBoughtScreen onBack={jest.fn()} />, { spotlightRepository: repository });

    expect(await screen.findByText('Charizard ex')).toBeTruthy();
    expect(screen.getByText('Pikachu ×2')).toBeTruthy();
    expect(screen.getByText('Paid $201.55')).toBeTruthy();
    expect(screen.getByText('Mkt $287.93 · Now $300.00')).toBeTruthy();
    expect(screen.getByText('+$98.45')).toBeTruthy();
    expect(screen.getByText('Mkt $20.00 · Now —')).toBeTruthy();
    expect(screen.getAllByText('Nov 21, 2026').length).toBe(2);
    expect(screen.getByTestId('vendor-bought-summary')).toHaveTextContent(/\$213\.55/);
    expect(screen.getByTestId('vendor-bought-total-profit')).toHaveTextContent('+$98.45 profit on priced cards');
    expect(screen.queryByText(/¥/)).toBeNull();
  });

  it('shows an empty state and a retry on failure', async () => {
    const empty = createTestSpotlightRepository({
      fetchVendorBoughtLog: async () => ({ entries: [], summary: { count: 0, paidUsd: 0, marketAtBuyUsd: 0, currentValueUsd: 0 } }),
    });
    const { unmount } = renderWithProviders(<VendorBoughtScreen />, { spotlightRepository: empty });
    expect(await screen.findByTestId('vendor-bought-empty')).toBeTruthy();
    unmount();

    const fetch = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(log);
    const failing = createTestSpotlightRepository({ fetchVendorBoughtLog: fetch });
    renderWithProviders(<VendorBoughtScreen />, { spotlightRepository: failing });
    expect(await screen.findByTestId('vendor-bought-error')).toBeTruthy();
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('Charizard ex')).toBeTruthy();
  });

  it('describes a row by printing and condition or grade', () => {
    expect(boughtEntryDetail(log.entries[0])).toBe('151 · #199/165 · Holofoil · NM');
    expect(boughtEntryDetail(log.entries[1])).toBe('Base · #58/102 · PSA 9');
  });
});

describe('VendorSettingsScreen', () => {
  beforeEach(() => {
    resetVendorSettingsCache();
  });

  it('validates the draft', () => {
    const draft = {
      buyPercent: '70',
      sellPercent: '100',
      tiersEnabled: true,
      tiers: { bulk: '40', under50: '60', over50: '70', slab: '70' },
    };
    expect(vendorSettingsPatchFromDraft(draft)).toEqual({
      patch: {
        buyPercent: 70,
        sellPercent: 100,
        tiersEnabled: true,
        tiers: { bulk: 40, under50: 60, over50: 70, slab: 70 },
      },
    });
    expect(vendorSettingsPatchFromDraft({ ...draft, sellPercent: '130' })).toEqual({
      error: 'Sell price must be 85–120% of market.',
    });
    expect(vendorSettingsPatchFromDraft({ ...draft, tiers: { ...draft.tiers, bulk: '0' } })).toEqual({
      error: 'Bulk (under $5) must be 1–100% of market.',
    });
  });

  it('loads the saved rates and saves an edit', async () => {
    const setVendorSettings = jest.fn(async (patch: any) => ({
      buyPercent: 70,
      sellPercent: patch.sellPercent,
      tiersEnabled: true,
      tiers: { bulk: 40, under50: 60, over50: 70, slab: 70 },
      bulkMaxUsd: 5,
    }));
    const repository = createTestSpotlightRepository({
      getVendorSettings: async () => ({
        buyPercent: 70,
        sellPercent: 110,
        tiersEnabled: true,
        tiers: { bulk: 40, under50: 60, over50: 70, slab: 75 },
        bulkMaxUsd: 5,
      }),
      setVendorSettings,
    });
    renderWithProviders(<VendorSettingsScreen />, { spotlightRepository: repository });

    await waitFor(() => {
      expect(screen.getByTestId('vendor-settings-tier-slab').props.value).toBe('75');
    });
    fireEvent.changeText(screen.getByTestId('vendor-settings-sell'), '105');
    fireEvent.press(screen.getByTestId('vendor-settings-save'));
    await waitFor(() => {
      expect(setVendorSettings).toHaveBeenCalledWith(expect.objectContaining({ sellPercent: 105, tiersEnabled: true }));
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });
});
