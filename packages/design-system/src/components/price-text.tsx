import { AppText, type AppTextVariant } from './app-text';

type PriceTextProps = {
  amount: number | string;
  currency?: string;
  muted?: boolean;
  prefix?: string;
  testID?: string;
  variant?: AppTextVariant;
};

function formatAmount(amount: number | string, currency: string) {
  if (typeof amount === 'string') {
    return amount;
  }

  return new Intl.NumberFormat('en-US', {
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(amount);
}

export function PriceText({
  amount,
  currency = 'USD',
  muted = false,
  prefix,
  testID,
  variant = 'titleCompact',
}: PriceTextProps) {
  const formatted = formatAmount(amount, currency);

  return (
    <AppText color={muted ? 'textSecondary' : 'textPrimary'} testID={testID} variant={variant}>
      {prefix ? `${prefix} ${formatted}` : formatted}
    </AppText>
  );
}
