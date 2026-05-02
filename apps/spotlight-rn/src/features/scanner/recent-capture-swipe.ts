export const recentCaptureFavoriteRevealWidth = 74;
export const recentCaptureDeleteRevealWidth = 74;
export const recentCaptureActionRailRevealWidth =
  recentCaptureFavoriteRevealWidth + recentCaptureDeleteRevealWidth;
export const recentCaptureDeleteDistanceThreshold = 64;
export const recentCaptureDeleteVelocityThreshold = 0.62;
export const recentCaptureDeleteCloseDistanceThreshold = 32;
export const recentCaptureDeleteCloseVelocityThreshold = 0.4;

type RecentCaptureSwipeState = {
  dx: number;
  dy: number;
  vx: number;
};

export function clampRecentCaptureSwipeTranslate(dx: number, isDeleteRevealed = false) {
  const start = isDeleteRevealed ? -recentCaptureActionRailRevealWidth : 0;
  return Math.min(0, Math.max(start + dx, -recentCaptureActionRailRevealWidth));
}

export function shouldSetRecentCaptureSwipeResponder(
  { dx, dy }: Pick<RecentCaptureSwipeState, 'dx' | 'dy'>,
  isDeleteRevealed = false,
) {
  const isHorizontalSwipe = Math.abs(dx) > Math.abs(dy) * 1.35;

  if (!isHorizontalSwipe) {
    return false;
  }

  if (isDeleteRevealed) {
    return dx > 10;
  }

  return dx < -10;
}

export function shouldRevealRecentCaptureDeleteFromSwipe({ dx, dy, vx }: RecentCaptureSwipeState) {
  if (!shouldSetRecentCaptureSwipeResponder({ dx, dy })) {
    return false;
  }

  return dx <= -recentCaptureDeleteDistanceThreshold || vx <= -recentCaptureDeleteVelocityThreshold;
}

export function shouldCollapseRecentCaptureDeleteFromSwipe({ dx, dy, vx }: RecentCaptureSwipeState) {
  if (!shouldSetRecentCaptureSwipeResponder({ dx, dy }, true)) {
    return false;
  }

  return Math.abs(dx) >= recentCaptureDeleteCloseDistanceThreshold || vx >= recentCaptureDeleteCloseVelocityThreshold;
}
