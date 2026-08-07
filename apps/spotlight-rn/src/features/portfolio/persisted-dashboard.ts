import AsyncStorage from '@react-native-async-storage/async-storage';

import type { PortfolioDashboard } from '@spotlight/api-client';

// Persist the last good dashboard so a cold launch (or a backend blip) shows the
// last chart instantly instead of a blank/error, then revalidates in the
// background. The server stays the source of truth — this only bridges the
// loading gap, never serves knowingly-wrong data.
const PORTFOLIO_DASHBOARD_STORAGE_KEY = '@spotlight/portfolio/dashboard-cache';

type PersistedDashboardEnvelope = {
  dashboard?: PortfolioDashboard;
  savedAt?: string;
  /** Supabase user id (or 'signed-out') of the account this snapshot belongs to. */
  ownerKey?: string;
  /**
   * Which collection this snapshot was computed for ('all' for the aggregate).
   * A dashboard is only valid for the collection it was read with — serving one
   * collection's balance and chart under another's name is the same class of
   * mistake as serving one account's under another's.
   */
  collectionID?: string;
};

/**
 * Read the persisted dashboard snapshot ONLY if it belongs to `ownerKey`.
 *
 * SECURITY BOUNDARY: the snapshot is stamped with the owner (account) it was saved
 * for, and may only hydrate that same account's session. A snapshot from a
 * different account — or a legacy one saved before owner-stamping (no ownerKey) —
 * is discarded and deleted, so switching accounts can never briefly paint account
 * A's holdings/values into account B's Collection.
 */
export async function readPersistedDashboard(
  ownerKey: string,
  collectionID: string,
): Promise<{ dashboard: PortfolioDashboard; savedAt: string } | null> {
  try {
    const raw = await AsyncStorage.getItem(PORTFOLIO_DASHBOARD_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedDashboardEnvelope;
    if (parsed?.ownerKey !== ownerKey) {
      // Belongs to another account (or predates owner-stamping): never serve it.
      void AsyncStorage.removeItem(PORTFOLIO_DASHBOARD_STORAGE_KEY).catch(() => {});
      return null;
    }
    if ((parsed.collectionID ?? '') !== collectionID) {
      // Right account, wrong collection (or saved before collections existed).
      // Keep the snapshot — it is still valid for ITS collection — but don't
      // hydrate this one with it.
      return null;
    }
    if (parsed.dashboard) {
      return { dashboard: parsed.dashboard, savedAt: parsed.savedAt ?? '' };
    }
  } catch {
    // ignore corrupt / oversized cache — we just fall back to a live load
  }
  return null;
}

export function persistDashboard(
  dashboard: PortfolioDashboard,
  savedAt: string,
  ownerKey: string,
  collectionID: string,
): void {
  void AsyncStorage.setItem(
    PORTFOLIO_DASHBOARD_STORAGE_KEY,
    JSON.stringify({
      dashboard,
      savedAt,
      ownerKey,
      collectionID,
    } satisfies PersistedDashboardEnvelope),
  ).catch(() => {
    // best-effort; in-memory stale-while-revalidate still works this session
  });
}
