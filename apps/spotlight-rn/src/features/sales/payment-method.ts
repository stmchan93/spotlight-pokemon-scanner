import type { PaymentMethod } from '@spotlight/api-client';

// Selectable payment methods, in the order shown on the log-transaction form.
// Mirrors the api-client `PaymentMethod` union (the backend's allowed set).
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'venmo',
  'cashapp',
  'paypal',
  'zelle',
  'other',
];

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  venmo: 'Venmo',
  cashapp: 'Cash App',
  paypal: 'PayPal',
  zelle: 'Zelle',
  other: 'Other',
};

/** Human-facing label for a payment method (e.g. `'cashapp'` → "Cash App"). */
export function paymentMethodLabel(method: PaymentMethod): string {
  return PAYMENT_METHOD_LABELS[method] ?? method;
}
