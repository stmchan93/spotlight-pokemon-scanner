import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Text, useSpotlightTheme } from '@spotlight/design-system';

/**
 * How loudly a row is styled. The menu carries actions of genuinely different
 * weight and must not present them as equals:
 *
 *  - `destructive` — a red CTA. For the action there is no way back from
 *    (Block: it is mutual, and the app has no unblock surface yet).
 *  - `caution` — the neutral CTA shell with a red LABEL. For an action that is
 *    serious but reversible and low-stakes (Report: idempotent server-side,
 *    hides nothing on its own, and a moderator reads it before anything
 *    happens). It reads as "not an everyday tap" without reading as a demolition.
 *  - `neutral` (default) — an ordinary choice, styled like Cancel.
 *
 * Two red slabs stacked over a Cancel is how the safety menu looked before, and
 * it made the cheap action look as expensive as the permanent one.
 */
export type OptionsSheetActionTone = 'neutral' | 'caution' | 'destructive';

export type OptionsSheetAction = {
  key: string;
  label: string;
  tone?: OptionsSheetActionTone;
  onPress: () => void;
};

type OptionsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * Optional centered title, e.g. "Comment options".
   *
   * OPTIONAL, and both callers omit it: a menu of two or three plainly-labelled
   * actions does not need a line of chrome telling you it is a menu — "Comment
   * options" over "Report comment / Block Misty" only repeats what the rows
   * already say. Kept as a prop rather than deleted so a future menu whose
   * subject is NOT obvious from its rows can still name it.
   */
  title?: string;
  /** Optional body copy under the title. Same reasoning as `title`. */
  message?: string;
  /** The choices, in order. Cancel is appended automatically. */
  actions: OptionsSheetAction[];
  cancelLabel?: string;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * A menu of choices in a bottom sheet, rendered IN-TREE — it has no `Modal` of
 * its own.
 *
 * Deliberately built to be the sibling of `ConfirmDeleteSheet`'s `inline`
 * presentation: same scrim, same slide, same stacked CTA column, so a surface
 * that shows a menu and then a confirmation shows two shapes of one thing rather
 * than two idioms. Its only reason to exist separately is arity — a confirmation
 * has exactly one action, a menu has several.
 *
 * NO `Modal`, on purpose. Every caller renders it inside a `Modal` of their own
 * (the comments sheet is one; the post card mounts a small one just for this
 * menu and its follow-up confirmation), and presenting a second native modal
 * over a presented one is unreliable on iOS — the confirmation can come up
 * BEHIND the sheet, which reads to the user as the button doing nothing. An
 * in-tree overlay has no view controller to collide with. Render it last inside
 * the caller's overlay so it paints above the rest.
 */
export function OptionsSheet({
  visible,
  onClose,
  title,
  message,
  actions,
  cancelLabel = 'Cancel',
  testID = 'options-sheet',
}: OptionsSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  // Stay mounted through the closing slide-down, then unmount — matches
  // `ConfirmDeleteSheet` so the transition reads identically.
  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      const animation = Animated.spring(translateY, {
        toValue: 0,
        damping: 34,
        mass: 1,
        stiffness: 320,
        useNativeDriver: false,
      });
      animation.start();
      return () => animation.stop();
    }

    const animation = Animated.timing(translateY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
      }
    });
    return () => animation.stop();
  }, [translateY, visible]);

  if (!isRendered) {
    return null;
  }

  return (
    <View pointerEvents={visible ? 'auto' : 'none'} style={[styles.root, styles.inlineRoot]}>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
        testID={`${testID}-backdrop`}
      />
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.gray0,
            paddingBottom: Math.max(insets.bottom, 16) + 8,
            transform: [{ translateY }],
          },
        ]}
        testID={testID}
      >
        {/*
          The handle stays even with no title: it is the sheet's top edge and its
          tap-to-close target, and it is what stops a bare list of buttons
          looking like it grew out of the bottom of the screen.
        */}
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            hitSlop={16}
            onPress={onClose}
            style={styles.handleHit}
            testID={`${testID}-handle`}
          >
            <View style={[styles.handleBar, { backgroundColor: theme.colors.gray200 }]} />
          </Pressable>
          {title ? (
            <Text
              style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray900 }]}
            >
              {title}
            </Text>
          ) : null}
        </View>

        {message ? (
          <Text style={[theme.typography.body, styles.message, { color: theme.colors.gray900 }]}>
            {message}
          </Text>
        ) : null}

        {/* Less air above the first row when there is no header to separate from. */}
        <View style={[styles.actions, title || message ? null : styles.actionsBare]}>
          {actions.map((action) => (
            <Button
              key={action.key}
              label={action.label}
              // `caution` keeps the neutral shell and turns only the LABEL red —
              // see `OptionsSheetActionTone`.
              labelStyle={
                action.tone === 'caution' ? { color: theme.colors.dangerStrong } : undefined
              }
              labelStyleVariant="label"
              onPress={action.onPress}
              shape="rounded"
              size="md"
              testID={`${testID}-${action.key}`}
              variant={action.tone === 'destructive' ? 'destructive' : 'outline'}
            />
          ))}
          <Button
            label={cancelLabel}
            labelStyleVariant="label"
            onPress={onClose}
            shape="rounded"
            size="md"
            testID={`${testID}-cancel`}
            variant="outline"
          />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  actionsBare: {
    paddingTop: 16,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  handleBar: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  handleHit: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 4,
  },
  header: {
    width: '100%',
  },
  // Fill the caller's Modal instead of being one. `zIndex` so the overlay paints
  // above its siblings on both platforms rather than relying on child order.
  inlineRoot: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  message: {
    paddingHorizontal: 16,
    paddingTop: 16,
    textAlign: 'center',
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    paddingTop: 10,
  },
  title: {
    paddingTop: 14,
    textAlign: 'center',
  },
});

export default OptionsSheet;
