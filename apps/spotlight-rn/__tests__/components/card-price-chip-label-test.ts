import { chipRowLabel } from '@/features/cards/components/card-price-chart-section';

describe('chipRowLabel', () => {
  it('drops the grader the grader chip already shows', () => {
    expect(chipRowLabel('PSA 10', 'PSA')).toBe('10');
    expect(chipRowLabel('CGC 9.5', 'CGC')).toBe('9.5');
  });

  it('leaves raw conditions and mismatched labels alone', () => {
    expect(chipRowLabel('Near Mint', 'Raw')).toBe('Near Mint');
    expect(chipRowLabel('Near Mint', null)).toBe('Near Mint');
    expect(chipRowLabel('BGS 9', 'PSA')).toBe('BGS 9');
  });
});
