type RecentCaptureTrayGestureState = {
  dx: number;
  dy: number;
};

type RecentCaptureTrayShellResponderParams = {
  isTopLevelSwipeEnabled: boolean;
  isTrayExpanded: boolean;
  scrollOffsetY: number;
};

export function shouldSetRecentCaptureTrayVerticalResponder(
  { dx, dy }: RecentCaptureTrayGestureState,
) {
  return Math.abs(dy) > 4 && Math.abs(dy) > Math.abs(dx);
}

export function shouldSetRecentCaptureTrayShellResponder(
  gestureState: RecentCaptureTrayGestureState,
  {
    isTopLevelSwipeEnabled,
    isTrayExpanded,
    scrollOffsetY,
  }: RecentCaptureTrayShellResponderParams,
) {
  if (!isTopLevelSwipeEnabled || !shouldSetRecentCaptureTrayVerticalResponder(gestureState)) {
    return false;
  }

  if (!isTrayExpanded) {
    return gestureState.dy < 0;
  }

  return scrollOffsetY <= 0 && gestureState.dy > 0;
}
