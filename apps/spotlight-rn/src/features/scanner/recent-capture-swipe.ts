// Geometry of the right-side action rail revealed when a recent-capture row is
// swiped open (Figma 1511:4098 — circular Collection + Delete actions, each with
// a label underneath). The Swipeable in `recent-capture-swipe-row.tsx` measures
// the rail width to decide its open offset, so this stays the single source of
// truth.
export const recentCaptureActionCircleSize = 42;
export const recentCaptureActionIconSize = 20;
// 16px between the Collection and Delete action groups (Figma 1511:4098 gap).
export const recentCaptureActionGap = 16;
// Horizontal breathing room on each edge of the rail.
export const recentCaptureActionRailPadding = 16;
// Total revealed width. The "Collection" label is the widest element, so the
// rail is sized to fit it without clipping: padding + Collection group + gap +
// Delete group + padding.
export const recentCaptureActionRailRevealWidth = 160;
