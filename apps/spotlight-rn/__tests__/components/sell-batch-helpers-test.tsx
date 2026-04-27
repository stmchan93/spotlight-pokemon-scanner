import { MockSpotlightRepository } from '@spotlight/api-client';

import {
  buildBulkSellPayloads,
  buildBulkSellStatusCopy,
  buildInitialBulkSellLines,
  bulkSellEmptySelectionErrorMessage,
  bulkSellMissingPriceErrorMessage,
  getBulkSellLineMetrics,
  summarizeBulkSellSelection,
  validateBulkSellSubmission,
} from '@/features/sell/sell-batch-helpers';

describe('sell batch helpers', () => {
  it('validates only active lines and builds payloads from parsed prices', async () => {
    const repository = new MockSpotlightRepository();
    const inventory = await repository.getInventoryEntries();
    const entries = inventory.slice(0, 2);
    const lines = buildInitialBulkSellLines(entries);

    expect(validateBulkSellSubmission(entries, lines)).toBe(bulkSellMissingPriceErrorMessage);

    lines[entries[0]!.id] = {
      ...lines[entries[0]!.id]!,
      soldPriceText: '12.50',
      quantity: 1,
    };
    lines[entries[1]!.id] = {
      ...lines[entries[1]!.id]!,
      soldPriceText: 'not-a-number',
      quantity: 0,
    };

    expect(validateBulkSellSubmission(entries, lines)).toBeNull();

    const payloads = buildBulkSellPayloads(entries, lines);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.deckEntryID).toBe(entries[0]?.id);
    expect(payloads[0]?.cardID).toBe(entries[0]?.cardId);
    expect(payloads[0]?.unitPrice).toBe(12.5);
  });

  it('summarizes projected totals and status copy', async () => {
    const repository = new MockSpotlightRepository();
    const inventory = await repository.getInventoryEntries();
    const entries = inventory.slice(0, 2);
    const lines = buildInitialBulkSellLines(entries);

    lines[entries[0]!.id] = {
      ...lines[entries[0]!.id]!,
      offerPriceText: '0.45',
      yourPriceText: '0.51',
      soldPriceText: '7.5',
      quantity: 1,
    };
    lines[entries[1]!.id] = {
      ...lines[entries[1]!.id]!,
      quantity: 0,
    };

    const metrics = getBulkSellLineMetrics(entries[0]!, lines[entries[0]!.id]);
    expect(metrics.ypPercentText).toBe('88.23% YP');
    expect(metrics.draftTotal).toBe(7.5);

    const summary = summarizeBulkSellSelection(entries, lines);
    expect(summary.totalSelectedQuantity).toBe(1);
    expect(summary.draftGrossTotal).toBe(7.5);
    expect(summary.projectedGrossTotal).toBe(7.5);
    expect(summary.hasMissingActiveSoldPrice).toBe(false);

    expect(buildBulkSellStatusCopy('processing', summary)).toEqual({
      title: 'Processing sale',
      headline: 'Selling $7.50',
      detail: 'Locking in 1 card.',
    });
    expect(buildBulkSellStatusCopy('success', summary)).toEqual({
      title: 'Congrats!',
      headline: 'Batch sale confirmed',
      detail: '1 card sold for $7.50.',
    });
  });

  it('returns the empty-selection validation copy when every line is removed', async () => {
    const repository = new MockSpotlightRepository();
    const inventory = await repository.getInventoryEntries();
    const entries = inventory.slice(0, 2);
    const lines = buildInitialBulkSellLines(entries);

    lines[entries[0]!.id] = {
      ...lines[entries[0]!.id]!,
      quantity: 0,
    };
    lines[entries[1]!.id] = {
      ...lines[entries[1]!.id]!,
      quantity: 0,
    };

    expect(validateBulkSellSubmission(entries, lines)).toBe(bulkSellEmptySelectionErrorMessage);
  });
});
