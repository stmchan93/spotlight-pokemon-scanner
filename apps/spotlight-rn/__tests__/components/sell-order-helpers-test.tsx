import { MockSpotlightRepository } from '@spotlight/api-client';

import {
  buildSellMetadataTokens,
  buildOfferToYourPricePercentText,
  buildSingleSellStatusCopy,
  canStartSellSheetDismissGesture,
  collectionSummaryLine,
  evaluateSellCalculatorExpression,
  formatEditableSellPrice,
  formatSellOrderBoughtPriceLabel,
  getSellSwipeArmThresholdRatio,
  getSellSwipeConfirmThreshold,
  isSellSwipeReleaseArmed,
  parseSellPrice,
  scheduleSellStatusCompletion,
  sanitizeSellPriceText,
  sellOrderSuccessDisplayDurationMs,
} from '@/features/sell/sell-order-helpers';

describe('sell order helpers', () => {
  it('sanitizes and parses numeric sell-price inputs', () => {
    expect(sanitizeSellPriceText('$12.345')).toBe('12.34');
    expect(sanitizeSellPriceText('.5')).toBe('0.5');
    expect(parseSellPrice('12.50')).toBe(12.5);
    expect(parseSellPrice('abc')).toBeNull();
  });

  it('formats editable defaults and bought-price masking', () => {
    expect(formatEditableSellPrice(10)).toBe('10');
    expect(formatEditableSellPrice(10.5)).toBe('10.5');
    expect(buildOfferToYourPricePercentText(0.45, 0.51)).toBe('88.23% YP');
    expect(getSellSwipeConfirmThreshold(844)).toBe(422);
    expect(getSellSwipeConfirmThreshold(160)).toBe(92);
    expect(formatSellOrderBoughtPriceLabel(8.25, '$8.25', false)).toBe('*****');
    expect(formatSellOrderBoughtPriceLabel(8.25, '$8.25', true)).toBe('$8.25');
    expect(formatSellOrderBoughtPriceLabel(null, '$0.00', false)).toBe('--');
  });

  it('arms sell release only after the 50%-of-screen threshold is crossed', () => {
    const containerHeight = 844;
    const closedSheetOffset = containerHeight - 48;
    const armThresholdRatio = getSellSwipeArmThresholdRatio(containerHeight, closedSheetOffset);

    expect(armThresholdRatio).toBeCloseTo(422 / 796, 4);
    expect(isSellSwipeReleaseArmed(460, closedSheetOffset, armThresholdRatio)).toBe(false);
    expect(isSellSwipeReleaseArmed(360, closedSheetOffset, armThresholdRatio)).toBe(true);
  });

  it('evaluates calculator expressions safely', () => {
    expect(evaluateSellCalculatorExpression('2+3*4')).toBe(14);
    expect(evaluateSellCalculatorExpression('(2+3)*4')).toBe(20);
    expect(evaluateSellCalculatorExpression('10/4')).toBe(2.5);
    expect(evaluateSellCalculatorExpression('-2+5')).toBe(3);
    expect(evaluateSellCalculatorExpression('4/0')).toBeNull();
    expect(evaluateSellCalculatorExpression('2+bad')).toBeNull();
    expect(evaluateSellCalculatorExpression('')).toBeNull();
  });

  it('uses shared vertical gesture thresholds for sheet dismiss', () => {
    expect(canStartSellSheetDismissGesture(0, 12)).toBe(true);
    expect(canStartSellSheetDismissGesture(10, 12)).toBe(true);
    expect(canStartSellSheetDismissGesture(12, 10)).toBe(false);
    expect(canStartSellSheetDismissGesture(0, 6)).toBe(false);
  });

  it('builds deterministic single-sell status copy', () => {
    expect(buildSingleSellStatusCopy({
      currencyCode: 'USD',
      entryName: 'Celebi',
      quantity: 2,
      soldTotal: 75.08,
      submitState: 'processing',
    })).toEqual({
      title: 'Processing sale',
      headline: 'Selling $75.08',
      detail: 'Locking in 2 cards.',
    });

    expect(buildSingleSellStatusCopy({
      currencyCode: 'USD',
      entryName: 'Celebi',
      quantity: 1,
      soldTotal: 37.54,
      submitState: 'success',
    })).toEqual({
      title: 'Congrats!',
      headline: 'Sale confirmed',
      detail: 'Celebi sold for $37.54.',
    });
  });

  it('holds success confirmation before final completion', () => {
    jest.useFakeTimers();
    const events: string[] = [];

    scheduleSellStatusCompletion({
      onComplete: () => {
        events.push('complete');
      },
      onSuccess: () => {
        events.push('success');
      },
      processingDurationMs: 320,
    });

    expect(events).toEqual([]);

    jest.advanceTimersByTime(319);
    expect(events).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(events).toEqual(['success']);

    jest.advanceTimersByTime(sellOrderSuccessDisplayDurationMs - 1);
    expect(events).toEqual(['success']);

    jest.advanceTimersByTime(1);
    expect(events).toEqual(['success', 'complete']);
    jest.useRealTimers();
  });

  it('builds the collection summary line for raw and graded entries', async () => {
    const repository = new MockSpotlightRepository();
    const inventory = await repository.getInventoryEntries();

    expect(collectionSummaryLine(inventory[0]!)).toBe('Near Mint');
    expect(collectionSummaryLine({
      ...inventory[0]!,
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: 'HP',
    })).toBe('Heavily Played');
    expect(collectionSummaryLine({
      ...inventory[0]!,
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: 'D',
    })).toBe('Damaged');
    expect(collectionSummaryLine({
      ...inventory[0]!,
      kind: 'graded',
      slabContext: {
        grader: 'PSA',
        grade: '10',
        variantName: 'Holo',
      },
    })).toBe('PSA 10 • Holo');
  });

  it('builds labeled metadata chips for raw and graded entries', async () => {
    const repository = new MockSpotlightRepository();
    const inventory = await repository.getInventoryEntries();

    expect(buildSellMetadataTokens(inventory[0]!)).toEqual([
      { label: 'Condition', value: 'Near Mint' },
    ]);

    expect(buildSellMetadataTokens({
      ...inventory[0]!,
      kind: 'graded',
      slabContext: {
        grader: 'PSA',
        grade: '10',
        variantName: 'Holo',
      },
    })).toEqual([
      { label: 'Grader', value: 'PSA' },
      { label: 'Grade', value: '10' },
      { label: 'Variant', value: 'Holo' },
    ]);
  });
});
