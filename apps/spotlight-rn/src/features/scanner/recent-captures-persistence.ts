import * as FileSystem from 'expo-file-system/legacy';
import { AppState, type NativeEventSubscription } from 'react-native';

import { migrateLegacyTrayBlob } from './legacy-tray-migration';
import type { ScanPriceSheetSelection } from './screens/scan-price-sheet';
import type { RecentCapture } from './screens/scanner-screen-types';
import {
  applyTrayChanges,
  clearOwnerTrayRows,
  listOwnerTrayRowIds,
  loadOwnerTrayRows,
  type TrayRowWrite,
} from './tray-db';
import { decodeTrayRow, isPersistableItem, toPersistedCapture, trayRowWriteFor } from './tray-row-codec';

/*
  When and what the scan tray writes. Rows live in the tray DB (`tray-db.ts`),
  one per capture with every candidate; images live in `scans/` and the rows
  hold their URIs. Each write is a diff against what was last committed — only
  rows whose capture, price pick or position changed are upserted — so a burst
  of scans costs a handful of row writes, not the whole tray.
*/

export const RECENT_CAPTURES_DIR = `${FileSystem.documentDirectory ?? ''}scans/`;
/**
 * Trailing debounce: every schedule restarts the clock, so a binder page (a
 * pocket every ~2s) or a scan burst coalesces into one write. The max-wait
 * still lands a long, unbroken burst; background/unmount flushes cover the tail.
 */
export const PERSIST_DEBOUNCE_MS = 1500;
export const PERSIST_MAX_WAIT_MS = 5000;
// Upper bound on how long a debounced write waits for the JS thread to idle.
export const PERSIST_IDLE_TIMEOUT_MS = 2000;
/** Cap on concurrent filesystem calls; the tray has no row cap. */
export const FS_CONCURRENCY_LIMIT = 16;
// Below this gap two neighbours can't take another row between them; renumber.
const MIN_SORT_KEY_GAP = 1e-6;

export type DeleteReason = 'swipe' | 'clear_all' | 'orphan_sweep' | 'copy_failed' | 'added' | 'binder_page_delete';
export type CopySource = 'normalized' | 'raw';

/** The tray plus its price choices — what one persisted write captures. */
export type PersistedTraySnapshot = {
  items: RecentCapture[];
  priceSelections: ReadonlyMap<string, ScanPriceSheetSelection>;
};

// A snapshot remembers the account it was taken for; a write never lands under
// a different one.
type OwnedSnapshot = PersistedTraySnapshot & { ownerKey: string | null };

// What the DB holds for the current owner as of the last commit.
type CommittedRow = {
  capture: RecentCapture | null;
  selection: ScanPriceSheetSelection | null;
  sortKey: number;
};

let scansDirReady = false;
let scansDirPromise: Promise<void> | null = null;
let pendingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
// When the current unwritten burst started; anchors the max-wait.
let burstStartedAtMs: number | null = null;
let cancelPendingIdleWrite: (() => void) | null = null;
let appStateSubscription: NativeEventSubscription | null = null;
let pendingSnapshot: OwnedSnapshot | null = null;
let isWriting = false;
// Snapshot handed to `writePersistedTray` while another write was in flight.
// Depth-1: each snapshot is the FULL tray, so a newer one supersedes an older.
let queuedSnapshot: OwnedSnapshot | null = null;
let queuedWaiters: (() => void)[] = [];
// The owner the tray currently belongs to. Set by the scanner before it loads.
let currentOwnerKey: string | null = null;
// Last price-selection map handed to schedule/flush, so a rows-only call
// (Clear All passes []) never silently drops the user's printing choices.
let lastPriceSelections: ReadonlyMap<string, ScanPriceSheetSelection> = new Map();
let committed = new Map<string, CommittedRow>();
// Bumped by every load; a write planned against an older load must not
// overwrite `committed` with a stale view.
let loadGeneration = 0;
// The old blob is still on disk with rows we could not import (no DB yet, or
// the import failed): its images are not orphans.
let legacyBlobPending = false;

function snapshotOf(
  items: RecentCapture[],
  priceSelections?: ReadonlyMap<string, ScanPriceSheetSelection>,
): OwnedSnapshot {
  if (priceSelections) {
    lastPriceSelections = priceSelections;
  }
  return { items, priceSelections: lastPriceSelections, ownerKey: currentOwnerKey };
}

