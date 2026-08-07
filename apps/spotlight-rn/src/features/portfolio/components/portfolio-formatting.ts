/** Stand-in shown wherever a money value is suppressed by the hide-balance toggle. */
export const HIDDEN_VALUE_MASK = '*****';

export function formatCurrency(value: number, currencyCode = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatOptionalCurrency(value: number | null | undefined, currencyCode = 'USD') {
  if (value == null) {
    return '—';
  }

  return formatCurrency(value, currencyCode);
}

export function formatSignedCurrency(value: number, currencyCode = 'USD') {
  const absolute = formatCurrency(Math.abs(value), currencyCode);
  return `${value >= 0 ? '+' : '-'}${absolute}`;
}

export function formatPercent(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

export function formatCompactCurrency(value: number, currencyCode = 'USD') {
  if (value <= 0) {
    return formatCurrency(0, currencyCode);
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: value >= 100 ? 0 : 2,
    minimumFractionDigits: 0,
  }).format(value);
}

const ABBREVIATION_STEPS = [
  { divisor: 1e12, suffix: 'T' },
  { divisor: 1e9, suffix: 'B' },
  { divisor: 1e6, suffix: 'M' },
  { divisor: 1e3, suffix: 'k' },
] as const;

/** The currency's symbol on its own, taken from the same Intl formatting the
 * rest of this module uses so it stays right for a non-USD code. */
function currencySymbol(currencyCode: string) {
  return formatCurrency(0, currencyCode).replace(/[\d.,\s ]/g, '');
}

/**
 * Abbreviated total for tight single-line rows — "$10.3k", "$1.2M" (Figma
 * 2749:4753). Under $1k it falls back to the exact compact amount, since
 * "$0.9k" reads worse than "$942".
 */
export function formatAbbreviatedCurrency(value: number, currencyCode = 'USD') {
  const absolute = Math.abs(value);

  for (const { divisor, suffix } of ABBREVIATION_STEPS) {
    if (absolute < divisor) {
      continue;
    }
    const scaled = absolute / divisor;
    // Drop a trailing ".0" so a round total reads "$10k", not "$10.0k". Values
    // that round up into the next unit (999.95k) are left to the next step.
    const mantissa = scaled.toFixed(1).replace(/\.0$/, '');
    if (Number(mantissa) >= 1000) {
      continue;
    }
    return `${value < 0 ? '-' : ''}${currencySymbol(currencyCode)}${mantissa}${suffix}`;
  }

  return formatCompactCurrency(value, currencyCode);
}
