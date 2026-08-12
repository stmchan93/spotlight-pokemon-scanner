import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { capturePostHogEvent } from '@/lib/observability/posthog';

import type { RecentCapture } from './screens/scanner-screen-types';

export const RECENT_CAPTURES_STORAGE_KEY = '@spotlight/scanner/recent-captures';
export const RECENT_CAPTURES_DIR = `${FileSystem.documentDirectory ?? ''}scans/`;
/**
 * Tray cap. Raised 50 -> 150 after production telemetry showed
 * `scan_tray_evicted_for_cap` silently destroying user data (some dealers lost
 * 35-40% of every scan they took — dropped from the tray AND deleted from disk).
 *
 * Why 150 and not higher: the limit is MOUNTED ROWS, not storage. Storage is
 * comfortable — ~4.4 KB/capture in the AsyncStorage blob (~660 KB at 150,
 * ~960 KB worst case) and ~95 ms per write. But the tray is not virtualized:
 * `scanner-screen.tsx` maps the whole array inside a plain ScrollView, and that
 * is deliberate — every row stays mounted because mass mount/unmount was
 * crashing the tray. So every persisted item is a live mounted row. Going past
 * ~150 needs virtualization work (or a windowed tray), which is out of scope
 * here; do not raise this number without doing that first.
 */
export const RECENT_CAPTURES_MAX = 150;
export const PERSIST_DEBOUNCE_MS = 500;
export const PERSIST_ENVELOPE_VERSION = 1;
/**
 * How many candidates we persist per capture. The matcher returns 10; the
 * change-card picker's `loadMoreCandidates` grows the live array 10 -> 20 -> 30
 * as the user pages and never trims it, so a paged capture would otherwise
 * carry 3x the bytes in storage forever. `totalCandidateCount` is persisted
 * untouched, so the picker still knows how many exist and can refetch the rest
 * from the backend on demand.
 */
export const PERSISTED_CANDIDATES_MAX = 10;
/**
 * Cap on concurrent filesystem calls. At 150-500 items an unbounded
 * `Promise.all` fires hundreds of simultaneous native FS calls.
 */
export const FS_CONCURRENCY_LIMIT = 16;

export type DeleteReason = 'swipe' | 'clear_all' | 'cap_evict' | 'orphan_sweep' | 'copy_failed' | 'added';
export type CopySource = 'normalized' | 'raw';

type PersistedCapture = Pick<RecentCapture,
  | 'id'
  | 'scanID'
  | 'mode'
  | 'uri'
  | 'normalizedImageUri'
  | 'candidates'
  | 'activeCandidateIndex'
  | 'totalCandidateCount'
  | 'matchReviewDisposition'
  | 'matchReviewReason'
  | 'slabContext'
  | 'normalizedImageDimensions'
  | 'sourceImageCrop'
  | 'sourceImageDimensions'
  | 'sourceImageRotationDegrees'
>;

type PersistedTrayEnvelope = {
  version: number;
  // The account the persisted tray belongs to (Supabase user id, or null when
  // signed out). Stamped on every write so a different account's load can detect
  // the mismatch and clear the tray instead of showing the prior account's scans.
  // Absent on envelopes written before this was introduced ("legacy") — those are
  // adopted by whatever account first loads them, then re-stamped.
  ownerKey?: string | null;
  items: PersistedCapture[];
};

let scansDirReady = false;
let scansDirPromise: Promise<void> | null = null;
let pendingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: RecentCapture[] | null = null;
let pendingChangeCount = 0;
let isWriting = false;
// Snapshot handed to `writePersistedTray` while another write was already in
// flight. Depth-1 on purpose: a newer snapshot supersedes an older one (each
// snapshot is the FULL tray, not a delta), so this can never grow. The
// in-flight write drains it when it resolves — see `writePersistedTray`.
let queuedSnapshot: RecentCapture[] | null = null;
let queuedWaiters: (() => void)[] = [];
// The owner the tray currently belongs to. Set by the scanner before it loads
// (so a write/stamp uses the right account) and compared on load.
let currentOwnerKey: string | null = null;