function normalizeOwnerKey(ownerKey: string | null | undefined): string | null {
  const trimmed = (ownerKey ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Tell the persistence layer which account the tray belongs to. Call this
 * synchronously before loading the tray on scanner mount so account switches are
 * detected and writes are scoped to the right owner. */
export function setRecentCapturesOwner(ownerKey: string | null | undefined): void {
  currentOwnerKey = normalizeOwnerKey(ownerKey);
}

/** `Promise.all` with a worker cap. Results stay in input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      if (index >= items.length) {
        return;
      }
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function ensureScansDir(): Promise<void> {
  if (scansDirReady) {
    return;
  }
  if (!scansDirPromise) {
    scansDirPromise = (async () => {
      try {
        const info = await FileSystem.getInfoAsync(RECENT_CAPTURES_DIR);
        if (!info.exists) {
          await FileSystem.makeDirectoryAsync(RECENT_CAPTURES_DIR, { intermediates: true });
        }
        scansDirReady = true;
      } catch {
        // Best-effort: persistence failures never block the tray.
      } finally {
        scansDirPromise = null;
      }
    })();
  }
  await scansDirPromise;
}

function scanFilePath(id: string, source: CopySource): string {
  const suffix = source === 'raw' ? '-src' : '';
  return `${RECENT_CAPTURES_DIR}${id}${suffix}.jpg`;
}

function isAlreadyInScansDir(uri: string): boolean {
  return uri.startsWith(RECENT_CAPTURES_DIR);
}

export async function copyToScansDir(
  srcUri: string,
  id: string,
  source: CopySource = 'normalized',
  mode: 'raw' | 'slabs' = 'raw',
): Promise<string | null> {
  if (!srcUri) {
    return null;
  }
  if (isAlreadyInScansDir(srcUri)) {
    return srcUri;
  }
  try {
    await ensureScansDir();
    const destination = scanFilePath(id, source);
    await FileSystem.copyAsync({ from: srcUri, to: destination });
    return destination;
  } catch {
    // Best-effort: persistence failures never block the tray.
    return null;
  }
}

export async function deleteScanFile(
  uri: string | null | undefined,
  reason: DeleteReason,
): Promise<void> {
  if (!uri || !isAlreadyInScansDir(uri)) {
    return;
  }
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort: persistence failures never block the tray.
  }
}

/**
 * Sort keys for `ids` (newest first, so keys descend). Rows already stored keep
 * their key; new rows slot into the gap between their stored neighbours, so an
 * insert at the top — the common case — writes only the new row. If stored keys
 * are out of order or a gap is exhausted, everything is renumbered.
 */
export function assignSortKeys(
  ids: readonly string[],
  storedKey: (id: string) => number | undefined,
): number[] {
  const count = ids.length;
  const renumbered = () => ids.map((_, index) => count - index);
  const keys = ids.map(storedKey);
  let previous = Infinity;
  for (const key of keys) {
    if (key === undefined) {
      continue;
    }
    if (!(key < previous)) {
      return renumbered();
    }
    previous = key;
  }
  let index = 0;
  while (index < count) {
    if (keys[index] !== undefined) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < count && keys[index] === undefined) {
      index += 1;
    }
    const runLength = index - start;
    const above = start > 0 ? keys[start - 1] : undefined;
    const below = index < count ? keys[index] : undefined;
    for (let offset = 0; offset < runLength; offset += 1) {
      if (above === undefined) {
        keys[start + offset] = (below ?? 0) + (runLength - offset);
      } else if (below === undefined) {
        keys[start + offset] = above - (offset + 1);
      } else {
        const step = (above - below) / (runLength + 1);
        if (step < MIN_SORT_KEY_GAP) {
          return renumbered();
        }
        keys[start + offset] = above - step * (offset + 1);
      }
    }
  }
  return keys as number[];
}

type WritePlan = {
  next: Map<string, CommittedRow>;
  upserts: TrayRowWrite[];
  deleteIds: string[];
};

function planTrayWrite(snapshot: OwnedSnapshot): WritePlan {
  const persistable = snapshot.items.filter(isPersistableItem);
  const sortKeys = assignSortKeys(
    persistable.map((capture) => capture.id),
    (id) => committed.get(id)?.sortKey,
  );
  const next = new Map<string, CommittedRow>();
  const upserts: TrayRowWrite[] = [];
  persistable.forEach((capture, index) => {
    const selection = snapshot.priceSelections.get(capture.id) ?? null;
    const sortKey = sortKeys[index];
    const row = { capture, selection, sortKey };
    next.set(capture.id, row);
    const previous = committed.get(capture.id);
    // Rows are immutable tray state: identity is a complete change check.
    if (
      !previous
      || previous.capture !== capture
      || previous.selection !== selection
      || previous.sortKey !== sortKey
    ) {
      upserts.push(trayRowWriteFor(toPersistedCapture(capture), selection, sortKey));
    }
  });
  const deleteIds = [...committed.keys()].filter((id) => !next.has(id));
  return { next, upserts, deleteIds };
}

/**
 * One DB write. Never rejects, so `writePersistedTray`'s drain loop cannot be
 * aborted mid-queue. `committed` only advances once the transaction committed,
 * so a failed write is retried by the next one.
 */
async function performTrayWrite(snapshot: OwnedSnapshot): Promise<void> {
  if (snapshot.ownerKey !== currentOwnerKey) {
    // Taken for an account that has since signed out; its rows are not ours.
    return;
  }
  const generation = loadGeneration;
  try {
    const plan = planTrayWrite(snapshot);
    if (plan.upserts.length === 0 && plan.deleteIds.length === 0) {
      return;
    }
    const written = plan.next.size === 0
      ? await clearOwnerTrayRows(snapshot.ownerKey)
      : await applyTrayChanges(snapshot.ownerKey, plan.upserts, plan.deleteIds);
    if (written && generation === loadGeneration) {
      committed = plan.next;
    }
  } catch {
    // Best-effort: persistence failures never block the tray.
  }
}

/**
 * Serialize tray writes without losing any: a snapshot that arrives while a
 * write is in flight is stashed (depth-1, newest wins) and drained by the
 * in-flight writer, and its caller's promise resolves once it has landed.
 */
async function writePersistedTray(snapshot: OwnedSnapshot): Promise<void> {
  if (isWriting) {
    queuedSnapshot = snapshot;
    return new Promise<void>((resolve) => {
      queuedWaiters.push(resolve);
    });
  }
  isWriting = true;
  try {
    await performTrayWrite(snapshot);
    while (queuedSnapshot) {
      const nextSnapshot = queuedSnapshot;
      const waiters = queuedWaiters;
      queuedSnapshot = null;
      queuedWaiters = [];
      try {
        await performTrayWrite(nextSnapshot);
      } finally {
        waiters.forEach((resolve) => resolve());
      }
    }
  } finally {
    // No `await` between the empty-queue check and this, so nothing can slip in.
    isWriting = false;
  }
}

type IdleCallbackApi = {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Run the write when the JS thread is idle so planning never lands mid-gesture
 * or mid-animation. (InteractionManager is a setImmediate stub on RN 0.83.)
 */
function runWhenIdle(task: () => void): () => void {
  const api = globalThis as IdleCallbackApi;
  if (typeof api.requestIdleCallback === 'function') {
    const handle = api.requestIdleCallback(task, { timeout: PERSIST_IDLE_TIMEOUT_MS });
    return () => api.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(task, 0);
  return () => clearTimeout(timer);
}

function clearPendingSchedule(): void {
  if (pendingDebounceTimer) {
    clearTimeout(pendingDebounceTimer);
    pendingDebounceTimer = null;
  }
  cancelPendingIdleWrite?.();
  cancelPendingIdleWrite = null;
  burstStartedAtMs = null;
}

// Backgrounding can end in a kill: write whatever is pending the moment we
// leave the foreground. Subscribed lazily so importing has no side effects.
function ensureBackgroundFlush(): void {
  if (appStateSubscription) {
    return;
  }
  appStateSubscription = AppState.addEventListener('change', (nextState) => {
    if (nextState !== 'active' && pendingSnapshot) {
      void flushPersist();
    }
  }) ?? null;
}

function runDebouncedWrite(): void {
  pendingDebounceTimer = null;
  cancelPendingIdleWrite = runWhenIdle(() => {
    cancelPendingIdleWrite = null;
    burstStartedAtMs = null;
    // Read at run time, not when the timer fired: the latest tray always wins.
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    if (snapshot) {
      void writePersistedTray(snapshot);
    }
  });
}

export function schedulePersist(
  items: RecentCapture[],
  priceSelections?: ReadonlyMap<string, ScanPriceSheetSelection>,
): void {
  pendingSnapshot = snapshotOf(items, priceSelections);
  ensureBackgroundFlush();
  if (cancelPendingIdleWrite) {
    // A write is already waiting for idle and will pick up this snapshot.
    return;
  }
  const now = Date.now();
  burstStartedAtMs ??= now;
  if (pendingDebounceTimer) {
    clearTimeout(pendingDebounceTimer);
  }
  const untilMaxWait = burstStartedAtMs + PERSIST_MAX_WAIT_MS - now;
  pendingDebounceTimer = setTimeout(
    runDebouncedWrite,
    Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, untilMaxWait)),
  );
}

/**
 * Write now, skipping the debounce and the idle wait. Call on unmount / Clear
 * All with the live tray; with no argument it writes only what is pending.
 */
export async function flushPersist(
  explicit?: RecentCapture[],
  priceSelections?: ReadonlyMap<string, ScanPriceSheetSelection>,
): Promise<void> {
  clearPendingSchedule();
  const snapshot = explicit !== undefined ? snapshotOf(explicit, priceSelections) : pendingSnapshot;
  pendingSnapshot = null;
  if (snapshot == null) {
    // Nothing pending and no explicit state: storage already reflects the tray.
    // Writing [] here would wipe an idle tray on every navigation unmount.
    return;
  }
  await writePersistedTray(snapshot);
}

const emptySnapshot = (): PersistedTraySnapshot => ({ items: [], priceSelections: new Map() });

/**
 * The current owner's tray, newest first. Migrates the old AsyncStorage blob on
 * first run, and drops every other account's rows (see `loadOwnerTrayRows`).
 * No file probes here — `findCapturesWithMissingImages` runs after paint.
 */
export async function loadPersistedTraySnapshot(): Promise<PersistedTraySnapshot> {
  // Another scanner instance may still hold unwritten changes; land them first.
  await flushPersist();
  loadGeneration += 1;
  committed = new Map();
  const ownerKey = currentOwnerKey;
  try {
    legacyBlobPending = (await migrateLegacyTrayBlob(ownerKey)) === 'pending';
  } catch {
    legacyBlobPending = true;
  }
  let rows: Awaited<ReturnType<typeof loadOwnerTrayRows>>;
  try {
    rows = await loadOwnerTrayRows(ownerKey);
  } catch {
    // Best-effort: persistence failures never block the tray.
    return emptySnapshot();
  }
  if (!rows) {
    return emptySnapshot();
  }
  const items: RecentCapture[] = [];
  const priceSelections = new Map<string, ScanPriceSheetSelection>();
  const loaded = new Map<string, CommittedRow>();
  rows.forEach((row) => {
    const decoded = decodeTrayRow(row);
    // An undecodable row stays in `committed` with no capture, so the next write deletes it.
    loaded.set(row.id, {
      capture: decoded?.capture ?? null,
      selection: decoded?.selection ?? null,
      sortKey: row.sortKey,
    });
    if (!decoded) {
      return;
    }
    items.push(decoded.capture);
    if (decoded.selection) {
      priceSelections.set(row.id, decoded.selection);
    }
  });
  committed = loaded;
  // What we just loaded IS the current choice set until the scanner hands us a newer map.
  lastPriceSelections = priceSelections;
  return { items, priceSelections };
}

/**
 * Ids of rows whose image is gone (a row pointing at a missing image is worse
 * than no row). Run after the tray painted; bounded so a big tray doesn't fire
 * hundreds of native probes at once.
 */
export async function findCapturesWithMissingImages(items: readonly RecentCapture[]): Promise<Set<string>> {
  const exists = await mapWithConcurrency(items, FS_CONCURRENCY_LIMIT, async (item) => {
    const probe = item.normalizedImageUri || item.uri;
    if (!probe) {
      return false;
    }
    try {
      return (await FileSystem.getInfoAsync(probe)).exists;
    } catch {
      // Unknown is not missing: never drop a row on a failed probe.
      return true;
    }
  });
  return new Set(items.filter((_, index) => !exists[index]).map((item) => item.id));
}

/**
 * Deletes files in `scans/` that no stored row owns. `liveIds` are rows the
 * tray holds but the DB may not yet (still loading, or not flushed). Skipped
 * entirely without a DB or while an un-imported legacy blob still owns files.
 */
export async function sweepOrphanScans(liveIds: ReadonlySet<string> = new Set()): Promise<void> {
  try {
    await flushPersist();
    if (legacyBlobPending) {
      return;
    }
    const storedIds = await listOwnerTrayRowIds(currentOwnerKey);
    if (!storedIds) {
      return;
    }
    await ensureScansDir();
    const entries = await FileSystem.readDirectoryAsync(RECENT_CAPTURES_DIR);
    await mapWithConcurrency(entries, FS_CONCURRENCY_LIMIT, async (name) => {
      // Strip `-src.jpg` or `.jpg` to recover the capture id.
      const id = name.replace(/-src\.jpg$/, '').replace(/\.jpg$/, '');
      if (storedIds.has(id) || liveIds.has(id)) {
        return;
      }
      await deleteScanFile(`${RECENT_CAPTURES_DIR}${name}`, 'orphan_sweep');
    });
  } catch {
    // Best-effort: persistence failures never block the tray.
  }
}

export function __resetRecentCapturesPersistenceForTests(): void {
  scansDirReady = false;
  scansDirPromise = null;
  clearPendingSchedule();
  appStateSubscription?.remove();
  appStateSubscription = null;
  pendingSnapshot = null;
  isWriting = false;
  queuedSnapshot = null;
  queuedWaiters.forEach((resolve) => resolve());
  queuedWaiters = [];
  currentOwnerKey = null;
  lastPriceSelections = new Map();
  committed = new Map();
  loadGeneration = 0;
  legacyBlobPending = false;
}
