import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  LEGACY_TRAY_ENVELOPE_VERSION,
  LEGACY_TRAY_STORAGE_KEY,
  migrateLegacyTrayBlob,
} from '@/features/scanner/legacy-tray-migration';
import {
  __resetRecentCapturesPersistenceForTests,
  loadPersistedTraySnapshot,
  setRecentCapturesOwner,
} from '@/features/scanner/recent-captures-persistence';
import * as trayDb from '@/features/scanner/tray-db';

import { __fakeSQLiteLog, __setFakeSQLiteFault } from '../../../test-support/fake-expo-sqlite';
import { readTrayRows } from '../../../test-support/scan-tray-db';

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

const holofoilLP = {
  variantKey: 'holofoil',
  variantLabel: 'Holofoil',
  conditionCode: 'lightly_played',
  conditionShortLabel: 'LP',
  marketPrice: 4.2,
};

function legacyRow(id: string, candidateCount = 3) {
  return {
    id,
    scanID: `scan-${id}`,
    mode: 'raw',
    uri: `file:///document/scans/${id}-src.jpg`,
    normalizedImageUri: `file:///document/scans/${id}.jpg`,
    candidates: Array.from({ length: candidateCount }, (_unused, index) => ({
      id: `cand-${index}`,
      cardId: `card-${index}`,
      name: `Card ${index}`,
      cardNumber: `${index}`,
      setName: 'Test Set',
      imageUrl: `https://example.test/${index}.png`,
    })),
    activeCandidateIndex: 0,
    totalCandidateCount: candidateCount,
    matchReviewDisposition: null,
    matchReviewReason: null,
    slabContext: null,
    normalizedImageDimensions: null,
    sourceImageCrop: null,
    sourceImageDimensions: null,
    sourceImageRotationDegrees: 0,
  };
}

async function seedBlob(envelope: Record<string, unknown>) {
  await AsyncStorage.setItem(LEGACY_TRAY_STORAGE_KEY, JSON.stringify({
    version: LEGACY_TRAY_ENVELOPE_VERSION,
    ...envelope,
  }));
}

const blob = () => AsyncStorage.getItem(LEGACY_TRAY_STORAGE_KEY);

describe('legacy AsyncStorage tray -> tray DB', () => {
  beforeEach(async () => {
    __resetRecentCapturesPersistenceForTests();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('imports the owner\'s rows in order with their choices and ALL candidates, then deletes the blob', async () => {
    await seedBlob({
      ownerKey: 'user-a',
      items: [legacyRow('newest', 30), legacyRow('middle'), legacyRow('oldest')],
      priceSelections: { middle: holofoilLP, stale: holofoilLP },
    });

    expect(await migrateLegacyTrayBlob('user-a')).toBe('migrated');
    const rows = await readTrayRows('user-a');
    expect(rows.map((row) => row.id)).toEqual(['newest', 'middle', 'oldest']);
    expect(rows[0].capture.candidates).toHaveLength(30);
    expect(rows[1].priceSelection).toEqual(holofoilLP);
    expect(await blob()).toBeNull();
  });

  it('imports all rows in one transaction', async () => {
    await readTrayRows(null); // open the DB first so its schema transaction isn't counted
    const before = __fakeSQLiteLog().filter((sql) => sql === 'BEGIN').length;
    await seedBlob({ ownerKey: 'user-a', items: Array.from({ length: 400 }, (_unused, index) => legacyRow(`r${index}`)) });
    await migrateLegacyTrayBlob('user-a');
    expect(__fakeSQLiteLog().filter((sql) => sql === 'BEGIN').length).toBe(before + 1);
    expect(await readTrayRows('user-a')).toHaveLength(400);
  });

  it('adopts an unstamped (pre-owner) blob for the current account', async () => {
    await seedBlob({ items: [legacyRow('legacy')] });
    expect(await migrateLegacyTrayBlob('user-a')).toBe('migrated');
    expect((await readTrayRows('user-a')).map((row) => row.id)).toEqual(['legacy']);
  });

  it('drops a blob stamped for another account without importing it', async () => {
    await seedBlob({ ownerKey: 'user-b', items: [legacyRow('b-row')] });
    expect(await migrateLegacyTrayBlob('user-a')).toBe('discarded');
    expect(await readTrayRows('user-a')).toEqual([]);
    expect(await blob()).toBeNull();
  });

  it('drops a signed-out blob when a signed-in account loads', async () => {
    await seedBlob({ ownerKey: null, items: [legacyRow('guest')] });
    expect(await migrateLegacyTrayBlob('user-a')).toBe('discarded');
  });

  it('drops corrupt JSON and unknown envelope versions', async () => {
    await AsyncStorage.setItem(LEGACY_TRAY_STORAGE_KEY, '{not valid json');
    expect(await migrateLegacyTrayBlob('user-a')).toBe('discarded');
    await seedBlob({ version: 999, items: [legacyRow('x')] });
    expect(await migrateLegacyTrayBlob('user-a')).toBe('discarded');
    expect(await blob()).toBeNull();
  });

  it('keeps the blob when the import fails, and imports on the next run', async () => {
    await seedBlob({ ownerKey: 'user-a', items: [legacyRow('a'), legacyRow('b')] });
    let inserts = 0;
    __setFakeSQLiteFault((sql) => sql.startsWith('INSERT INTO scan_tray_rows') && (inserts += 1) === 2);
    expect(await migrateLegacyTrayBlob('user-a')).toBe('pending');
    __setFakeSQLiteFault(null);
    expect(await readTrayRows('user-a')).toEqual([]);
    expect(await blob()).not.toBeNull();

    expect(await migrateLegacyTrayBlob('user-a')).toBe('migrated');
    expect((await readTrayRows('user-a')).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('a re-run after a kill between commit and blob delete imports nothing twice', async () => {
    await seedBlob({ ownerKey: 'user-a', items: [legacyRow('a'), legacyRow('b')] });
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('killed'));
    await migrateLegacyTrayBlob('user-a');
    expect(await blob()).not.toBeNull();

    // The user swiped 'a' away in that session.
    await trayDb.applyTrayChanges('user-a', [], ['a']);

    expect(await migrateLegacyTrayBlob('user-a')).toBe('migrated');
    expect((await readTrayRows('user-a')).map((row) => row.id)).toEqual(['b']);
    expect(await blob()).toBeNull();
  });

  it('keeps the blob when this binary has no DB', async () => {
    await seedBlob({ ownerKey: 'user-a', items: [legacyRow('a')] });
    jest.spyOn(trayDb, 'importLegacyTrayRows').mockResolvedValueOnce(null);
    expect(await migrateLegacyTrayBlob('user-a')).toBe('pending');
    expect(await blob()).not.toBeNull();
  });

  it('runs as part of the first tray load', async () => {
    await seedBlob({
      ownerKey: 'user-a',
      items: [legacyRow('a'), legacyRow('b')],
      priceSelections: { b: holofoilLP },
    });
    setRecentCapturesOwner('user-a');
    const loaded = await loadPersistedTraySnapshot();
    expect(loaded.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(loaded.priceSelections.get('b')).toEqual(holofoilLP);
    expect(await blob()).toBeNull();
  });
});
