import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import type { PaymentMethod } from '@spotlight/api-client';

import { PaymentScreen } from '@/features/sell/screens/payment-screen';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

const NON_CASH_METHODS = new Set<PaymentMethod>(['venmo', 'cashapp', 'paypal', 'zelle']);

export default function PaymentRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    saleId?: string | string[];
    method?: string | string[];
    amount?: string | string[];
    currencyCode?: string | string[];
    memo?: string | string[];
  }>();

  const saleId = firstParam(params.saleId);
  const methodParam = firstParam(params.method);
  const amountParam = Number.parseFloat(firstParam(params.amount));
  const currencyCode = firstParam(params.currencyCode) || 'USD';
  const memo = firstParam(params.memo) || '';

  if (!saleId || !NON_CASH_METHODS.has(methodParam as PaymentMethod) || !Number.isFinite(amountParam)) {
    return null;
  }

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <PaymentScreen
        amount={amountParam}
        currencyCode={currencyCode}
        memo={memo}
        method={methodParam as PaymentMethod}
        onCancel={() => router.replace('/portfolio')}
        onConfirmed={() => router.replace('/portfolio')}
        saleId={saleId}
      />
    </>
  );
}
