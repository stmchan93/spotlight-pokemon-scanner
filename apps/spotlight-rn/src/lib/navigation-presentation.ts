import { colors, radii } from '@spotlight/design-system';

/**
 * Presentation options shared by full-screen routes that open bottom-up (like
 * Search). The native swipe down is taken only from this top zone; the rest of
 * the page closes through `PullDownToDismiss` once its content is at the top.
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

/** Ask Ekalight's sheet height, as a fraction of the screen (owner, 2026-11-22: "80–90%"). */
export const ASSISTANT_SHEET_DETENT = 0.9;

/**
 * Ask Ekalight opens as a native form sheet (owner, 2026-11-22): it rises to
 * 90% and the page it was opened from stays visible, dimmed, above it — you
 * are still on that page. iOS: UISheetPresentationController (grabber, swipe
 * down on the top band to close). Android: react-native-screens'
 * BottomSheetBehavior sheet.
 *
 * The route lives at the ROOT stack: react-native-screens ignores a
 * presentation on a stack's bottom-most screen, which is what it would be as
 * the first screen of a group.
 */
export const ASSISTANT_SHEET_OPTIONS = {
  presentation: 'formSheet' as const,
  sheetAllowedDetents: [ASSISTANT_SHEET_DETENT],
  sheetCornerRadius: radii.sheet,
  sheetGrabberVisible: true,
  // One detent: nothing to expand to.
  sheetExpandsWhenScrolledToEdge: false,
  contentStyle: { backgroundColor: colors.gray0 },
};
