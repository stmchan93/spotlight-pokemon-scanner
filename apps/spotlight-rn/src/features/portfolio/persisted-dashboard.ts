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
): void {
  void AsyncStorage.setItem(
    PORTFOLIO_DASHBOARD_STORAGE_KEY,
    JSON.stringify({ dashboard, savedAt, ownerKey } satisfies PersistedDashboardEnvelope),
  ).catch(() => {
    // best-effort; in-memory stale-while-revalidate still works this session
  });
}
