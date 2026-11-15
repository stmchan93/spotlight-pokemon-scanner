import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Is the software keyboard up? Both platforms.
 *
 * The tab pager uses it twice:
 *  - the outer strip never pages while the user is typing (that used to be a
 *    per-screen `shouldStandDown`, e.g. Collection's filter field);
 *  - ANDROID ONLY, the tab bar hides while it is up. Android's keyboard rides
 *    the bar up on top of whatever input sits just above it (reported from the
 *    share sheet's recipient field) — react-navigation ships the same as
 *    `tabBarHideOnKeyboard`. iOS's keyboard covers the bar instead.
 *
 * iOS listens to the `will` events so the lock is in place before the keyboard
 * animates; Android does not emit them at all, hence the `did` pair there.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return visible;
}
