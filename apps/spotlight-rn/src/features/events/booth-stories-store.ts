import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { BoothClaim, BoothPost } from '@/features/events/booth-service';
import { useAppServices } from '@/providers/app-providers';

/*
  Booth stories, on device: which booth posts this account has watched (rings
  go gray), plus the hand-off between the show page and the story viewer. Seen
  ids are keyed by session owner so one account's views never gray out rings
  for another (see `sessionOwnerKey`). No server state.
*/
const STORAGE_KEY_PREFIX = '@spotlight/events/story-seen/';
/** Posts older than a day stop being stories, so a short tail is plenty. */
const MAX_STORED_IDS = 500;

type SeenSnapshot = { ownerKey: string | null; loaded: boolean; ids: ReadonlySet<string> };

let seen: SeenSnapshot = { ownerKey: null, loaded: false, ids: new Set() };
const seenListeners = new Set<() => void>();

function emitSeen(next: SeenSnapshot) {
  seen = next;
  seenListeners.forEach((listener) => listener());
}

function subscribeSeen(listener: () => void) {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}

function getSeen() {
  return seen;
}

function persistSeen(ownerKey: string, ids: ReadonlySet<string>) {
  const tail = [...ids].slice(-MAX_STORED_IDS);
  void AsyncStorage.setItem(`${STORAGE_KEY_PREFIX}${ownerKey}`, JSON.stringify(tail)).catch(() => undefined);
}

export async function loadSeenBoothPosts(ownerKey: string): Promise<void> {
  if (seen.ownerKey === ownerKey) {
    return;
  }
  const pending: SeenSnapshot = { ownerKey, loaded: false, ids: new Set() };
  emitSeen(pending);
  let stored: string[] = [];
  try {
    const raw = await AsyncStorage.getItem(`${STORAGE_KEY_PREFIX}${ownerKey}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    stored = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // Corrupt or unreadable: everything reads as unseen.
  }
  if (seen.ownerKey !== ownerKey) {
    return;
  }
  // Keep anything marked while storage was read.
  const ids = new Set([...stored, ...seen.ids]);
  emitSeen({ ownerKey, loaded: true, ids });
  if (seen !== pending && ids.size > stored.length) {
    persistSeen(ownerKey, ids);
  }
}

export function markBoothPostSeen(ownerKey: string, postId: string): void {
  if (seen.ownerKey !== ownerKey || seen.ids.has(postId)) {
    return;
  }
  const ids = new Set(seen.ids);
  ids.add(postId);
  emitSeen({ ...seen, ids });
  // Mid-load, the merge in `loadSeenBoothPosts` writes it; writing now would drop the stored ids.
  if (seen.loaded) {
    persistSeen(ownerKey, ids);
  }
}

export function useSeenBoothPosts() {
  const { sessionOwnerKey } = useAppServices();
  const current = useSyncExternalStore(subscribeSeen, getSeen, getSeen);

  useEffect(() => {
    void loadSeenBoothPosts(sessionOwnerKey);
  }, [sessionOwnerKey]);

  const mine = current.ownerKey === sessionOwnerKey;
  const markSeen = useCallback((postId: string) => markBoothPostSeen(sessionOwnerKey, postId), [sessionOwnerKey]);
  return { seenPostIds: mine ? current.ids : EMPTY, ready: mine && current.loaded, markSeen };
}

const EMPTY: ReadonlySet<string> = new Set();

/*
  Hand-off. The show page publishes the booth posts and claims it already has,
  so the viewer opens without a refetch; "View booth" asks the page to select a
  vendor when the viewer closes.
*/
export type BoothStoriesSource = { posts: readonly BoothPost[]; claims: ReadonlyMap<string, BoothClaim> };

const sources = new Map<string, BoothStoriesSource>();

export function publishBoothStoriesSource(eventId: string, source: BoothStoriesSource): void {
  sources.set(eventId, source);
}

export function readBoothStoriesSource(eventId: string): BoothStoriesSource | null {
  return sources.get(eventId) ?? null;
}

type SelectListener = (eventId: string, vendorId: string) => void;
const selectListeners = new Set<SelectListener>();

export function requestBoothVendorSelect(eventId: string, vendorId: string): void {
  selectListeners.forEach((listener) => listener(eventId, vendorId));
}

export function subscribeBoothVendorSelect(listener: SelectListener): () => void {
  selectListeners.add(listener);
  return () => {
    selectListeners.delete(listener);
  };
}

export function resetBoothStoriesForTests(): void {
  seen = { ownerKey: null, loaded: false, ids: new Set() };
  sources.clear();
  selectListeners.clear();
}
