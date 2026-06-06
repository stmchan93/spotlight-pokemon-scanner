import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { capturePostHogEvent } from '@/lib/observability/posthog';

import type { RecentCapture } from './screens/scanner-screen-types';

export const RECENT_CAPTURES_STORAGE_KEY = '@spotlight/scanner/recent-captures';
export const RECENT_CAPTURES_DIR = `${FileSystem.documentDirectory ?? ''}scans/`;
export const RECENT_CAPTURES_MAX = 50;
export const PERSIST_DEBOUNCE_MS = 500;
export const PERSIST_ENVELOPE_VERSION = 1;

export type DeleteReason = 'swipe' | 'clear_all' | 'cap_evict' | 'orphan_sweep' | 'copy_failed';
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
  items: PersistedCapture[];
};

let scansDirReady = false;
let scansDirPromise: Promise<void> | null = null;
let pendingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: RecentCapture[] | null = null;
let pendingChangeCount = 0;
let isWriting = false;

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
    capturePostHogEvent('scan_tray_persist_copy', {
      copy_ms: Date.now() - startedAt,
      success: 1,
      mode,
      source,
      ...(bytes != null ? { bytes } : {}),
    });
    return destination;
  } catch (error) {
    capturePostHogEvent('scan_tray_persist_copy', {
      copy_ms: Date.now() - startedAt,
      success: 0,
      mode,
      source,
    });
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
    capturePostHogEvent('scan_tray_persist_delete', {
      delete_ms: Date.now() - startedAt,
      success: 1,
      reason,
    });
  } catch (error) {
    capturePostHogEvent('scan_tray_persist_delete', {
      delete_ms: Date.now() - startedAt,
      success: 0,
      reason,
    });
    reportError('delete', error);
  }
}

function toPersistedCapture(capture: RecentCapture): PersistedCapture {
  return {
    id: capture.id,
    scanID: capture.scanID,
    mode: capture.mode,
    uri: capture.uri,
    normalizedImageUri: capture.normalizedImageUri,
    candidates: capture.candidates,
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

async function writePersistedTray(items: RecentCapture[]): Promise<void> {
  if (isWriting) {
    return;
  }
  isWriting = true;
  const startedAt = Date.now();
  const persistable = items.filter(isPersistableItem);
  const skippedLoading = items.length - persistable.length;
  const envelope: PersistedTrayEnvelope = {
    version: PERSIST_ENVELOPE_VERSION,
    items: persistable.map(toPersistedCapture),
  };
  const coalescedChangeCount = pendingChangeCount;
  pendingChangeCount = 0;
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
  } catch (error) {
    reportError('write', error);
    isWriting = false;
    return;
  }
  try {
    await AsyncStorage.setItem(RECENT_CAPTURES_STORAGE_KEY, serialized);
    capturePostHogEvent('scan_tray_persist_write', {
      item_count: envelope.items.length,
      serialized_bytes: serialized.length,
      write_ms: Date.now() - startedAt,
      skipped_loading_count: skippedLoading,
      coalesced_change_count: coalescedChangeCount,
    });
  } catch (error) {
    reportError('write', error);
  } finally {
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
    capturePostHogEvent('scan_tray_persist_read', {
      item_count_loaded: 0,
      item_count_dropped_missing_file: 0,
      read_ms: 0,
      parse_ms: 0,
      verify_ms: 0,
      total_ms: Date.now() - totalStartedAt,
    });
    return [];
  }
  if (!raw) {
    capturePostHogEvent('scan_tray_persist_read', {
      item_count_loaded: 0,
      item_count_dropped_missing_file: 0,
      read_ms: readMs,
      parse_ms: 0,
      verify_ms: 0,
      total_ms: Date.now() - totalStartedAt,
    });
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
    capturePostHogEvent('scan_tray_persist_read', {
      item_count_loaded: 0,
      item_count_dropped_missing_file: 0,
      read_ms: readMs,
      parse_ms: parseMs,
      verify_ms: 0,
      total_ms: Date.now() - totalStartedAt,
    });
    return [];
  }
  const validItems = envelope.items.filter(isPersistedCapture);
  const verifyStartedAt = Date.now();
  const existsResults = await Promise.all(validItems.map(async (item) => {
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
  }));
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
  capturePostHogEvent('scan_tray_persist_read', {
    item_count_loaded: survivors.length,
    item_count_dropped_missing_file: dropped,
    read_ms: readMs,
    parse_ms: parseMs,
    verify_ms: verifyMs,
    total_ms: Date.now() - totalStartedAt,
  });
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
    await Promise.all(entries.map(async (name) => {
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
    }));
    capturePostHogEvent('scan_tray_orphan_sweep', {
      sweep_ms: Date.now() - startedAt,
      orphans_deleted: orphansDeleted,
      files_scanned: filesScanned,
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
}
