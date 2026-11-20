/**
 * Presentation options shared by full-screen routes that open bottom-up and
 * close with a swipe down taken only from the top zone (like Search), so
 * scrolling content back up never dismisses them.
 */
export const SLIDE_UP_DISMISS_ZONE = 140;

/** Duration of the bottom-up slide (iOS). */
export const SLIDE_UP_DURATION_MS = 300;

export const SLIDE_UP_SCREEN_OPTIONS = {
  animation: 'slide_from_bottom',
  // iOS runs slide_from_bottom as a custom transition that defaults to 500ms,
  // noticeably slower than a native push (~350ms) (owner, 2026-11-20).
  animationDuration: SLIDE_UP_DURATION_MS,
  gestureDirection: 'vertical',
  gestureResponseDistance: { top: SLIDE_UP_DISMISS_ZONE },
} as const;

/**
 * `(stack)` routes that open bottom-up (owner, 2026-11-16): Ask Ekalight and
 * Collection's Edit profile. Entering `(stack)` from the tabs presents the
 * GROUP, so the group's options decide the animation; they read which inner
 * route the push opens with.
 */
export const SLIDE_UP_STACK_ROUTES: ReadonlySet<string> = new Set(['assistant', 'edit-profile']);

/** Root-stack options for the `(stack)` group: slide up when it opens on one of those routes. */
export function slideUpStackGroupOptions({ route }: { route: { params?: object } }) {
  const screen = (route.params as { screen?: unknown } | undefined)?.screen;
  return typeof screen === 'string' && SLIDE_UP_STACK_ROUTES.has(screen) ? SLIDE_UP_SCREEN_OPTIONS : {};
}
