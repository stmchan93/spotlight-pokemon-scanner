import { useEffect, useRef, useState } from 'react';

import {
  PaymentsNotEnabledError,
  type PaymentOrder,
} from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

export type OrderStatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; order: PaymentOrder }
  | { kind: 'not_enabled'; message: string }
  | { kind: 'error'; message: string };

export type UseOrderStatusOptions = {
  /** Pollling interval in ms. Default 2000. Set to 0 to disable polling. */
  intervalMs?: number;
  /** When set, polling stops once the order reaches a terminal state. */
  terminalStatuses?: PaymentOrder['status'][];
};

const DEFAULT_TERMINAL_STATUSES: PaymentOrder['status'][] = [
  'paid',
  'cancelled',
  'refunded',
  'failed',
  'disputed',
];

/**
 * Polls GET /payments/orders/:orderId every `intervalMs` while the order
 * is in a non-terminal state. Stops automatically once the order reaches
 * paid/cancelled/refunded/failed/disputed (configurable).
 */
export function useOrderStatus(
  orderId: string | null,
  options: UseOrderStatusOptions = {},
): OrderStatusState {
  const { spotlightRepository } = useAppServices();
  const [state, setState] = useState<OrderStatusState>({ kind: 'loading' });

  const intervalMs = options.intervalMs ?? 2000;
  const terminalStatuses = options.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES;
  const terminalStatusesRef = useRef(terminalStatuses);
  terminalStatusesRef.current = terminalStatuses;

  useEffect(() => {
    if (!orderId) {
      setState({ kind: 'loading' });
      return;
    }

    let cancelled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const pollOnce = async () => {
      try {
        const order = await spotlightRepository.getPaymentOrder(orderId);
        if (cancelled) {
          return;
        }
        setState({ kind: 'ready', order });
        if (terminalStatusesRef.current.includes(order.status)) {
          return;
        }
        if (intervalMs > 0) {
          timeoutHandle = setTimeout(pollOnce, intervalMs);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (error instanceof PaymentsNotEnabledError) {
          setState({ kind: 'not_enabled', message: error.message });
          return;
        }
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not load order status.',
        });
      }
    };

    void pollOnce();

    return () => {
      cancelled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };
  }, [intervalMs, orderId, spotlightRepository]);

  return state;
}
