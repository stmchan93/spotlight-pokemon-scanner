import { printingAbbreviation } from '@/features/scanner/scan-batch-pricing';

/*
  The binder tile names a printing on the SAME line as the price, which leaves
  it about half a ~100pt tile. These have to READ — an ellipsized "Reverse
  Holof…" tells the user nothing (user, 2026-09-10).
*/
describe('printingAbbreviation', () => {
  it('shortens the printings the batch dropdown offers', () => {
    expect(printingAbbreviation('Normal')).toBe('Normal');
    expect(printingAbbreviation('Holofoil')).toBe('Holo');
    expect(printingAbbreviation('Reverse Holofoil')).toBe('Rev Holo');
    expect(printingAbbreviation('Unlimited')).toBe('Unltd');
    expect(printingAbbreviation('1st Edition')).toBe('1st Ed');
    expect(printingAbbreviation('First Edition')).toBe('1st Ed');
  });

  it('drops trailing words rather than truncating mid-word', () => {
    // "Crk Ice Holo" is 12 characters; the words that survive stay whole.
    expect(printingAbbreviation('Cracked Ice Holofoil')).toBe('Crk Ice');
  });

  it('marks a single over-long word as an abbreviation', () => {
    expect(printingAbbreviation('Prerelease')).toBe('Prerelea.');
  });

  it('is stable on whitespace and empty input', () => {
    expect(printingAbbreviation('  Reverse   Holofoil ')).toBe('Rev Holo');
    expect(printingAbbreviation('   ')).toBe('');
  });

  it('leaves a printing it has no shorthand for alone when it already fits', () => {
    expect(printingAbbreviation('Poke Ball')).toBe('Poke Ball');
  });
});
