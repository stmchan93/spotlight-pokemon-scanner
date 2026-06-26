// Price text-input formatting/parsing helpers. Moved out of the (removed) sell
// feature; now used by the portfolio sale-price edit field. Names are kept as-is
// to avoid churning the call sites.

export function sanitizeSellPriceText(value: string) {
  const trimmed = value.replace(/[^0-9.]/g, '');
  const [whole = '', ...fractionParts] = trimmed.split('.');
  const fraction = fractionParts.join('').slice(0, 2);

  if (trimmed.startsWith('.')) {
    return fraction.length > 0 ? `0.${fraction}` : '0.';
  }

  if (fractionParts.length === 0) {
    return whole;
  }

  return `${whole}.${fraction}`;
}

export function parseSellPrice(text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

export function formatEditableSellPrice(value: number) {
  const fixed = value.toFixed(2);
  return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}
