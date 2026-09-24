import { getObservabilityAppContext } from '@/lib/observability/context';
import { capturePostHogEvent } from '@/lib/observability/posthog';

/**
 * TEMPORARY (2026-09-24): staging-only breadcrumbs for the push-tap flicker
 * (signed-in state flipping ~3x/s after a notification opens the app). Remove
 * once the cause is fixed. Props are booleans/enums only — no ids or tokens.
 */
const enabled = getObservabilityAppContext().appEnv === 'staging';
let sequence = 0;

export function debugTrace(step: string, props: Record<string, string | number | boolean | null> = {}): void {
  if (!enabled) {
    return;
  }
  sequence += 1;
  capturePostHogEvent('debug_trace', { step, seq: sequence, ms: Date.now() % 10_000_000, ...props });
}
