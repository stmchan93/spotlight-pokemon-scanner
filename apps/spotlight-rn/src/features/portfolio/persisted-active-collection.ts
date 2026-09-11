import AsyncStorage from '@react-native-async-storage/async-storage';

// Which collection the Collection tab was last showing, so a relaunch returns to
// it instead of silently snapping back to the default. The server stays the
// source of truth for which collections EXIST — this only remembers a choice.
const ACTIVE_COLLECTION_STORAGE_KEY = '@spotlight/portfolio/active-collection';

type PersistedActiveCollectionEnvelope = {
  collectionID?: string;
  /** Supabase user id (or 'signed-out') of the account this choice belongs to. */
  ownerKey?: string;
};

/**
 * Read the persisted active collection ONLY if it belongs to `ownerKey`.
 *
 * SECURITY BOUNDARY: a value saved for another account (or a legacy one saved
 * before owner-stamping) is never returned. A leaked collection id is not just
 * a wrong default — it would be sent as the scope of the next holdings read and
 * as the target of the next add.
 *
 * NOT RETURNING IT IS THE WHOLE BOUNDARY; DELETING IT WAS A BUG. A mismatch
 * used to also erase the row, and the first read of every cold start is a
 * mismatch: Supabase has not restored the session yet, so the owner key is
 * still the "signed-out" placeholder. So the launch that was supposed to
 * restore your choice destroyed it instead, and the account landed back on its
 * default collection every single time (user, 2026-09-11). The read re-runs
 * under the real owner key once the session lands, which is what actually
 * restores it — and it can only do that if the row survived.
 */
export async function readPersistedActiveCollection(ownerKey: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_COLLECTION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedActiveCollectionEnvelope;
    if (parsed?.ownerKey !== ownerKey) {
      return null;
    }
    return parsed.collectionID?.trim() || null;
  } catch {
    // Corrupt cache — fall back to the owner's default collection.
    return null;
  }
}

export function persistActiveCollection(collectionID: string, ownerKey: string): void {
  void AsyncStorage.setItem(
    ACTIVE_COLLECTION_STORAGE_KEY,
    JSON.stringify({ collectionID, ownerKey } satisfies PersistedActiveCollectionEnvelope),
  ).catch(() => {
    // Best-effort: the in-memory choice still holds for this session.
  });
}