function normalizeOwnerKey(ownerKey: string | null | undefined): string | null {
  const trimmed = (ownerKey ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Tell the persistence layer which account the tray belongs to. Call this
 * synchronously before loading the tray on scanner mount so account switches are
 * detected and writes are stamped with the right owner. */
export function setRecentCapturesOwner(ownerKey: string | null | undefined): void {
  currentOwnerKey = normalizeOwnerKey(ownerKey);
}

/**
 * `Promise.all` with a worker cap. Results stay in input order. Used for the
 * per-item filesystem probes on load and the orphan sweep's deletes, both of
 * which scale with tray/disk size.
 */
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

function reportError(kind: 'write' | 'read' | 'copy' | 'delete' | 'sweep', error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  capturePostHogEvent('scan_tray_persist_error', { kind, message });
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
      } catch (error) {
        reportError('write', error);
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
  const startedAt = Date.now();
  let bytes: number | null = null;
  try {
    await ensureScansDir();
    const destination = scanFilePath(id, source);
    await FileSystem.copyAsync({ from: srcUri, to: destination });
    try {
      const info = await FileSystem.getInfoAsync(destination);
      if (info.exists) {
        bytes = info.size;
      }
    } catch {
      // Size lookup is best-effort; the copy already succeeded.
    }
    return destination;
  } catch (error) {
    reportError('copy', error);
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
  const startedAt = Date.now();
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    reportError('delete', error);
  }
}

/**
 * Persist a PREFIX of the candidate list, never a window.
 *
 * Normally that prefix is the first `PERSISTED_CANDIDATES_MAX` (10) entries. The
 * one exception is a selection the user paged to: if `activeCandidateIndex` is
 * 25, a flat `slice(0, 10)` would orphan the selection on reload, so the prefix
 * is extended to include it (26 entries here). That costs bytes only for the
 * rare capture where someone actually paged deep AND picked a deep result —
 * which is exactly the data worth keeping.
 *
 * A prefix (rather than a window around the active index) is load-bearing for
 * two reasons: `activeCandidateIndex` stays valid with no remapping, and
 * `loadMoreCandidates` pages with `offset = candidates.length`, which is only
 * correct if the stored array is the head of the backend's ranked list.
 */
function persistedCandidatesFor(capture: RecentCapture): RecentCapture['candidates'] {
  const activeIndex = Number.isFinite(capture.activeCandidateIndex)
    ? Math.max(0, Math.floor(capture.activeCandidateIndex))
    : 0;
  const keepCount = Math.max(PERSISTED_CANDIDATES_MAX, activeIndex + 1);
  if (capture.candidates.length <= keepCount) {
    return capture.candidates;
  }
  return capture.candidates.slice(0, keepCount);
}

function toPersistedCapture(capture: RecentCapture): PersistedCapture {
  return {
    id: capture.id,
    scanID: capture.scanID,
    mode: capture.mode,
    uri: capture.uri,
    normalizedImageUri: capture.normalizedImageUri,
    candidates: persistedCandidatesFor(capture),
    activeCandidateIndex: capture.activeCandidateIndex,
    totalCandidateCount: capture.totalCandidateCount,
    matchReviewDisposition: capture.matchReviewDisposition,
    matchReviewReason: capture.matchReviewReason,
    slabContext: capture.slabContext,
    normalizedImageDimensions: capture.normalizedImageDimensions,
    sourceImageCrop: capture.sourceImageCrop,
    sourceImageDimensions: capture.sourceImageDimensions,
    sourceImageRotationDegrees: capture.sourceImageRotationDegrees,
  };
}

function fromPersistedCapture(persisted: PersistedCapture): RecentCapture {
  return {
    ...persisted,
    // Defensive clamp: writes always keep the active candidate inside the
    // persisted prefix (see `persistedCandidatesFor`), but an envelope written
    // by an older/partial code path must never rehydrate a row whose active
    // index points past its own candidate array.
    activeCandidateIndex: Math.min(
      Math.max(0, persisted.activeCandidateIndex),
      Math.max(0, persisted.candidates.length - 1),
    ),
    // Older envelopes predate totalCandidateCount; fall back to what we have.
    totalCandidateCount: persisted.totalCandidateCount ?? persisted.candidates.length,
    isLoadingMoreCandidates: false,
    hasTrackedSelectionEvent: false,
    isAddingToInventory: false,
    isLoadingCandidates: false,
    recentlyAdded: false,
  };
}

function isPersistableItem(capture: RecentCapture): boolean {
  // Skip in-flight scans: they're still loading and rehydrating them after a
  // force-quit would leave a permanently spinning row. Also skip items missing
  // a normalized image — there's nothing to anchor the rehydrated row to.
  return !capture.isLoadingCandidates && Boolean(capture.normalizedImageUri);
}

/**
 * One AsyncStorage write. Never rejects: every failure — including envelope
 * construction and serialization — is reported and swallowed. `writePersistedTray`
 * depends on this so its drain loop cannot be aborted mid-queue.
 */
async function performTrayWrite(items: RecentCapture[]): Promise<void> {
  const startedAt = Date.now();
  let envelope: PersistedTrayEnvelope;
  let serialized: string;
  let skippedLoading: number;
  let coalescedChangeCount: number;
  try {
    const persistable = items.filter(isPersistableItem);
    skippedLoading = items.length - persistable.length;
    envelope = {
      version: PERSIST_ENVELOPE_VERSION,
      ownerKey: currentOwnerKey,
      items: persistable.map(toPersistedCapture),
    };
    coalescedChangeCount = pendingChangeCount;
    pendingChangeCount = 0;
    serialized = JSON.stringify(envelope);
  } catch (error) {
    reportError('write', error);
    return;
  }
  try {
    await AsyncStorage.setItem(RECENT_CAPTURES_STORAGE_KEY, serialized);
  } catch (error) {
    reportError('write', error);
  }
}

/**
 * Serialize tray writes without losing any of them.
 *
 * Previously this early-returned when a write was already in flight — and by
 * then `schedulePersist` had already nulled `pendingSnapshot` and cleared its
 * timer, so the colliding change set was silently DROPPED (recovered only by
 * the next mutation or the unmount flush). Harmless at ~30 ms writes; at 150+
 * items writes take hundreds of ms and the casualty is the last scan of a
 * burst, which is precisely when a dealer notices.
 *
 * Now the colliding snapshot is stashed and drained by the in-flight writer
 * once it resolves, and the colliding caller gets a promise that resolves only
 * after ITS data has actually landed (so an unmount flush still awaits a real
 * write).
 *
 * No infinite loop / no recursion: the queue is depth-1 (each snapshot is the
 * whole tray, so a newer one replaces an older one rather than stacking), the
 * drain is an iterative `while` rather than a re-entrant call, and the loop
 * exits as soon as no new snapshot arrived during the previous write. Nothing
 * inside this function ever enqueues — only external callers do.
 */
async function writePersistedTray(items: RecentCapture[]): Promise<void> {
  if (isWriting) {
    queuedSnapshot = items;
    return new Promise<void>((resolve) => {
      queuedWaiters.push(resolve);
    });
  }
  isWriting = true;
  try {
    await performTrayWrite(items);
    while (queuedSnapshot) {
      const nextSnapshot = queuedSnapshot;
      const waiters = queuedWaiters;
      queuedSnapshot = null;
      queuedWaiters = [];
      try {
        await performTrayWrite(nextSnapshot);
      } finally {
        // Always release the waiters, even if a write blew up, so an awaiting
        // unmount flush can never hang.
        waiters.forEach((resolve) => resolve());
      }
    }
  } finally {
    // Safe: the loop condition and this assignment are separated by no `await`,
    // so nothing can enqueue between "queue is empty" and "writer is free".
    isWriting = false;
  }
}

export function schedulePersist(items: RecentCapture[]): void {
  pendingSnapshot = items;
  pendingChangeCount += 1;
  if (pendingDebounceTimer) {
    return;
  }
  pendingDebounceTimer = setTimeout(() => {
    pendingDebounceTimer = null;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    if (!snapshot) {
      return;
    }
    void writePersistedTray(snapshot);
  }, PERSIST_DEBOUNCE_MS);
}

export async function flushPersist(explicit?: RecentCapture[]): Promise<void> {
  if (pendingDebounceTimer) {
    clearTimeout(pendingDebounceTimer);
    pendingDebounceTimer = null;
  }
  // Prefer an explicit snapshot when the caller knows exactly what storage
  // should hold (e.g. unmount passes the live tray; Clear All passes []).
  const snapshot = explicit !== undefined ? explicit : pendingSnapshot;
  pendingSnapshot = null;
  if (snapshot == null) {
    // Nothing pending and no explicit state: the last debounced write already
    // reflects the tray. Writing [] here would wipe a perfectly good tray that
    // is simply idle (e.g. unmounting on navigation) — leave storage as-is.
    return;
  }
  await writePersistedTray(snapshot);
}

function isPersistedCapture(value: unknown): value is PersistedCapture {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as PersistedCapture;
  return (
    typeof candidate.id === 'string'
    && (candidate.mode === 'raw' || candidate.mode === 'slabs')
    && Array.isArray(candidate.candidates)
    && typeof candidate.activeCandidateIndex === 'number'
  );
}

export async function loadPersistedTray(): Promise<RecentCapture[]> {
  const totalStartedAt = Date.now();
  let raw: string | null = null;
  let readMs = 0;
  let parseMs = 0;
  let verifyMs = 0;
  try {
    const readStartedAt = Date.now();
    raw = await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY);
    readMs = Date.now() - readStartedAt;
  } catch (error) {
    reportError('read', error);
    return [];
  }
  if (!raw) {
    return [];
  }
  let envelope: PersistedTrayEnvelope | null = null;
  try {
    const parseStartedAt = Date.now();
    const parsed = JSON.parse(raw) as PersistedTrayEnvelope | null;
    parseMs = Date.now() - parseStartedAt;
    if (parsed && parsed.version === PERSIST_ENVELOPE_VERSION && Array.isArray(parsed.items)) {
      envelope = parsed;
    }
  } catch (error) {
    reportError('read', error);
  }
  if (!envelope) {
    // Version mismatch or corrupt JSON — drop everything cleanly so we don't
    // keep retrying to parse broken data forever.
    try {
      await AsyncStorage.removeItem(RECENT_CAPTURES_STORAGE_KEY);
    } catch (error) {
      reportError('write', error);
    }
    return [];
  }
  // Account switch: if this tray was explicitly stamped for a DIFFERENT account,
  // clear it (and its on-disk images) so the new account starts from an empty
  // tray instead of inheriting the previous account's scans. A legacy tray
  // (ownerKey absent) is adopted by the current account below, not cleared, so
  // existing users don't lose their tray on the upgrade that introduced this.
  if (envelope.ownerKey !== undefined && normalizeOwnerKey(envelope.ownerKey) !== currentOwnerKey) {
    try {
      await AsyncStorage.removeItem(RECENT_CAPTURES_STORAGE_KEY);
    } catch (error) {
      reportError('write', error);
    }
    await sweepOrphanScans(new Set());
    return [];
  }

  const validItems = envelope.items.filter(isPersistedCapture);
  const verifyStartedAt = Date.now();
  // Bounded: at a 150-item cap (and larger legacy trays) an unbounded
  // Promise.all here fires hundreds of concurrent native FS probes at mount.
  const existsResults = await mapWithConcurrency(validItems, FS_CONCURRENCY_LIMIT, async (item) => {
    const probe = item.normalizedImageUri || item.uri;
    if (!probe) {
      return false;
    }
    try {
      const info = await FileSystem.getInfoAsync(probe);
      return info.exists;
    } catch {
      return false;
    }
  });
  verifyMs = Date.now() - verifyStartedAt;
  const survivors: RecentCapture[] = [];
  let dropped = 0;
  validItems.forEach((item, idx) => {
    if (existsResults[idx]) {
      survivors.push(fromPersistedCapture(item));
    } else {
      dropped += 1;
    }
  });
  // Legacy (unstamped) tray adopted by the current account: re-stamp it now so a
  // later switch to another account detects the mismatch and clears it.
  if (envelope.ownerKey === undefined && survivors.length > 0) {
    void writePersistedTray(survivors);
  }
  return survivors;
}

export async function sweepOrphanScans(keepIds: Set<string>): Promise<void> {
  const startedAt = Date.now();
  let filesScanned = 0;
  let orphansDeleted = 0;
  try {
    await ensureScansDir();
    const entries = await FileSystem.readDirectoryAsync(RECENT_CAPTURES_DIR);
    filesScanned = entries.length;
    // Bounded: the scans dir holds up to two files per capture, so a full sweep
    // (e.g. account switch on a 150-item tray) would otherwise issue 300
    // concurrent deletes.
    await mapWithConcurrency(entries, FS_CONCURRENCY_LIMIT, async (name) => {
      // Strip `-src.jpg` or `.jpg` to recover the capture id.
      const id = name.replace(/-src\.jpg$/, '').replace(/\.jpg$/, '');
      if (keepIds.has(id)) {
        return;
      }
      try {
        await FileSystem.deleteAsync(`${RECENT_CAPTURES_DIR}${name}`, { idempotent: true });
        orphansDeleted += 1;
      } catch (error) {
        reportError('sweep', error);
      }
    });
  } catch (error) {
    reportError('sweep', error);
  }
}

export function __resetRecentCapturesPersistenceForTests(): void {
  scansDirReady = false;
  scansDirPromise = null;
  if (pendingDebounceTimer) {
    clearTimeout(pendingDebounceTimer);
    pendingDebounceTimer = null;
  }
  pendingSnapshot = null;
  pendingChangeCount = 0;
  isWriting = false;
  queuedSnapshot = null;
  queuedWaiters.forEach((resolve) => resolve());
  queuedWaiters = [];
  currentOwnerKey = null;
}
