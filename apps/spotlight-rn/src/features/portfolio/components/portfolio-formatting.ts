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
  return `${value.toFixed(2)}%`;
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
