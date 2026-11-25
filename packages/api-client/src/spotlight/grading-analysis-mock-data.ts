import type { CardGradingAnalysis } from './types';

// A modern chase card: clears the fee at a 9 and a 10.
export const mockCardGradingAnalysis: CardGradingAnalysis = {
  cardId: 'sv2-232',
  grader: 'PSA',
  variant: 'Holofoil',
  currencyCode: 'USD',
  rawPriceUsd: 42,
  tier: { name: 'Value Bulk', feeUsd: 24.99, valueCapUsd: 500, turnaroundText: '~65 business days' },
  shippingUsd: 10,
  totalCostUsd: 34.99,
  outcomes: [
    { grade: '10', priceUsd: 310, netUsd: 275.01, gainVsRawUsd: 233.01, worthIt: true },
    { grade: '9', priceUsd: 95, netUsd: 60.01, gainVsRawUsd: 18.01, worthIt: true },
    { grade: '8', priceUsd: 58, netUsd: 23.01, gainVsRawUsd: -18.99, worthIt: false },
  ],
  breakEvenGrade: '9',
  verdict: 'worth_it',
  summary:
    'A PSA 9 or 10 clears the $35 cost comfortably; an 8 loses about $19 against selling raw. Worth it if the centering and surface look clean.',
  summarySource: 'ai',
  pricesAsOf: '2026-11-23',
  feesAsOf: '2026-11-01',
  feesSourceUrl: 'https://www.psacard.com/services/tradingcardgrading',
};

// A cheaper card where only a gem 10 pays for the submission.
export const mockCardGradingAnalysisOnlyAt10: CardGradingAnalysis = {
  cardId: 'sm7-1',
  grader: 'PSA',
  variant: 'Normal',
  currencyCode: 'USD',
  rawPriceUsd: 12,
  tier: { name: 'Value Bulk', feeUsd: 24.99, valueCapUsd: 500, turnaroundText: '~65 business days' },
  shippingUsd: 10,
  totalCostUsd: 34.99,
  outcomes: [
    { grade: '10', priceUsd: 85, netUsd: 50.01, gainVsRawUsd: 38.01, worthIt: true },
    { grade: '9', priceUsd: 32, netUsd: -2.99, gainVsRawUsd: -14.99, worthIt: false },
    { grade: '8', priceUsd: 20, netUsd: -14.99, gainVsRawUsd: -26.99, worthIt: false },
  ],
  breakEvenGrade: '10',
  verdict: 'only_at_10',
  summary:
    'Only a PSA 10 beats selling raw; a 9 sells for less than the card plus fees. Grade it only if it looks gem mint.',
  summarySource: 'ai',
  pricesAsOf: '2026-11-23',
  feesAsOf: '2026-11-01',
  feesSourceUrl: 'https://www.psacard.com/services/tradingcardgrading',
};
