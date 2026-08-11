import {
  keyboardClearance,
  keyboardInsetSurcharge,
  keyboardLift,
} from '@/lib/keyboard-insets';

/*
  The arithmetic three surfaces need and had each derived for themselves — the
  New Post composer's footer lift, the comments sheet's composer padding, and the
  edit-profile form's scroll viewport (which had none at all, and shipped with the
  keyboard over the bio field).

  What it protects is the one non-obvious platform fact: Android's reported
  keyboard height EXCLUDES the navigation bar (`ReactRootView.java:922` —
  `int height = imeInsets.bottom - barInsets.bottom;`) while the safe-area inset
  pays that bar separately, and iOS's screen-coordinate frame already covers the
  home indicator. Each screen's own tests pin what IT does with these numbers;
  these pin the numbers.
*/
describe('keyboard insets', () => {
  describe('keyboardInsetSurcharge', () => {
    it('is the whole bottom inset on Android — the bar the keyboard height leaves out', () => {
      expect(keyboardInsetSurcharge(48, 'android')).toBe(48);
      // Gesture navigation is a smaller strip, but still a strip.
      expect(keyboardInsetSurcharge(24, 'android')).toBe(24);
    });

    it('is nothing on iOS, where the keyboard frame already reaches the screen edge', () => {
      expect(keyboardInsetSurcharge(34, 'ios')).toBe(0);
    });

    it('is never negative, whatever a provider reports before it has measured', () => {
      expect(keyboardInsetSurcharge(-10, 'android')).toBe(0);
    });
  });

  describe('keyboardClearance', () => {
    it('adds the navigation bar to the reported height on Android', () => {
      // What `edit-profile-screen.tsx` shrinks its scroll viewport by: stopping
      // at 300 would leave the focused field one nav bar inside the keyboard.
      expect(keyboardClearance(300, 48, 'android')).toBe(348);
    });

    it('is the reported height alone on iOS', () => {
      expect(keyboardClearance(300, 34, 'ios')).toBe(300);
    });

    it('reserves nothing with the keyboard down, on either platform', () => {
      expect(keyboardClearance(0, 48, 'android')).toBe(0);
      expect(keyboardClearance(0, 34, 'ios')).toBe(0);
    });
  });

  describe('keyboardLift', () => {
    /*
      `keyboardLift` is what a container that ALREADY pays a bottom inset needs,
      and it is the same quantity seen from the other side: the clearance minus
      what has already been paid. Stating it as an identity is what stops the two
      being "simplified" apart again.
    */
    it('is the clearance minus the inset the container already pays', () => {
      for (const platform of ['ios', 'android']) {
        for (const inset of [0, 24, 34, 48]) {
          expect(inset + keyboardLift(300, inset, platform)).toBe(
            keyboardClearance(300, inset, platform),
          );
        }
      }
    });

    it('lifts nothing when the keyboard is down', () => {
      expect(keyboardLift(0, 34, 'ios')).toBe(0);
      expect(keyboardLift(0, 48, 'android')).toBe(0);
    });
  });
});
