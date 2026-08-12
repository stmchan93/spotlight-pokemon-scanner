/*
  "Added to your collection", left for whichever screen the card page popped back
  to — it cannot show its own toast while unmounting, and a root-level host would
  draw behind catalog search's `fullScreenModal` on iOS.

  Expires because nothing guarantees a reader: add from the Collection and no
  screen is listening, and a message with no deadline resurfaces stale later.
*/

const NOTICE_TTL_MS = 6_000;

type CardAddedNotice = {
  at: number;
  message: string;
};

let pending: CardAddedNotice | null = null;

/** Overwrites any unread notice — only the most recent add is worth announcing. */
export function noteCardAdded(message: string, now: number = Date.now()) {
  pending = { at: now, message };
}

/** Always clears, so a message shows at most once even when it has expired. */
export function consumeCardAddedNotice(now: number = Date.now()): string | null {
  const notice = pending;
  pending = null;
  if (!notice || now - notice.at > NOTICE_TTL_MS) {
    return null;
  }
  return notice.message;
}

/** Test seam — drops anything unread without reading it. */
export function clearCardAddedNotice() {
  pending = null;
}
