import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Text, useSpotlightTheme } from '@spotlight/design-system';

import { SheetDismissHandle } from '@/components/sheet-dismiss-handle';

type ScanBulkConfirmSheetProps = {
  visible: boolean;
  /** Sheet heading — e.g. "Add N items to Collections?". */
  title: string;
  /** One-line centered description under the title. */
  description: string;
  /** Primary CTA label — "Add All" / "Remove". */
  confirmLabel: string;
  /** dark = black "Add All"; destructive = red "Remove". */
  confirmVariant: 'dark' | 'destructive';
  /** Disables both buttons while the bulk action is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * White bottom sheet that confirms the scanner tray's bulk "ADD ALL" / "REMOVE
 * ALL" actions (Figma 1379:2323, frames 3-5). The parent supplies the title,
 * description, confirm label, and confirm variant, so a single component covers
 * the three uses (Collections, Wishlist, Remove). Mirrors AddToCollectionSheet's
 * slide-up scaffold — spring-up on open, timing slide-down on close, kept mounted
 * through the close — so the two sheets feel like one system.
 */
export function ScanBulkConfirmSheet({
  visible,
  title,
  description,
  confirmLabel,
  confirmVariant,
  busy = false,
  onConfirm,
  onCancel,
  testID = 'scan-bulk-confirm-sheet',
}: ScanBulkConfirmSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  // Keep mounted through the closing slide-down, then unmount (matches
  // AddToCollectionSheet so the transition reads identically).
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
    <Modal
      animationType="none"
      onRequestClose={onCancel}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      {/* The instant the sheet starts closing (visible=false) the overlay stops
          intercepting touches, so the tray behind is tappable again even if the
          slide-down's unmount callback never fires. */}
      <View pointerEvents={visible ? 'auto' : 'none'} style={styles.root}>
        <Pressable
          accessibilityLabel="Cancel"
          accessibilityRole="button"
          onPress={onCancel}
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
          <SheetDismissHandle
            barColor={theme.colors.gray200}
            onDismiss={onCancel}
            testID={`${testID}-handle`}
          />

          <View style={styles.body}>
            <Text
              style={[theme.typography.titleSmall, styles.title, { color: theme.colors.gray900 }]}
              testID={`${testID}-title`}
            >
              {title}
            </Text>
            <Text
              style={[
                theme.typography.body,
                styles.description,
                { color: theme.colors.gray500 },
              ]}
              testID={`${testID}-description`}
            >
              {description}
            </Text>
          </View>

          <View style={styles.footer}>
            <Button
              disabled={busy}
              label={confirmLabel}
              labelStyleVariant="label"
              onPress={onConfirm}
              shape="rounded"
              size="md"
              testID={`${testID}-confirm`}
              variant={confirmVariant}
            />
            <Button
              disabled={busy}
              label="Cancel"
              labelStyleVariant="label"
              onPress={onCancel}
              shape="rounded"
              size="md"
              testID={`${testID}-cancel`}
              variant="ghost"
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  body: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  description: {
    marginTop: 8,
    textAlign: 'center',
  },
  footer: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 20,
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
    textAlign: 'center',
  },
});

export default ScanBulkConfirmSheet;
