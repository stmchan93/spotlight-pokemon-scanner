import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  persistActiveCollection,
  readPersistedActiveCollection,
} from '@/features/portfolio/persisted-active-collection';

// In-memory AsyncStorage stand-in. State lives inside the factory so it is
// initialized when the hoisted mock first runs.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      __clear: () => store.clear(),
    },
  };
});

const storage = AsyncStorage as unknown as {
  removeItem: jest.Mock;
  __clear: () => void;
};

const OWNER = '11111111-2222-3333-4444-555555555555';
const OTHER_OWNER = '99999999-8888-7777-6666-555555555555';
/** What `resolveSessionOwnerKey` reports before Supabase restores the session. */
const SIGNED_OUT = 'signed-out';

/**
 * Reopening the app must land on the collection you were last looking at.
 *
 * The persistence was all here and still the choice was lost on every cold
 * start (user, 2026-09-11). The read discarded a row belonging to a different
 * owner AND deleted it — and the first read of every launch looks exactly like
 * a different owner, because Supabase has not restored the session yet and the
 * key is still the signed-out placeholder. The launch meant to restore the
 * choice was the thing destroying it.
 */
describe('persisted active collection', () => {
  beforeEach(() => {
    storage.__clear();
    storage.removeItem.mockClear();
  });

  it('survives the signed-out read that happens before the session restores', async () => {
    persistActiveCollection('collection-vintage', OWNER);

    // The launch read, before auth has settled: must not answer...
    await expect(readPersistedActiveCollection(SIGNED_OUT)).resolves.toBeNull();
    // ...and must not destroy the row, which is what the re-read depends on.
    expect(storage.removeItem).not.toHaveBeenCalled();

    // The effect re-runs under the real owner key once the session lands.
    await expect(readPersistedActiveCollection(OWNER)).resolves.toBe('collection-vintage');
  });

  it('never hands one account another account\'s collection', async () => {
    persistActiveCollection('collection-vintage', OWNER);

    // Not just a wrong default: this id scopes the next holdings read and is
    // the target of the next add.
    await expect(readPersistedActiveCollection(OTHER_OWNER)).resolves.toBeNull();
  });

  it('returns the choice for the owner that saved it', async () => {
    persistActiveCollection('collection-slabs', OWNER);
    await expect(readPersistedActiveCollection(OWNER)).resolves.toBe('collection-slabs');
  });

  it('treats an overwrite as the new answer', async () => {
    persistActiveCollection('collection-vintage', OWNER);
    persistActiveCollection('collection-slabs', OWNER);
    await expect(readPersistedActiveCollection(OWNER)).resolves.toBe('collection-slabs');
  });

  it('answers null on an empty or corrupt store rather than throwing', async () => {
    await expect(readPersistedActiveCollection(OWNER)).resolves.toBeNull();
  });
});
