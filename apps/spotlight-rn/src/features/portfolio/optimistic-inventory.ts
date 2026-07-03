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
/**
 * Remove every entry whose id is in `ids` from `entries`. Returns the original
 * reference unchanged when nothing matches so callers can skip redundant state
 * updates. Mirrors {@link prependInventoryEntry} as the optimistic-delete
 * counterpart: a bulk delete drops the rows instantly, before the slow dashboard
 * refetch reconciles by id.
 */
export function removeInventoryEntries(
  entries: InventoryCardEntry[],
  ids: string[],
): InventoryCardEntry[] {
  if (ids.length === 0) {
    return entries;
  }

  const removalSet = new Set(ids);
  const next = entries.filter((entry) => !removalSet.has(entry.id));
  return next.length === entries.length ? entries : next;
}

/**
 * Remove `ids` from the dashboard's inventory list and decrement the summary
 * value / count by the removed entries' value so the totals don't read briefly
 * stale. Counterpart to {@link prependDashboardInventoryEntry}. Returns the
 * original dashboard reference unchanged when no id matches.
 */
export function removeDashboardInventoryEntries(
  dashboard: PortfolioDashboard,
  ids: string[],
): PortfolioDashboard {
  if (ids.length === 0) {
    return dashboard;
  }

  const removalSet = new Set(ids);
  const removedEntries = dashboard.inventoryItems.filter((entry) => removalSet.has(entry.id));
  if (removedEntries.length === 0) {
    return dashboard;
  }

  const inventoryItems = dashboard.inventoryItems.filter((entry) => !removalSet.has(entry.id));
  const removedValue = removedEntries.reduce((sum, entry) => sum + inventoryEntryValue(entry), 0);

  return {
    ...dashboard,
    inventoryCount: Math.max(0, dashboard.inventoryCount - removedEntries.length),
    inventoryItems,
    summary: {
      ...dashboard.summary,
      currentValue: Number(Math.max(0, dashboard.summary.currentValue - removedValue).toFixed(2)),
    },
  };
}

/**
 * True when two same-id entries are display-equivalent — i.e. an optimistic
 * EDIT does not need to swap the dashboard's copy for the cache's. Compares the
 * fields the Collection actually renders/sorts on, not deep equality (the two
 * objects come from different loads and are never reference-equal).
 */
function entriesEquivalent(a: InventoryCardEntry, b: InventoryCardEntry): boolean {
  return (
    a.cardId === b.cardId
    && a.name === b.name
    && a.imageUrl === b.imageUrl
    && a.quantity === b.quantity
    && a.marketPrice === b.marketPrice
    && a.hasMarketPrice === b.hasMarketPrice
    && a.kind === b.kind
    && a.variantName === b.variantName
    && a.conditionCode === b.conditionCode
    && a.isFavorite === b.isFavorite
    && (a.slabContext?.grader ?? null) === (b.slabContext?.grader ?? null)
    && (a.slabContext?.grade ?? null) === (b.slabContext?.grade ?? null)
  );
}

/**
 * Reconcile the shared inventory cache into a dashboard's inventory list. The
 * cache is authoritative for MEMBERSHIP and per-entry display data (every
 * successful load sets it wholesale, and the optimistic add/edit/remove helpers
 * adjust it in between), so this handles all three optimistic shapes:
 *  - cache-only ids are PREPENDED (optimistic add / identity-changing edit),
 *  - dashboard-only ids are DROPPED (optimistic delete / the old row of an
 *    identity-changing edit),
 *  - same-id entries whose display fields changed are REPLACED in place
 *    (optimistic same-identity edit — e.g. quantity or variant tweaks).
 * The summary value/count adjust incrementally so backend-computed totals don't
 * drift. Returns the original dashboard reference unchanged when nothing
 * differs, so callers can use referential equality to skip redundant updates.
 */
export function reflectInventoryCacheIntoDashboard(
  dashboard: PortfolioDashboard,
  cacheEntries: InventoryCardEntry[],
): PortfolioDashboard {
  const cacheById = new Map(cacheEntries.map((entry) => [entry.id, entry]));
  const dashboardIds = new Set(dashboard.inventoryItems.map((entry) => entry.id));
  const newEntries = cacheEntries.filter((entry) => !dashboardIds.has(entry.id));

  let valueDelta = newEntries.reduce((sum, entry) => sum + inventoryEntryValue(entry), 0);
  let changed = newEntries.length > 0;

  const retained: InventoryCardEntry[] = [];
  for (const entry of dashboard.inventoryItems) {
    const cacheEntry = cacheById.get(entry.id);
    if (!cacheEntry) {
      // Dropped from the cache (optimistic delete / replaced identity).
      changed = true;
      valueDelta -= inventoryEntryValue(entry);
      continue;
    }
    if (entriesEquivalent(entry, cacheEntry)) {
      retained.push(entry);
      continue;
    }
    // Same id, different display data — the cache carries the optimistic edit.
    changed = true;
    valueDelta += inventoryEntryValue(cacheEntry) - inventoryEntryValue(entry);
    retained.push(cacheEntry);
  }

  if (!changed) {
    return dashboard;
  }

  const inventoryItems = [...newEntries, ...retained];

  return {
    ...dashboard,
    inventoryCount: inventoryItems.length,
    inventoryItems,
    summary: {
      ...dashboard.summary,
      currentValue: Number(Math.max(0, dashboard.summary.currentValue + valueDelta).toFixed(2)),
    },
  };
}
