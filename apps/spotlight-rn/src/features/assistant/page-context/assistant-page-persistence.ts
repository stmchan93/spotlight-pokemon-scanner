import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Two small device-local memories for the floating bubble.
 *
 * 1. WHICH PAGE EACH CHAT WAS STARTED FROM (thread id → page key), owner-scoped
 *    (sessionOwnerKey rule: a value saved under another account is never read).
 *    The bubble continues the latest chat only when it was opened from the same
 *    page; any other page starts a new chat, so "is this a good buy?" on a card
 *    page never lands in yesterday's collection thread.
 * 2. WHERE THE BUBBLE SITS (edge + y), per device, not per account.
 */

const THREAD_PAGES_KEY = '@spotlight/assistant/thread-pages';
const BUBBLE_POSITION_KEY = '@spotlight/assistant/bubble-position';
const MAX_THREAD_PAGES = 50;

type ThreadPagesEnvelope = { ownerKey?: string; pages?: [string, string][] };

let threadPages: { ownerKey: string; pages: Map<string, string> } | null = null;

async function loadThreadPages(ownerKey: string): Promise<Map<string, string>> {
  if (threadPages?.ownerKey === ownerKey) {
    return threadPages.pages;
  }
  let pages = new Map<string, string>();
  try {
    const raw = await AsyncStorage.getItem(THREAD_PAGES_KEY);
    const parsed = raw ? (JSON.parse(raw) as ThreadPagesEnvelope) : null;
    if (parsed?.ownerKey === ownerKey && Array.isArray(parsed.pages)) {
      pages = new Map(parsed.pages.filter((entry) => Array.isArray(entry) && entry.length === 2));
    }
  } catch {
    // Corrupt: start empty (worst case a new chat instead of a continued one).
  }
  threadPages = { ownerKey, pages };
  return pages;
}

export async function readThreadPageKey(ownerKey: string, threadId: string): Promise<string | null> {
  return (await loadThreadPages(ownerKey)).get(threadId) ?? null;
}

export async function rememberThreadPageKey(ownerKey: string, threadId: string, pageKey: string): Promise<void> {
  const pages = await loadThreadPages(ownerKey);
  pages.delete(threadId);
  pages.set(threadId, pageKey);
  while (pages.size > MAX_THREAD_PAGES) {
    const oldest = pages.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    pages.delete(oldest);
  }
  await AsyncStorage.setItem(
    THREAD_PAGES_KEY,
    JSON.stringify({ ownerKey, pages: Array.from(pages.entries()) } satisfies ThreadPagesEnvelope),
  ).catch(() => {
    // Best-effort; the in-memory map still holds for this session.
  });
}

/** Test seam. */
export function resetAssistantPagePersistence(): void {
  threadPages = null;
}

export type AssistantBubblePosition = { side: 'left' | 'right'; y: number | null };

export const DEFAULT_BUBBLE_POSITION: AssistantBubblePosition = { side: 'right', y: null };

export async function readBubblePosition(): Promise<AssistantBubblePosition> {
  try {
    const raw = await AsyncStorage.getItem(BUBBLE_POSITION_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AssistantBubblePosition>) : null;
    if (parsed && (parsed.side === 'left' || parsed.side === 'right')) {
      return { side: parsed.side, y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null };
    }
  } catch {
    // Fall through to the default corner.
  }
  return DEFAULT_BUBBLE_POSITION;
}

export function persistBubblePosition(position: AssistantBubblePosition): void {
  void AsyncStorage.setItem(BUBBLE_POSITION_KEY, JSON.stringify(position)).catch(() => {});
}
