import type { InventoryCardEntry, PortfolioDashboard } from '@spotlight/api-client';

// Shared optimistic-add helpers. When a user adds a card we want it to appear at
// the TOP of the Collection instantly, before the slow dashboard refetch lands.
// These helpers keep the shared inventory cache and the portfolio dashboard in
// sync, deduping by entry id so the eventual server refetch (which carries the
// same id) replaces the optimistic row instead of duplicating it.

function inventoryEntryValue(entry: InventoryCardEntry): number {
  if (!entry.hasMarketPrice) {
    return 0;
  }

  return Math.max(0, entry.marketPrice) * Math.max(0, entry.quantity);
}

/**
 * Prepend `entry` to `entries`, deduping by id. If an entry with the same id is
 * already present the incoming entry replaces it in place (so a re-add keeps the
 * row stable rather than spawning a duplicate). Otherwise the entry lands first
 * so a recently-added sort surfaces it at the top.
 */
export function prependInventoryEntry(
  entries: InventoryCardEntry[],
  entry: InventoryCardEntry,
): InventoryCardEntry[] {
  const existingIndex = entries.findIndex((candidate) => candidate.id === entry.id);
  if (existingIndex >= 0) {
    return entries.map((candidate, index) => (index === existingIndex ? entry : candidate));
  }

  return [entry, ...entries];
}

/**
 * Prepend an optimistic entry into the dashboard's inventory list (deduping by
 * id) and bump the summary value / count so the totals don't read briefly stale.
 * When the entry id already exists the totals are left untouched — replacing an
 * existing row must not double-count its value.
 */
export function prependDashboardInventoryEntry(
  dashboard: PortfolioDashboard,
  entry: InventoryCardEntry,
): PortfolioDashboard {
  const alreadyPresent = dashboard.inventoryItems.some((candidate) => candidate.id === entry.id);
  const inventoryItems = prependInventoryEntry(dashboard.inventoryItems, entry);

  if (alreadyPresent) {
    return {
      ...dashboard,
      inventoryItems,
    };
  }

  const addedValue = inventoryEntryValue(entry);

  return {
    ...dashboard,
    inventoryCount: dashboard.inventoryCount + 1,
    inventoryItems,
    summary: {
      ...dashboard.summary,
      currentValue: Number((dashboard.summary.currentValue + addedValue).toFixed(2)),
    },
  };
}

/**
 * Merge the shared inventory cache into a dashboard's inventory list when the
 * cache carries entries the dashboard doesn't yet have (e.g. an optimistic
 * prepend that happened outside this model). Existing dashboard entries keep
 * their (typically richer) data; cache-only entries are prepended in cache order
 * so recently-added rows stay first.
 *
 * Returns the original dashboard reference unchanged when the cache introduces
 * no new ids, so callers can use referential equality to skip redundant state
 * updates and avoid fighting the model's own loads.
 */
export function reflectInventoryCacheIntoDashboard(
  dashboard: PortfolioDashboard,
  cacheEntries: InventoryCardEntry[],
): PortfolioDashboard {
  const dashboardIds = new Set(dashboard.inventoryItems.map((entry) => entry.id));
  const newEntries = cacheEntries.filter((entry) => !dashboardIds.has(entry.id));

  if (newEntries.length === 0) {
    return dashboard;
  }

  const inventoryItems = [...newEntries, ...dashboard.inventoryItems];
  const addedValue = newEntries.reduce((sum, entry) => sum + inventoryEntryValue(entry), 0);

  return {
    ...dashboard,
    inventoryCount: dashboard.inventoryCount + newEntries.length,
    inventoryItems,
    summary: {
      ...dashboard.summary,
      currentValue: Number((dashboard.summary.currentValue + addedValue).toFixed(2)),
    },
  };
}
