import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Text } from './scaled-text';
import { colors, textStyles } from '../tokens';

export type ToastTone = 'dark' | 'light' | 'warning';

export type ToastProps = {
  /** Whether the toast is shown. Toggling to false fades it out, then unmounts. */
  visible: boolean;
  /** Message body. Retained through the fade-out so it never blanks mid-exit. */
  message: string;
  /**
   * Primary action invoked when the toast body is tapped (e.g. apply the
   * suggested fix). When omitted the body is not pressable.
   */
  onPress?: () => void;
  /** Invoked on the auto-dismiss timeout or when the close (×) is tapped. */
  onDismiss: () => void;
  /** Auto-dismiss delay in ms. Defaults to 6000. Pass 0 to disable auto-dismiss. */
  durationMs?: number;
  /** Accessibility label for the pressable body. */
  actionAccessibilityLabel?: string;
  /** Render the × close affordance. Defaults to true. */
  showDismiss?: boolean;
  /** `dark` (default) reads over the camera; `light` for elevated surfaces; `warning` for yellow alert state. */
  tone?: ToastTone;
  /** Positioning/layout overrides — the toast itself is layout-agnostic. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const DEFAULT_DURATION_MS = 6000;
const FADE_MS = 180;

/**
 * Lightweight, auto-dismissing transient message. Controlled via `visible`:
 * fades/slides in, calls `onDismiss` after `durationMs`, and fades out when
 * `visible` goes false. Optionally tappable as a single primary action. The
 * consumer positions it (e.g. absolutely over the camera) via `style`.
 */
export function Toast({
  visible,
  message,
  onPress,
  onDismiss,
  durationMs = DEFAULT_DURATION_MS,
  actionAccessibilityLabel,
  showDismiss = true,
  tone = 'dark',
  style,
  testID,
}: ToastProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-8)).current;
  const [mounted, setMounted] = useState(visible);
  // Retain the last non-empty message so the text doesn't blank mid-fade-out
  // when the parent clears its state on the same tick visibility goes false.
  const [renderedMessage, setRenderedMessage] = useState(message);
  // Hold the latest onDismiss without resetting the auto-dismiss timer on every
  // parent re-render (the camera screen re-renders frequently).
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // Mount immediately on show; keep mounted through the fade-out on hide.
  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (message) {
        setRenderedMessage(message);
      }
      return undefined;
    }
    const unmountTimer = setTimeout(() => setMounted(false), FADE_MS);
    return () => clearTimeout(unmountTimer);
  }, [visible, message]);

  // Fade/slide animation tracks `visible`.
  useEffect(() => {
    const animation = Animated.parallel([
      Animated.timing(opacity, {
        toValue: visible ? 1 : 0,
        duration: FADE_MS,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: visible ? 0 : -8,
        duration: FADE_MS,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [visible, opacity, translateY]);

  // Auto-dismiss timer — set once per show, not reset on re-render.
  useEffect(() => {
    if (!visible || durationMs <= 0) {
      return undefined;
    }
    const timer = setTimeout(() => onDismissRef.current(), durationMs);
    return () => clearTimeout(timer);
  }, [visible, durationMs]);

  if (!mounted) {
    return null;
  }

  const contentColor = tone === 'dark' ? colors.gray0 : colors.textPrimary;
  const toneStyle =
    tone === 'dark' ? styles.toastDark : tone === 'warning' ? styles.toastWarning : styles.toastLight;
  const Body = onPress ? Pressable : View;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[{ opacity, transform: [{ translateY }] }, style]}
    >
      <Body
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={actionAccessibilityLabel}
        onPress={onPress}
        style={[styles.toast, toneStyle]}
        testID={testID}
      >
        <Text style={[styles.message, { color: contentColor }]}>{renderedMessage}</Text>
        {showDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={8}
            onPress={onDismiss}
            testID={testID ? `${testID}-dismiss` : undefined}
          >
            <Text style={[styles.dismiss, { color: contentColor }]}>×</Text>
          </Pressable>
        ) : null}
      </Body>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  toastDark: {
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
  },
  toastLight: {
    backgroundColor: colors.canvasElevated,
  },
  toastWarning: {
    backgroundColor: colors.warning,
  },
  message: {
    ...textStyles.caption,
    flex: 1,
  },
  dismiss: {
    ...textStyles.headline,
    lineHeight: 20,
  },
});
