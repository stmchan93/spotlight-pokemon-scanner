import { useEffect, useState } from 'react';
import { Keyboard, LayoutAnimation, Platform, type KeyboardEvent } from 'react-native';

/**
 * Bottom padding that keeps content above the keyboard inside an iOS form
 * sheet (react-native-screens `formSheet`).
 *
 * KeyboardAvoidingView can't do this: when the keyboard opens, iOS lifts the
 * sheet to its full height at the same moment, so the sheet's top moves while
 * its bottom stays on the screen's bottom edge. KAV measures its frame relative
 * to the sheet and needs the sheet's (moving) window offset to get the overlap
 * right. With the bottom pinned, the overlap is simply the keyboard's height.
 *
 * 0 when disabled, on Android (use KAV there), or with no keyboard.
 */
export function useSheetKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!enabled || Platform.OS !== 'ios') {
      setInset(0);
      return undefined;
    }
    // Ride the keyboard's own curve, as KeyboardAvoidingView does.
    const animate = (event: KeyboardEvent) => {
      if (event.duration > 0) {
        LayoutAnimation.configureNext({
          duration: event.duration,
          update: { duration: event.duration, type: LayoutAnimation.Types.keyboard },
        });
      }
    };
    const show = Keyboard.addListener('keyboardWillShow', (event) => {
      animate(event);
      setInset(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener('keyboardWillHide', (event) => {
      animate(event);
      setInset(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [enabled]);

  return inset;
}
