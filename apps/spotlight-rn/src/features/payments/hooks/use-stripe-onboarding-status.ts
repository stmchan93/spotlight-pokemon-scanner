import { useCallback, useEffect, useState } from 'react';

import {
  PaymentsNotEnabledError,
  type StripeConnectStatus,
} from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

export type StripeOnboardingStatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: StripeConnectStatus }
  | { kind: 'not_enabled'; message: string }
  | { kind: 'error'; message: string };

export type UseStripeOnboardingStatusResult = {
  state: StripeOnboardingStatusState;
  refresh: () => Promise<void>;
};

/**
 * Polls /payments/stripe/connect/status once on mount and exposes a
 * refresh function callers can invoke when returning from the
 * Stripe-hosted onboarding flow.
 */
export function useStripeOnboardingStatus(): UseStripeOnboardingStatusResult {
  const { spotlightRepository } = useAppServices();
  const [state, setState] = useState<StripeOnboardingStatusState>({ kind: 'loading' });

  const fetchStatus = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const status = await spotlightRepository.getStripeConnectStatus();
      setState({ kind: 'ready', status });
    } catch (error) {
      if (error instanceof PaymentsNotEnabledError) {
        setState({ kind: 'not_enabled', message: error.message });
        return;
      }
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not load payments status.',
      });
    }
  }, [spotlightRepository]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await spotlightRepository.getStripeConnectStatus();
        if (!cancelled) {
          setState({ kind: 'ready', status });
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
          message: error instanceof Error ? error.message : 'Could not load payments status.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [spotlightRepository]);

  return {
    state,
    refresh: fetchStatus,
  };
}
