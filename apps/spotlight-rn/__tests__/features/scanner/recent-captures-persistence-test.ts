import * as FileSystem from 'expo-file-system/legacy';

import { AppState } from 'react-native';

import {
  __resetRecentCapturesPersistenceForTests,
  assignSortKeys,
  copyToScansDir,
  deleteScanFile,
  ensureScansDir,
  findCapturesWithMissingImages,
  flushPersist,
  FS_CONCURRENCY_LIMIT,
  loadPersistedTraySnapshot,
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_WAIT_MS,
  RECENT_CAPTURES_DIR,
  schedulePersist,
  setRecentCapturesOwner,
  sweepOrphanScans,
} from '@/features/scanner/recent-captures-persistence';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';
import * as trayDb from '@/features/scanner/tray-db';

import { __fakeSQLiteLog, __setFakeSQLiteFault } from '../../../test-support/fake-expo-sqlite';
import { readTrayRows, seedTrayRows } from '../../../test-support/scan-tray-db';

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
      files.set(to, { size: src?.size ?? 1024 });
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
  __getFiles: () => Map<string, { size: number }>;
  __clearMockState: () => void;
};

function makeCapture(overrides: Partial<RecentCapture> = {}): RecentCapture {
  const id = overrides.id ?? 'cap-1';
  return {
    activeCandidateIndex: 0,
    candidates: [],
    totalCandidateCount: 0,
    isLoadingMoreCandidates: false,
    hasTrackedSelectionEvent: false,
    id,
    isAddingToInventory: false,
    isLoadingCandidates: false,
    matchReviewDisposition: null,
    matchReviewReason: null,
    mode: 'raw',
    normalizedImageDimensions: null,
    normalizedImageUri: `${RECENT_CAPTURES_DIR}${id}.jpg`,
    recentlyAdded: false,
    scanID: `scan-${id}`,
    slabContext: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
    uri: `${RECENT_CAPTURES_DIR}${id}-src.jpg`,
    ...overrides,
  };
}

function makeCandidates(count: number): RecentCapture['candidates'] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `cand-${index}`,
    cardId: `card-${index}`,
    name: `Card ${index}`,
    cardNumber: `${index}`,
    setName: 'Test Set',
    imageUrl: `https://example.test/${index}.png`,
  }));
}

const captures = (count: number, prefix = 'cap') => Array.from(
  { length: count },
  (_unused, index) => makeCapture({ id: `${prefix}-${index}` }),
);

/** Enough microtask turns for a write to go through the DB queue and commit. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    await Promise.resolve();
  }
}

/** Let the debounce elapse, then the idle-deferred write (a 0ms timer in jest), then the DB work. */
async function settleDebouncedWrite(): Promise<void> {
  jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
  jest.advanceTimersByTime(1);
  await drain();
}

const storedIds = async (owner: string | null = null) => (await readTrayRows(owner)).map((row) => row.id);
const upsertCount = () => __fakeSQLiteLog().filter((sql) => sql.startsWith('INSERT INTO scan_tray_rows')).length;
const transactionCount = () => __fakeSQLiteLog().filter((sql) => sql === 'BEGIN').length;

async function hydrate(owner: string | null) {
  __resetRecentCapturesPersistenceForTests();
  setRecentCapturesOwner(owner);
  return loadPersistedTraySnapshot();
}

