/*
  ─────────────────────────────────────────────────────────────────────────────
  "ADDED TO YOUR COLLECTION", HANDED BACK TO THE SCREEN YOU RETURNED TO
  ─────────────────────────────────────────────────────────────────────────────
  Adding a card from catalog search now pops ONLY the card page, so you land back
  on your results and can add the next one. That is the right flow, but it costs
  the confirmation the old flow got for free: it used to dump you on your
  Collection, where the card was visibly sitting at the top.

  A toast replaces that confirmation, and it cannot be shown by the screen that
  did the work — the card page is unmounting on the very next tick. It also
  cannot come from a root-level toast host, because catalog search presents as a
  `fullScreenModal`: on iOS that is a separate view controller, so anything
  rendered at the app root draws BEHIND it.

  So the message is left here and picked up by whichever screen comes back into
  focus, which is the same module-level handoff `card-detail-preview-session`
  already uses for exactly this kind of "I am about to unmount, take this" pass.

  WHY THE NOTICE EXPIRES. Nothing guarantees anyone consumes it — you might add a
  card from your Collection, where no screen is listening. Without a deadline the
  message would sit here and then appear, stale and confusing, the next time
  search happened to open. The window is generous enough to survive a screen
  transition and far too short to survive a trip somewhere else.
*/

const NOTICE_TTL_MS = 6_000;

type CardAddedNotice = {
  at: number;
  message: string;
};

let pending: CardAddedNotice | null = null;

/**
 * Leave a confirmation for the screen being returned to. Overwrites any unread
 * notice: only the most recent add is worth announcing.
 */
export function noteCardAdded(message: string, now: number = Date.now()) {
  pending = { at: now, message };
}

/**
 * Take the pending confirmation, if there is a fresh one. Always clears, so a
 * message is shown at most once even when it has expired.
 */
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
