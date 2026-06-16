import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import {
  __resetRecentCapturesPersistenceForTests,
  copyToScansDir,
  deleteScanFile,
  ensureScansDir,
  flushPersist,
  loadPersistedTray,
  PERSIST_DEBOUNCE_MS,
  PERSIST_ENVELOPE_VERSION,
  RECENT_CAPTURES_DIR,
  RECENT_CAPTURES_MAX,
  RECENT_CAPTURES_STORAGE_KEY,
  schedulePersist,
  setRecentCapturesOwner,
  sweepOrphanScans,
} from '@/features/scanner/recent-captures-persistence';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      removeItem: jest.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
    },
  };
});

jest.mock('expo-file-system/legacy', () => {
  const files = new Map<string, { size: number }>();
  const directories = new Set<string>(['file:///document/']);
  return {
    __esModule: true,
    documentDirectory: 'file:///document/',
    getInfoAsync: jest.fn(async (uri: string) => {
      if (files.has(uri)) {
        return { exists: true, uri, size: files.get(uri)!.size, isDirectory: false, modificationTime: 0 };
      }
      if (directories.has(uri)) {
        return { exists: true, uri, size: 0, isDirectory: true, modificationTime: 0 };
      }
      return { exists: false };
    }),
    copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
      const src = files.get(from);
      const size = src?.size ?? 1024;
      files.set(to, { size });
    }),
    deleteAsync: jest.fn(async (uri: string) => {
      files.delete(uri);
    }),
    makeDirectoryAsync: jest.fn(async (uri: string) => {
      directories.add(uri);
    }),
    readDirectoryAsync: jest.fn(async (uri: string) => {
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      return Array.from(files.keys())
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
    }),
    __seedFile: (uri: string, size = 1024) => {
      files.set(uri, { size });
    },
    __seedDirectory: (uri: string) => {
      directories.add(uri);
    },
    __getFiles: () => new Map(files),
    __clearMockState: () => {
      files.clear();
      directories.clear();
      directories.add('file:///document/');
    },
  };
});

const mockedFs = FileSystem as unknown as {
  __seedFile: (uri: string, size?: number) => void;
  __seedDirectory: (uri: string) => void;
  __getFiles: () => Map<string, { size: number }>;
  __clearMockState: () => void;
};

function makeCapture(overrides: Partial<RecentCapture> = {}): RecentCapture {
  return {
    activeCandidateIndex: 0,
    candidates: [],
    totalCandidateCount: 0,
    isLoadingMoreCandidates: false,
    hasTrackedSelectionEvent: false,
    id: 'cap-1',
    isAddingToInventory: false,
    isLoadingCandidates: false,
    matchReviewDisposition: null,
    matchReviewReason: null,
    mode: 'raw',
    normalizedImageDimensions: null,
    normalizedImageUri: `${RECENT_CAPTURES_DIR}cap-1.jpg`,
    recentlyAdded: false,
    scanID: 'scan-1',
    slabContext: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
    uri: `${RECENT_CAPTURES_DIR}cap-1.jpg`,
    ...overrides,
  };
}

