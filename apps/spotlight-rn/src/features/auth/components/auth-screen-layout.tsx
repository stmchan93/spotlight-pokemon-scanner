import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavArrowLeft, ShareIos } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

type AuthScreenLayoutProps = {
  /** Content flows top-down inside the scroll area on the plain black screen. */
  children: ReactNode;
  onBack?: () => void;
  backTestID?: string;
  /** Pass a handler to show the share affordance (top-right); hidden by default. */
  onShare?: (() => void) | null;
  testID?: string;
};

const HEADER_BUTTON_SIZE = 36;
/** Top offset for the first content row (wordmark / heading) on the black screen. */
const CONTENT_TOP = 132;
const SURFACE = '#000000';

/**
 * Shared presentation for the auth flow: a pure black screen with a floating
 * back/share header and a keyboard-aware scroll area. Purely presentational —
 * no nav/auth logic.
 */
export function AuthScreenLayout({
  children,
  onBack,
  backTestID,
  onShare,
  testID,
}: AuthScreenLayoutProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const showShare = typeof onShare === 'function';

  const handleShare = onShare
    ?? (() => {
      void Share.share({ message: 'Track your card collection with Ekalight.' }).catch(() => {
        /* user dismissed the share sheet */
      });
    });

  return (
    <View style={[styles.root, { backgroundColor: SURFACE }]} testID={testID}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardShell}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + 32, paddingTop: CONTENT_TOP },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Header floats over the wave: back (left) + optional share (right). */}
      <View
        pointerEvents="box-none"
        style={[styles.header, { paddingTop: insets.top + 6 }]}
      >
        {onBack ? (
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={8}
            onPress={onBack}
            style={({ pressed }) => [
              styles.headerButton,
              { backgroundColor: theme.colors.gray800, opacity: pressed ? 0.8 : 1 },
            ]}
            testID={backTestID}
          >
            <NavArrowLeft color={theme.colors.gray0} height={24} width={24} />
          </Pressable>
        ) : (
          <View style={styles.headerButton} />
        )}

        {showShare ? (
          <Pressable
            accessibilityLabel="Share Ekalight"
            accessibilityRole="button"
            hitSlop={8}
            onPress={handleShare}
            style={({ pressed }) => [
              styles.headerButton,
              { backgroundColor: theme.colors.gray800, opacity: pressed ? 0.8 : 1 },
            ]}
            testID="auth-share-button"
          >
            <ShareIos color={theme.colors.gray0} height={20} width={20} />
          </Pressable>
        ) : (
          <View style={styles.headerButton} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: 16,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  headerButton: {
    alignItems: 'center',
    borderRadius: 100,
    height: HEADER_BUTTON_SIZE,
    justifyContent: 'center',
    width: HEADER_BUTTON_SIZE,
  },
  keyboardShell: {
    flex: 1,
  },
  root: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    gap: 16,
    paddingHorizontal: 32,
  },
});
