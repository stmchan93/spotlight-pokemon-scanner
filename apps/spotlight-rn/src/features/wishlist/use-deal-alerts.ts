import { useCallback, useEffect, useRef, useState } from 'react';

import type { DealAlert } from '@spotlight/api-client';

import { useAccessGate } from '@/features/auth/access-gate-provider';
import { useAppServices } from '@/providers/app-providers';

/**
 * How many deals the band asks for. Small on purpose: the band sits above the
 * watchlist, and a tall one pushes the list the user came for off screen.
 */
export const DEAL_ALERT_LIMIT = 5;

type DealAlertsState = {
  alerts: DealAlert[];
  dismiss: (id: string) => void;
  markSeen: (id: string) => void;
  markTapped: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** The owner's ALL-TIME unseen count, straight from the page. */
  unseenCount: number;
};

/**
 * Loads the deal radar for the watchlist band.
 *
 * FAILS OPEN on the flag — `watchDealRadarEnabled` missing means on, so a stale
 * or errored access status can never silently take the feature away. The
 * repository's deal methods never throw (a failure is an empty page), so
 * everything else resolves to zero alerts, which renders as nothing at all.
 */
export function useDealAlerts(): DealAlertsState {
  const { spotlightRepository, dataVersion } = useAppServices();
  const { status } = useAccessGate();
  // Only an explicit `false` turns the radar off.
  const flagEnabled = status?.watchDealRadarEnabled !== false;

  const [alerts, setAlerts] = useState<DealAlert[]>([]);
  /*
    The count AS FETCHED, which the seen-marks below deliberately do not
    decrement. Seen fires the moment the band renders, so a live count would
    make the "new" dot flash and vanish before anyone read it. It clears on the
    next load instead, by which time the backend agrees.
  */
  const [unseenCount, setUnseenCount] = useState(0);
  // One seen-mark per alert per session, even across re-renders and refreshes.
  const seenRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!flagEnabled) {
      setAlerts([]);
      setUnseenCount(0);
      return;
    }
    const page = await spotlightRepository.listDealAlerts(DEAL_ALERT_LIMIT);
    setAlerts(page.alerts);
    setUnseenCount(page.unseenCount);
  }, [flagEnabled, spotlightRepository]);

  useEffect(() => {
    void refresh();
  }, [dataVersion, refresh]);

  const markSeen = useCallback((id: string) => {
    if (seenRef.current.has(id)) {
      return;
    }
    seenRef.current.add(id);
    void spotlightRepository.markDealAlertSeen(id).then((stamped) => {
      if (!stamped) {
        // Unknown id or a failed request — let a later render try again rather
        // than burning the mark.
        seenRef.current.delete(id);
      }
    });
  }, [spotlightRepository]);

  /*
    AWAITED, and the caller waits on it before opening the listing.

    `tappedAt` is the column the whole deal-radar product decision is computed
    from (engagement, reliance, concentration), so the write has to survive the
    app being backgrounded by the listing URL a beat later. A fire-and-forget
    here loses exactly the taps that matter most. The server dedupes, so every
    tap can call it.
  */
  const markTapped = useCallback(async (id: string) => {
    const stamped = await spotlightRepository.markDealAlertTapped(id);
    if (!stamped) {
      return;
    }
    setAlerts((current) => current.map((alert) => (alert.id === id ? stamped : alert)));
  }, [spotlightRepository]);

  // Swipe to dismiss: gone at once; a refused write reloads the band.
  const dismiss = useCallback((id: string) => {
    setAlerts((current) => current.filter((alert) => alert.id !== id));
    void spotlightRepository.dismissDealAlert(id).then((ok) => {
      if (!ok) {
        void refresh();
      }
    });
  }, [refresh, spotlightRepository]);

  return {
    alerts: flagEnabled ? alerts : [],
    dismiss,
    markSeen,
    markTapped,
    refresh,
    unseenCount,
  };
}