describe('recent-captures-persistence', () => {
  beforeEach(async () => {
    __resetRecentCapturesPersistenceForTests();
    mockedFs.__clearMockState();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('schedulePersist + flushPersist', () => {
    it('debounces writes and persists only non-loading items', async () => {
      const loading = makeCapture({ id: 'loading', isLoadingCandidates: true });
      const ready = makeCapture({ id: 'ready' });
      mockedFs.__seedFile(ready.normalizedImageUri!);

      schedulePersist([loading, ready]);
      schedulePersist([loading, ready]); // second call should be coalesced
      expect(await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY)).toBeNull();

      jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();

      const raw = await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const envelope = JSON.parse(raw!);
      expect(envelope.version).toBe(PERSIST_ENVELOPE_VERSION);
      expect(envelope.items).toHaveLength(1);
      expect(envelope.items[0].id).toBe('ready');
    });

    it('flushPersist([]) writes the empty state immediately (for Clear All)', async () => {
      const ready = makeCapture();
      mockedFs.__seedFile(ready.normalizedImageUri!);
      schedulePersist([ready]);
      jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();

      // Clear All passes [] explicitly — overwrite now, don't wait for debounce.
      await flushPersist([]);
      const raw = await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY);
      const envelope = JSON.parse(raw!);
      expect(envelope.items).toHaveLength(0);
    });

    it('argument-less flushPersist does NOT clobber a settled tray (unmount on nav)', async () => {
      const ready = makeCapture();
      mockedFs.__seedFile(ready.normalizedImageUri!);
      schedulePersist([ready]);
      jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();

      // The debounce has settled (nothing pending). An unmount flush with no
      // explicit snapshot must leave the persisted tray intact — previously it
      // wrote [] and wiped every scan on each page bounce.
      await flushPersist();
      const raw = await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY);
      const envelope = JSON.parse(raw!);
      expect(envelope.items).toHaveLength(1);
      expect(envelope.items[0].id).toBe(ready.id);
    });

    it('flushPersist(tray) persists the live tray on unmount', async () => {
      const ready = makeCapture({ id: 'live' });
      mockedFs.__seedFile(ready.normalizedImageUri!);

      // No prior debounced write — the unmount flush is the only persist.
      await flushPersist([ready]);
      const raw = await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY);
      const envelope = JSON.parse(raw!);
      expect(envelope.items).toHaveLength(1);
      expect(envelope.items[0].id).toBe('live');
    });
  });

  describe('loadPersistedTray', () => {
    it('returns an empty array when nothing is stored', async () => {
      const result = await loadPersistedTray();
      expect(result).toEqual([]);
    });

    it('drops items whose files no longer exist', async () => {
      const survives = makeCapture({ id: 'survives', normalizedImageUri: `${RECENT_CAPTURES_DIR}survives.jpg` });
      const evicted = makeCapture({ id: 'evicted', normalizedImageUri: `${RECENT_CAPTURES_DIR}evicted.jpg` });
      mockedFs.__seedFile(survives.normalizedImageUri!);
      // Note: do not seed `evicted` — its file is "missing".

      schedulePersist([survives, evicted]);
      jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();

      const loaded = await loadPersistedTray();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('survives');
      // Ephemeral fields must reset on rehydrate.
      expect(loaded[0].isLoadingCandidates).toBe(false);
      expect(loaded[0].isAddingToInventory).toBe(false);
      expect(loaded[0].recentlyAdded).toBe(false);
      expect(loaded[0].hasTrackedSelectionEvent).toBe(false);
    });

    it('drops everything and clears storage on version mismatch', async () => {
      await AsyncStorage.setItem(
        RECENT_CAPTURES_STORAGE_KEY,
        JSON.stringify({ version: 99, items: [{ id: 'x' }] }),
      );
      const loaded = await loadPersistedTray();
      expect(loaded).toEqual([]);
      const raw = await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY);
      expect(raw).toBeNull();
    });

    it('treats corrupt JSON as empty without throwing', async () => {
      await AsyncStorage.setItem(RECENT_CAPTURES_STORAGE_KEY, '{not valid json');
      const loaded = await loadPersistedTray();
      expect(loaded).toEqual([]);
    });
  });

  describe('account scoping', () => {
    it('stamps writes with the current account owner', async () => {
      const cap = makeCapture();
      mockedFs.__seedFile(cap.normalizedImageUri!);
      setRecentCapturesOwner('user-a');
      await flushPersist([cap]);

      const envelope = JSON.parse((await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY))!);
      expect(envelope.ownerKey).toBe('user-a');
    });

    it('keeps the tray when reloaded under the same account', async () => {
      const cap = makeCapture();
      mockedFs.__seedFile(cap.normalizedImageUri!);
      setRecentCapturesOwner('user-a');
      await flushPersist([cap]);

      setRecentCapturesOwner('user-a');
      const loaded = await loadPersistedTray();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe(cap.id);
    });

    it('clears the tray + its images when loaded under a DIFFERENT account', async () => {
      const cap = makeCapture();
      mockedFs.__seedFile(cap.normalizedImageUri!);
      setRecentCapturesOwner('user-a');
      await flushPersist([cap]);

      // Switching accounts: a new owner loads the tray.
      setRecentCapturesOwner('user-b');
      const loaded = await loadPersistedTray();

      expect(loaded).toEqual([]);
      // Storage wiped and the previous account's image swept off disk.
      expect(await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY)).toBeNull();
      expect(mockedFs.__getFiles().has(cap.normalizedImageUri!)).toBe(false);
    });

    it('clears when a signed-in account loads a signed-out (null-owner) tray', async () => {
      const cap = makeCapture();
      mockedFs.__seedFile(cap.normalizedImageUri!);
      setRecentCapturesOwner(null); // signed out
      await flushPersist([cap]);

      setRecentCapturesOwner('user-a'); // now signed in
      const loaded = await loadPersistedTray();
      expect(loaded).toEqual([]);
    });

    it('adopts a legacy (unstamped) tray and re-stamps it for the current account', async () => {
      const cap = makeCapture();
      mockedFs.__seedFile(cap.normalizedImageUri!);
      // Pre-upgrade envelope: no ownerKey field at all.
      await AsyncStorage.setItem(
        RECENT_CAPTURES_STORAGE_KEY,
        JSON.stringify({
          version: PERSIST_ENVELOPE_VERSION,
          items: [
            {
              id: cap.id,
              scanID: cap.scanID,
              mode: 'raw',
              uri: cap.uri,
              normalizedImageUri: cap.normalizedImageUri,
              candidates: [],
              activeCandidateIndex: 0,
              totalCandidateCount: 0,
              matchReviewDisposition: null,
              matchReviewReason: null,
              slabContext: null,
              normalizedImageDimensions: null,
              sourceImageCrop: null,
              sourceImageDimensions: null,
              sourceImageRotationDegrees: 0,
            },
          ],
        }),
      );

      setRecentCapturesOwner('user-a');
      const loaded = await loadPersistedTray();
      expect(loaded).toHaveLength(1); // adopted, not cleared

      // The legacy tray was re-stamped with the current account so a later switch
      // to another account clears it. (loadPersistedTray re-writes fire-and-forget.)
      await Promise.resolve();
      await Promise.resolve();
      const envelope = JSON.parse((await AsyncStorage.getItem(RECENT_CAPTURES_STORAGE_KEY))!);
      expect(envelope.ownerKey).toBe('user-a');
    });
  });

  describe('copyToScansDir', () => {
    it('copies a source uri into the persistent scans dir', async () => {
      mockedFs.__seedFile('file:///cache/tmp.jpg', 4096);
      const dest = await copyToScansDir('file:///cache/tmp.jpg', 'cap-99');
      expect(dest).toBe(`${RECENT_CAPTURES_DIR}cap-99.jpg`);
      expect(mockedFs.__getFiles().has(dest!)).toBe(true);
    });

    it('returns the same uri without copying when source is already persisted', async () => {
      const alreadyPersisted = `${RECENT_CAPTURES_DIR}cap-2.jpg`;
      const dest = await copyToScansDir(alreadyPersisted, 'cap-2');
      expect(dest).toBe(alreadyPersisted);
      expect((FileSystem.copyAsync as jest.Mock).mock.calls.length).toBe(0);
    });

    it('returns null on copy failure', async () => {
      (FileSystem.copyAsync as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      const dest = await copyToScansDir('file:///cache/tmp.jpg', 'cap-3');
      expect(dest).toBeNull();
    });

    it('writes raw-source variant with a -src suffix', async () => {
      mockedFs.__seedFile('file:///cache/raw.jpg', 8192);
      const dest = await copyToScansDir('file:///cache/raw.jpg', 'cap-4', 'raw', 'slabs');
      expect(dest).toBe(`${RECENT_CAPTURES_DIR}cap-4-src.jpg`);
    });
  });

  describe('deleteScanFile', () => {
    it('deletes files that live inside the scans dir', async () => {
      const uri = `${RECENT_CAPTURES_DIR}cap-x.jpg`;
      mockedFs.__seedFile(uri);
      await deleteScanFile(uri, 'swipe');
      expect(mockedFs.__getFiles().has(uri)).toBe(false);
    });

    it('does nothing for uris outside the scans dir', async () => {
      await deleteScanFile('file:///cache/random.jpg', 'swipe');
      expect((FileSystem.deleteAsync as jest.Mock).mock.calls.length).toBe(0);
    });
  });

  describe('sweepOrphanScans', () => {
    it('deletes files whose id is not in the keep set, leaves the rest', async () => {
      mockedFs.__seedFile(`${RECENT_CAPTURES_DIR}keep.jpg`);
      mockedFs.__seedFile(`${RECENT_CAPTURES_DIR}keep-src.jpg`);
      mockedFs.__seedFile(`${RECENT_CAPTURES_DIR}orphan.jpg`);
      mockedFs.__seedFile(`${RECENT_CAPTURES_DIR}orphan-src.jpg`);

      await sweepOrphanScans(new Set(['keep']));

      const remaining = Array.from(mockedFs.__getFiles().keys()).sort();
      expect(remaining).toEqual([
        `${RECENT_CAPTURES_DIR}keep-src.jpg`,
        `${RECENT_CAPTURES_DIR}keep.jpg`,
      ]);
    });
  });

  describe('ensureScansDir', () => {
    it('makes the directory only when it does not already exist', async () => {
      await ensureScansDir();
      expect((FileSystem.makeDirectoryAsync as jest.Mock).mock.calls).toEqual([
        [RECENT_CAPTURES_DIR, { intermediates: true }],
      ]);

      // Second call should be a no-op thanks to the cached flag.
      (FileSystem.makeDirectoryAsync as jest.Mock).mockClear();
      await ensureScansDir();
      expect((FileSystem.makeDirectoryAsync as jest.Mock).mock.calls.length).toBe(0);
    });
  });

  it('exposes the agreed-upon cap', () => {
    expect(RECENT_CAPTURES_MAX).toBe(50);
  });
});
