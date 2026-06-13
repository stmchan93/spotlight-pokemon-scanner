// Width of the right-side action rail revealed when a recent-capture row is
// swiped open. The Swipeable in `recent-capture-swipe-row.tsx` measures this rail
// to decide its open offset, so these widths stay the single source of truth.
export const recentCaptureFavoriteRevealWidth = 68;
export const recentCaptureDeleteRevealWidth = 68;
export const recentCaptureActionRailRevealWidth =
  recentCaptureFavoriteRevealWidth
  + recentCaptureDeleteRevealWidth
  + 12;
