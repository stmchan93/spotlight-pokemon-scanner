import { NavigationContext, useIsFocused } from '@react-navigation/native';
import { useContext } from 'react';
import { StatusBar, type StatusBarStyle } from 'expo-status-bar';

/**
 * `<StatusBar>` that only speaks while its screen is the one you are looking at.
 *
 * WHY THIS HAS TO EXIST. `expo-status-bar`'s `<StatusBar>` is imperative under
 * the declarative shell: mounting one SETS the bar style process-wide. That was
 * fine under the old pager, where one component owned the bar and flipped it
 * with the active page. Native tabs keep EVERY tab screen mounted at once, so
 * several of them were setting the style simultaneously and the winner was
 * whichever rendered last — not whichever the user was on.
 *
 * The visible symptom was the scanner: it asks for `light` (white time, wifi,
 * battery over the camera) and got another tab's `dark` instead, because every
 * other tab is mounted the whole time. The same collision hid Collection's own
 * white-over-cover bar (owner's friend, 2026-09-11: "on the scanner AND the you
 * page, the lte, wifi, battery, and time should all be white").
 *
 * Gating on focus makes the mounted-but-unfocused screens silent, so the one
 * screen the user is actually looking at is the only one that sets the style.
 */
export function FocusedStatusBar({ style }: { style: StatusBarStyle }) {
  // `useIsFocused` THROWS outside a navigator, and these screens are rendered
  // bare in isolated tests and in the dev-screen host. With no navigator there
  // is nothing to be unfocused from, so behave like a plain <StatusBar>. The
  // hook lives in the child below so it is only ever called where it is legal.
  const navigation = useContext(NavigationContext);
  if (!navigation) {
    return <StatusBar style={style} />;
  }
  return <NavigationFocusedStatusBar style={style} />;
}

function NavigationFocusedStatusBar({ style }: { style: StatusBarStyle }) {
  const isFocused = useIsFocused();
  return isFocused ? <StatusBar style={style} /> : null;
}
