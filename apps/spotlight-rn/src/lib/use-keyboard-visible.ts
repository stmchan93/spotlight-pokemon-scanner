import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Is the software keyboard up? ANDROID ONLY — iOS always answers false.
 *
 * Exists for the tab bar: on Android the bar is a BottomNavigationView drawn
 * OVER full-bleed content, and when the keyboard opens it rides up on top of
 * it — covering whatever input sits just above (reported from the share
 * sheet's recipient field). Hiding the bar while the keyboard is up is the
 * standard Android answer; react-navigation ships the same behaviour as
 * `tabBarHideOnKeyboard`. iOS's keyboard covers the bar instead of stacking
 * on it, so there the listener is never attached.
 *
 * `keyboardDidShow`/`keyboardDidHide` because Android does not emit the
 * `will` events at all.
 *
 * A separate module rather than inline in the tabs layout on purpose: the
 * layout's tests re-require it under `jest.resetModules()`, which hands it a
 * second React copy — any REAL hook inside that tree throws "invalid hook
 * call". Everything hook-shaped the layout touches is therefore mockable
 * hook-free, and this must stay that way.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const show = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return visible;
}
