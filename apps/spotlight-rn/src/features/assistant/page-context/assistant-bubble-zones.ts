/**
 * Where the floating Ekalight bubble may sit, per route. Pure functions of the
 * pathname + window metrics so they are unit-tested without a renderer.
 */

/** Routes the bubble never shows on: the chat itself, auth, forms, full-screen capture. */
const HIDDEN_PREFIXES = [
  '/assistant',
  '/login',
  '/login-callback',
  '/account',
  '/change-password',
  '/feedback',
  '/new-post',
  '/booth-stories',
  '/messages',
  '/edit-profile',
  '/labeling',
  '/whos-that-pokemon',
] as const;

// Every bottom tab (HOME · SEARCH · SCAN · EVENTS · SOCIAL) plus the profile tabs.
const TAB_ROUTES = new Set(['/', '/search', '/wishlist', '/scan', '/events', '/social', '/portfolio', '/you']);

/** The dev scanner screenshot routes lay out exactly like `/scan`. */
export function bubbleRoutePath(pathname: string): string {
  return /^\/dev\/scanner(-binder)?$/.test(pathname) ? '/scan' : pathname;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function assistantBubbleHiddenOnRoute(pathname: string): boolean {
  if (HIDDEN_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return true;
  }
  // The scan-review modal over a card (`/cards/<id>/scan-review`).
  return /^\/cards\/[^/]+\/scan-review/.test(pathname);
}

export function isTabRoute(pathname: string): boolean {
  return TAB_ROUTES.has(pathname);
}

export type BubbleZoneMetrics = {
  windowHeight: number;
  insetTop: number;
  insetBottom: number;
  /** The tab bar's full height (tab routes only). */
  tabBarHeight: number;
  /** The scanner's published geometry (window y), when it is mounted. */
  scanner?: AssistantBubbleScannerAnchor | null;
};

/** The scanner's frame bottom and collapsed-tray top, in window points. */
export type AssistantBubbleScannerAnchor = { frameBottom: number; trayTop: number; trayExpanded: boolean };

/** The vertical band (top-edge y range of the bubble) a route allows; null = no safe spot (hide). */
export type BubbleZone = { minY: number; maxY: number };

export const ASSISTANT_BUBBLE_SIZE = 52;
const EDGE_GAP = 12;
// Pushed stack pages: a back/close bar on top, often a pinned action bar at the
// bottom (the card page's ADD ITEM) — keep clear of both.
const STACK_TOP_BAR = 56;
const STACK_BOTTOM_BAR = 88;

export function assistantBubbleZone(pathname: string, metrics: BubbleZoneMetrics): BubbleZone | null {
  const { windowHeight, insetTop, insetBottom, tabBarHeight } = metrics;
  const size = ASSISTANT_BUBBLE_SIZE;
  if (pathname === '/scan') {
    // The pill row, reticle, zoom stack and SINGLE dropdown fill the top and
    // middle; the tray handle, counters and tab bar the bottom. The ONLY spot
    // that touches none of them is the band between the frame's bottom edge and
    // the collapsed tray, at a screen edge. No published geometry, an expanded
    // tray, or a band too short for the bubble = no safe spot: hidden.
    const anchor = metrics.scanner;
    if (!anchor || anchor.trayExpanded) {
      return null;
    }
    const top = anchor.frameBottom + EDGE_GAP;
    const bottom = anchor.trayTop - size - EDGE_GAP;
    return bottom >= top ? { minY: top, maxY: bottom } : null;
  }
  if (isTabRoute(pathname)) {
    return {
      minY: insetTop + STACK_TOP_BAR + EDGE_GAP,
      maxY: windowHeight - tabBarHeight - size - EDGE_GAP,
    };
  }
  return {
    minY: insetTop + STACK_TOP_BAR + EDGE_GAP,
    maxY: windowHeight - insetBottom - STACK_BOTTOM_BAR - size,
  };
}

export function clampToZone(y: number, zone: BubbleZone): number {
  return Math.min(Math.max(y, zone.minY), Math.max(zone.minY, zone.maxY));
}

/** Left/right edge x for the snapped bubble. */
export function bubbleEdgeX(side: 'left' | 'right', windowWidth: number): number {
  'worklet';
  return side === 'left' ? EDGE_GAP : windowWidth - ASSISTANT_BUBBLE_SIZE - EDGE_GAP;
}

/** Which edge a release snaps to: where the bubble's centre lands after a short fling. */
export function snapSide(x: number, velocityX: number, windowWidth: number): 'left' | 'right' {
  'worklet';
  const projected = x + ASSISTANT_BUBBLE_SIZE / 2 + velocityX * 0.12;
  return projected < windowWidth / 2 ? 'left' : 'right';
}

// --- scanner anchor store ------------------------------------------------------

let scannerAnchor: AssistantBubbleScannerAnchor | null = null;
const scannerAnchorListeners = new Set<() => void>();

export function setAssistantBubbleScannerAnchor(anchor: AssistantBubbleScannerAnchor | null): void {
  const same =
    anchor === scannerAnchor ||
    (anchor != null &&
      scannerAnchor != null &&
      anchor.frameBottom === scannerAnchor.frameBottom &&
      anchor.trayTop === scannerAnchor.trayTop &&
      anchor.trayExpanded === scannerAnchor.trayExpanded);
  if (same) {
    return;
  }
  scannerAnchor = anchor;
  scannerAnchorListeners.forEach((listener) => listener());
}

export function getAssistantBubbleScannerAnchor(): AssistantBubbleScannerAnchor | null {
  return scannerAnchor;
}

export function subscribeAssistantBubbleScannerAnchor(listener: () => void): () => void {
  scannerAnchorListeners.add(listener);
  return () => {
    scannerAnchorListeners.delete(listener);
  };
}
