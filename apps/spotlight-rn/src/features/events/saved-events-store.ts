import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useAppServices } from '@/providers/app-providers';

/*
  Hearted events, on device. Its own list (not the card Wishlist). The storage
  key carries the session owner so one account's saves never paint for another
  (see `sessionOwnerKey`). A module-level store keeps the list and detail
  hearts in sync without a provider.
*/
const STORAGE_KEY_PREFIX = '@spotlight/events/saved/';

type Snapshot = { ownerKey: string | null; ids: ReadonlySet<string> };

let snapshot: Snapshot = { ownerKey: null, ids: new Set() };
const listeners = new Set<() => void>();

function emit(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

export async function loadSavedEvents(ownerKey: string): Promise<void> {
  if (snapshot.ownerKey === ownerKey) {
    return;
  }
  // Drop the previous owner's ids immediately; never show them under this one.
  const pending: Snapshot = { ownerKey, ids: new Set() };
  emit(pending);
  try {
    const raw = await AsyncStorage.getItem(`${STORAGE_KEY_PREFIX}${ownerKey}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (snapshot.ownerKey !== ownerKey) {
      return;
    }
    const ids = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
    if (snapshot === pending) {
      emit({ ownerKey, ids });
      return;
    }
    // A heart was tapped while storage was read: keep it alongside what was stored.
    snapshot.ids.forEach((id) => ids.add(id));
    emit({ ownerKey, ids });
    void AsyncStorage.setItem(`${STORAGE_KEY_PREFIX}${ownerKey}`, JSON.stringify([...ids])).catch(() => undefined);
  } catch {
    // Corrupt or unreadable — start empty.
  }
}

export function toggleSavedEvent(ownerKey: string, eventId: string): void {
  if (snapshot.ownerKey !== ownerKey) {
    return;
  }
  const ids = new Set(snapshot.ids);
  if (ids.has(eventId)) {
    ids.delete(eventId);
  } else {
    ids.add(eventId);
  }
  emit({ ownerKey, ids });
  void AsyncStorage.setItem(`${STORAGE_KEY_PREFIX}${ownerKey}`, JSON.stringify([...ids])).catch(() => {
    // Best effort: the in-memory list still holds for this session.
  });
}

export function resetSavedEventsForTests(): void {
  snapshot = { ownerKey: null, ids: new Set() };
}

export function useSavedEvents() {
  const { sessionOwnerKey } = useAppServices();
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void loadSavedEvents(sessionOwnerKey);
  }, [sessionOwnerKey]);

  const ids = current.ownerKey === sessionOwnerKey ? current.ids : EMPTY;
  const isSaved = useCallback((eventId: string) => ids.has(eventId), [ids]);
  const toggle = useCallback(
    (eventId: string) => toggleSavedEvent(sessionOwnerKey, eventId),
    [sessionOwnerKey],
  );
  return { savedIds: ids, isSaved, toggle };
}

const EMPTY: ReadonlySet<string> = new Set();