describe('recent-captures-persistence (tray DB)', () => {
  beforeEach(() => {
    __resetRecentCapturesPersistenceForTests();
    mockedFs.__clearMockState();
    jest.clearAllMocks();
    jest.restoreAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('writes only what changed', () => {
    it('upserts new and edited rows only, each flush in one transaction', async () => {
      const [a, b] = captures(2);
      await readTrayRows(null); // open the DB so its schema transaction isn't counted
      const baseTxns = transactionCount();
      await flushPersist([a, b]);
      expect(upsertCount()).toBe(2);
      expect(transactionCount()).toBe(baseTxns + 1);

      const editedB = { ...b, activeCandidateIndex: 0, matchReviewReason: 'edited' };
      await flushPersist([a, editedB]);
      expect(upsertCount()).toBe(3);
      expect(transactionCount()).toBe(baseTxns + 2);

      // Same objects again: nothing to write, no transaction at all.
      await flushPersist([a, editedB]);
      expect(upsertCount()).toBe(3);
      expect(transactionCount()).toBe(baseTxns + 2);

      expect((await readTrayRows(null)).find((row) => row.id === b.id)?.capture.matchReviewReason).toBe('edited');
    });

    it('a new scan at the top writes one row; the others keep their sort keys', async () => {
      const rows = captures(5);
      await flushPersist(rows);
      const before = await readTrayRows(null);

      const newest = makeCapture({ id: 'newest' });
      await flushPersist([newest, ...rows]);
      expect(upsertCount()).toBe(6);

      const after = await readTrayRows(null);
      expect(after.map((row) => row.id)).toEqual(['newest', ...rows.map((row) => row.id)]);
      expect(after.slice(1).map((row) => row.sortKey)).toEqual(before.map((row) => row.sortKey));
    });

    it('a price pick on one row rewrites only that row', async () => {
      const [a, b] = captures(2);
      await flushPersist([a, b], new Map());
      const pick = {
        variantKey: 'holofoil',
        variantLabel: 'Holofoil',
        conditionCode: 'lightly_played' as const,
        conditionShortLabel: 'LP',
        marketPrice: 4.2,
      };
      await flushPersist([a, b], new Map([[b.id, pick]]));
      expect(upsertCount()).toBe(3);
      expect((await readTrayRows(null)).find((row) => row.id === b.id)?.priceSelection).toEqual(pick);
    });

    it('deletes removed rows and keeps the rest', async () => {
      const [a, b, c] = captures(3);
      await flushPersist([a, b, c]);
      await flushPersist([a, c]);
      expect(await storedIds()).toEqual([a.id, c.id]);
      expect(upsertCount()).toBe(3);
    });

    it('removing many rows at once is one transaction', async () => {
      const rows = captures(200);
      await flushPersist(rows);
      const beforeTxns = transactionCount();
      await flushPersist(rows.slice(0, 50));
      expect(transactionCount()).toBe(beforeTxns + 1);
      expect(await storedIds()).toHaveLength(50);
    });

    it('Clear All is a single delete statement', async () => {
      await flushPersist(captures(200));
      const logBefore = __fakeSQLiteLog().length;
      await flushPersist([]);
      const statements = __fakeSQLiteLog().slice(logBefore);
      expect(statements).toEqual(['DELETE FROM scan_tray_rows WHERE owner_key = ?']);
      expect(await storedIds()).toEqual([]);
    });

    it('skips loading rows and rows with no normalized image', async () => {
      const loading = makeCapture({ id: 'loading', isLoadingCandidates: true });
      const imageless = makeCapture({ id: 'imageless', normalizedImageUri: null });
      const ready = makeCapture({ id: 'ready' });
      await flushPersist([loading, imageless, ready]);
      expect(await storedIds()).toEqual(['ready']);
    });

    it('a failed write rolls back entirely and is retried by the next write', async () => {
      const [a, b] = captures(2);
      let inserts = 0;
      // Fail on the SECOND row: the first row's insert must roll back with it.
      __setFakeSQLiteFault((sql) => sql.startsWith('INSERT INTO scan_tray_rows') && (inserts += 1) === 2);
      await flushPersist([a, b]);
      __setFakeSQLiteFault(null);
      expect(await storedIds()).toEqual([]);

      // Same rows, no change since: still written, because nothing was committed.
      await flushPersist([a, b]);
      expect(await storedIds()).toEqual([a.id, b.id]);
    });
  });

  describe('no cap', () => {
    it('persists and reloads 300 rows in order, none evicted', async () => {
      setRecentCapturesOwner('user-a');
      const rows = captures(300);
      await flushPersist(rows);
      const loaded = await hydrate('user-a');
      expect(loaded.items.map((item) => item.id)).toEqual(rows.map((row) => row.id));
    });

    it('keeps every candidate and the active pick, however deep', async () => {
      const paged = makeCapture({
        id: 'paged',
        candidates: makeCandidates(30),
        activeCandidateIndex: 25,
        totalCandidateCount: 42,
      });
      await flushPersist([paged]);
      const [loaded] = (await hydrate(null)).items;
      expect(loaded.candidates).toEqual(paged.candidates);
      expect(loaded.activeCandidateIndex).toBe(25);
      expect(loaded.totalCandidateCount).toBe(42);
    });

    it('clamps an active index that points past its own candidate array', async () => {
      await seedTrayRows(null, [{ ...makeCapture({ id: 'broken', candidates: makeCandidates(3) }), activeCandidateIndex: 9 }]);
      const [loaded] = (await hydrate(null)).items;
      expect(loaded.activeCandidateIndex).toBe(2);
    });
  });

  describe('load', () => {
    it('returns an empty tray when nothing is stored', async () => {
      const loaded = await hydrate('user-a');
      expect(loaded.items).toEqual([]);
      expect(loaded.priceSelections.size).toBe(0);
    });

    it('rebuilds session-only flags on restored rows', async () => {
      await flushPersist([makeCapture({ id: 'a', recentlyAdded: true, hasTrackedSelectionEvent: true })]);
      const [row] = (await hydrate(null)).items;
      expect(row).toEqual(expect.objectContaining({
        hasTrackedSelectionEvent: false,
        isLoadingCandidates: false,
        recentlyAdded: false,
        shownAtMs: null,
      }));
    });

    it('drops an undecodable row and deletes it on the next write', async () => {
      await flushPersist(captures(2));
      await trayDb.applyTrayChanges(null, [{
        id: 'corrupt',
        sortKey: 0.5,
        mode: 'raw',
        normalizedImageUri: null,
        sourceImageUri: null,
        binderPageId: null,
        activeCardId: null,
        activeCardName: null,
        captureJson: '{not json',
        priceSelectionJson: null,
      }], []);
      const loaded = await hydrate(null);
      expect(loaded.items.map((item) => item.id)).toEqual(['cap-0', 'cap-1']);

      await flushPersist([makeCapture({ id: 'new' }), ...loaded.items]);
      expect(await storedIds()).toEqual(['new', 'cap-0', 'cap-1']);
    });

    it('does not probe image files (that runs after paint)', async () => {
      await flushPersist(captures(20));
      (FileSystem.getInfoAsync as jest.Mock).mockClear();
      await hydrate(null);
      expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
    });

    it('the first write after a load rewrites nothing that is unchanged', async () => {
      setRecentCapturesOwner('user-a');
      await flushPersist(captures(10));
      const loaded = await hydrate('user-a');
      const before = upsertCount();
      await flushPersist(loaded.items);
      expect(upsertCount()).toBe(before);
    });
  });

  describe('account scoping', () => {
    it('never returns another owner\'s rows', async () => {
      await seedTrayRows('user-a', [makeCapture({ id: 'a-row' })]);
      await seedTrayRows('user-b', [makeCapture({ id: 'b-row' })]);
      const loaded = await hydrate('user-a');
      expect(loaded.items.map((item) => item.id)).toEqual(['a-row']);
    });

    it('an account switch clears the previous account\'s rows and choices', async () => {
      setRecentCapturesOwner('user-a');
      const kept = makeCapture({ id: 'kept' });
      await flushPersist([kept], new Map([['kept', {
        variantKey: 'normal',
        variantLabel: 'Normal',
        conditionCode: 'near_mint',
        conditionShortLabel: 'NM',
        marketPrice: 1,
      }]]));

      const asB = await hydrate('user-b');
      expect(asB.items).toHaveLength(0);
      expect(asB.priceSelections.size).toBe(0);
      // Gone, not hidden: switching back does not bring them back (today's policy).
      expect((await hydrate('user-a')).items).toHaveLength(0);
    });

    it('a signed-in account does not see the signed-out tray', async () => {
      setRecentCapturesOwner(null);
      await flushPersist([makeCapture({ id: 'guest-row' })]);
      expect((await hydrate('user-a')).items).toHaveLength(0);
    });

    it('a snapshot taken for one account is never written under another', async () => {
      setRecentCapturesOwner('user-a');
      schedulePersist([makeCapture({ id: 'a-row' })]);
      setRecentCapturesOwner('user-b');
      await settleDebouncedWrite();
      expect(await storedIds('user-b')).toEqual([]);
    });
  });

  describe('price selections', () => {
    const holofoilLP = {
      variantKey: 'holofoil',
      variantLabel: 'Holofoil',
      conditionCode: 'lightly_played' as const,
      conditionShortLabel: 'LP',
      marketPrice: 4.2,
    };

    it('round-trips with the rows; choices for rows not in the tray are not stored', async () => {
      setRecentCapturesOwner('user-a');
      schedulePersist([makeCapture({ id: 'kept' })], new Map([['kept', holofoilLP], ['gone', holofoilLP]]));
      await settleDebouncedWrite();

      const loaded = await hydrate('user-a');
      expect(loaded.items.map((item) => item.id)).toEqual(['kept']);
      expect(loaded.priceSelections.get('kept')).toEqual(holofoilLP);
      expect(loaded.priceSelections.has('gone')).toBe(false);
    });

    it('a rows-only write keeps the last known choices', async () => {
      const kept = makeCapture({ id: 'kept' });
      await flushPersist([kept], new Map([['kept', holofoilLP]]));
      await flushPersist([{ ...kept, matchReviewReason: 'edited' }]);
      expect((await readTrayRows(null))[0].priceSelection).toEqual(holofoilLP);
    });
  });

  describe('scheduling', () => {
    it('debounces writes into one transaction', async () => {
      const writes = jest.spyOn(trayDb, 'applyTrayChanges');
      const [a, b] = captures(2);
      schedulePersist([a]);
      schedulePersist([a, b]);
      expect(writes).not.toHaveBeenCalled();
      await settleDebouncedWrite();
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await storedIds()).toEqual([a.id, b.id]);
    });

    it('restarts the timer on every schedule during a burst', async () => {
      const writes = jest.spyOn(trayDb, 'applyTrayChanges');
      const [a, b] = captures(2);
      schedulePersist([a]);
      jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS - 100);
      schedulePersist([a, b]);
      jest.advanceTimersByTime(200);
      jest.advanceTimersByTime(1);
      await drain();
      expect(writes).not.toHaveBeenCalled();

      await settleDebouncedWrite();
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await storedIds()).toEqual([a.id, b.id]);
    });

    it('writes at the max-wait even if the burst never pauses', async () => {
      const writes = jest.spyOn(trayDb, 'applyTrayChanges');
      const rows: RecentCapture[] = [];
      for (let elapsed = 0; elapsed < PERSIST_MAX_WAIT_MS; elapsed += 1000) {
        rows.push(makeCapture({ id: `p${elapsed}` }));
        schedulePersist([...rows]);
        jest.advanceTimersByTime(1000);
        jest.advanceTimersByTime(1);
        await drain();
      }
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await storedIds()).toEqual(rows.map((row) => row.id));
    });

    it('writes the latest tray, including changes made while waiting for idle', async () => {
      const [a, b] = captures(2);
      schedulePersist([a]);
      jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
      schedulePersist([a, b]);
      jest.advanceTimersByTime(1);
      await drain();
      expect(await storedIds()).toEqual([a.id, b.id]);
    });

    it('flushes the pending tray when the app leaves the foreground', async () => {
      const writes = jest.spyOn(trayDb, 'applyTrayChanges');
      schedulePersist([makeCapture({ id: 'a' })]);
      const listener = (AppState.addEventListener as jest.Mock).mock.calls.at(-1)?.[1] as
        | ((state: string) => void)
        | undefined;
      expect(listener).toBeDefined();
      listener!('background');
      await drain();
      expect(await storedIds()).toEqual(['a']);

      await settleDebouncedWrite();
      expect(writes).toHaveBeenCalledTimes(1);
    });

    it('argument-less flushPersist does NOT clobber a settled tray (unmount on nav)', async () => {
      schedulePersist([makeCapture({ id: 'a' })]);
      await settleDebouncedWrite();
      await flushPersist();
      expect(await storedIds()).toEqual(['a']);
    });
  });

  describe('write collisions', () => {
    function gateFirstWrite() {
      const real = trayDb.applyTrayChanges;
      let release: (() => void) | null = null;
      const spy = jest.spyOn(trayDb, 'applyTrayChanges').mockImplementationOnce(
        (...args) => new Promise<boolean>((resolve) => {
          release = () => {
            void real(...args).then(resolve);
          };
        }),
      );
      return { spy, release: () => release!() };
    }

    it('does not lose a write that collides with an in-flight write', async () => {
      const [first, second] = captures(2);
      const gate = gateFirstWrite();
      const firstWrite = flushPersist([first]);
      await drain();
      const secondWrite = flushPersist([first, second]);
      gate.release();
      await Promise.all([firstWrite, secondWrite]);
      expect(await storedIds()).toEqual([first.id, second.id]);
      expect(gate.spy).toHaveBeenCalledTimes(2);
    });

    it('coalesces multiple collisions into one trailing write of the newest tray', async () => {
      const [a, b, c] = captures(3);
      const gate = gateFirstWrite();
      const firstWrite = flushPersist([a]);
      await drain();
      const collision1 = flushPersist([a, b]);
      const collision2 = flushPersist([a, b, c]);
      gate.release();
      await Promise.all([firstWrite, collision1, collision2]);
      expect(await storedIds()).toEqual([a.id, b.id, c.id]);
      expect(gate.spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('assignSortKeys', () => {
    const keysFor = (ids: string[], stored: Record<string, number>) => assignSortKeys(ids, (id) => stored[id]);

    it('numbers a fresh tray top-down', () => {
      expect(keysFor(['a', 'b', 'c'], {})).toEqual([3, 2, 1]);
    });

    it('places new rows above, between and below stored ones without moving them', () => {
      const keys = keysFor(['top', 'x', 'mid', 'y', 'bottom'], { x: 10, y: 4 });
      expect(keys[1]).toBe(10);
      expect(keys[3]).toBe(4);
      expect(keys[0]).toBeGreaterThan(10);
      expect(keys[2]).toBeGreaterThan(4);
      expect(keys[2]).toBeLessThan(10);
      expect(keys[4]).toBeLessThan(4);
    });

    it('renumbers when stored keys are out of order or a gap is exhausted', () => {
      expect(keysFor(['a', 'b'], { a: 1, b: 2 })).toEqual([2, 1]);
      expect(keysFor(['a', 'new', 'b'], { a: 1 + 1e-9, b: 1 })).toEqual([3, 2, 1]);
    });
  });

  describe('image files', () => {
    it('copyToScansDir copies into the scans dir, -src suffix for raw sources', async () => {
      mockedFs.__seedFile('file:///cache/tmp.jpg', 4096);
      expect(await copyToScansDir('file:///cache/tmp.jpg', 'cap-99')).toBe(`${RECENT_CAPTURES_DIR}cap-99.jpg`);
      expect(await copyToScansDir('file:///cache/tmp.jpg', 'cap-4', 'raw', 'slabs')).toBe(`${RECENT_CAPTURES_DIR}cap-4-src.jpg`);
    });

    it('copyToScansDir passes through already-durable uris and returns null on failure', async () => {
      const durable = `${RECENT_CAPTURES_DIR}cap-2.jpg`;
      expect(await copyToScansDir(durable, 'cap-2')).toBe(durable);
      expect(FileSystem.copyAsync).not.toHaveBeenCalled();
      (FileSystem.copyAsync as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      expect(await copyToScansDir('file:///cache/tmp.jpg', 'cap-3')).toBeNull();
    });

    it('deleteScanFile only touches the scans dir', async () => {
      const uri = `${RECENT_CAPTURES_DIR}cap-x.jpg`;
      mockedFs.__seedFile(uri);
      await deleteScanFile(uri, 'swipe');
      expect(mockedFs.__getFiles().has(uri)).toBe(false);
      await deleteScanFile('file:///cache/random.jpg', 'swipe');
      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    });

    it('ensureScansDir makes the directory once', async () => {
      await ensureScansDir();
      await ensureScansDir();
      expect((FileSystem.makeDirectoryAsync as jest.Mock).mock.calls).toEqual([
        [RECENT_CAPTURES_DIR, { intermediates: true }],
      ]);
    });

    it('findCapturesWithMissingImages reports rows whose image is gone, with bounded probes', async () => {
      const rows = captures(60);
      rows.slice(1).forEach((row) => mockedFs.__seedFile(row.normalizedImageUri!));
      const getInfo = FileSystem.getInfoAsync as jest.Mock;
      const realGetInfo = getInfo.getMockImplementation()!;
      let inFlight = 0;
      let peak = 0;
      getInfo.mockImplementation(async (uri: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return realGetInfo(uri);
      });
      expect([...await findCapturesWithMissingImages(rows)]).toEqual(['cap-0']);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(FS_CONCURRENCY_LIMIT);
    });

    it('sweepOrphanScans keeps files of stored rows and live rows, deletes the rest', async () => {
      setRecentCapturesOwner('user-a');
      await flushPersist([makeCapture({ id: 'stored' })]);
      ['stored', 'stored-src', 'live', 'orphan', 'orphan-src'].forEach((name) => {
        mockedFs.__seedFile(`${RECENT_CAPTURES_DIR}${name}.jpg`);
      });
      await sweepOrphanScans(new Set(['live']));
      expect([...mockedFs.__getFiles().keys()].sort()).toEqual([
        `${RECENT_CAPTURES_DIR}live.jpg`,
        `${RECENT_CAPTURES_DIR}stored-src.jpg`,
        `${RECENT_CAPTURES_DIR}stored.jpg`,
      ]);
    });

    it('sweepOrphanScans lands a pending write before deciding what is orphaned', async () => {
      schedulePersist([makeCapture({ id: 'fresh' })]);
      mockedFs.__seedFile(`${RECENT_CAPTURES_DIR}fresh.jpg`);
      await sweepOrphanScans();
      expect(mockedFs.__getFiles().has(`${RECENT_CAPTURES_DIR}fresh.jpg`)).toBe(true);
    });

    it('sweepOrphanScans deletes nothing without a DB', async () => {
      jest.spyOn(trayDb, 'listOwnerTrayRowIds').mockResolvedValueOnce(null);
      mockedFs.__seedFile(`${RECENT_CAPTURES_DIR}unknown.jpg`);
      await sweepOrphanScans();
      expect(mockedFs.__getFiles().size).toBe(1);
    });

    it('bounds concurrent deletes during the orphan sweep', async () => {
      for (let index = 0; index < 60; index += 1) {
        mockedFs.__seedFile(`${RECENT_CAPTURES_DIR}orphan-${index}.jpg`);
      }
      const deleteAsync = FileSystem.deleteAsync as jest.Mock;
      const realDelete = deleteAsync.getMockImplementation()!;
      let inFlight = 0;
      let peak = 0;
      deleteAsync.mockImplementation(async (uri: string, options?: unknown) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return realDelete(uri, options);
      });
      await sweepOrphanScans();
      expect(mockedFs.__getFiles().size).toBe(0);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(FS_CONCURRENCY_LIMIT);
    });
  });
});
