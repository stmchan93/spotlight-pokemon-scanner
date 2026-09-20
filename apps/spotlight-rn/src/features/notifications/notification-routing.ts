/**
 * Parsing for the `data` payload the backend attaches to a push.
 *
 * Pure and defensive on purpose: this is the one place where a REMOTE string
 * turns into navigation. Everything is validated here so the tap handler never
 * has to think about it.
 */

/** Where an untargeted/unroutable deal push lands. */
export const DEAL_NOTIFICATION_FALLBACK_URL = '/wishlist';

export type NotificationRoute = {
  /** An in-app absolute path, always safe to hand to the router. */
  url: string;
  /** The deal-alert id to stamp as tapped, when the push carried one. */
  alertId: string | null;
  cardId: string | null;
};

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * An in-app path, or null.
 *
 * The push payload is attacker-shaped input in the general case, so the only
 * accepted form is a single-slash absolute path: no scheme (`https:`,
 * `javascript:`), no protocol-relative `//host` — both of which `router.push`
 * would happily treat as somewhere else entirely.
 */
export function normalizeNotificationUrl(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) {
    return null;
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return null;
  }
  return raw;
}

/**
 * Turn a notification's `data` bag into something routable.
 *
 * Returns a route even when the payload is junk — a tap must always go
 * SOMEWHERE, and `/wishlist` is where a deal lives. Returns null only when
 * there is no data object at all (i.e. nothing was tapped).
 */
export function parseNotificationRoute(data: unknown): NotificationRoute | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  return {
    alertId: readString(record.alertId),
    cardId: readString(record.cardId),
    url: normalizeNotificationUrl(record.url) ?? DEAL_NOTIFICATION_FALLBACK_URL,
  };
}
