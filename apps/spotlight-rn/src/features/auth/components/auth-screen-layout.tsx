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

import { WaveBackground } from './wave-background';

type AuthScreenLayoutProps = {
  /** Content flows top-down inside the scroll area, below the wave hero. */
  children: ReactNode;
  onBack?: () => void;
  backTestID?: string;
  /** Pass a handler to show the share affordance (top-right); hidden by default. */
  onShare?: (() => void) | null;
  testID?: string;
};

const HEADER_BUTTON_SIZE = 36;
/** Wave band height (Figma 1481:4380, "image 17": 0..264). */
const HERO_HEIGHT = 264;
/** Where the first content row (wordmark / heading) starts — Figma y≈320, which
 *  leaves a black gap under the wave so it fades seamlessly into the screen. */
const CONTENT_TOP = 312;
const SURFACE = '#000000';

/**
 * Shared presentation for the redesigned auth flow (Figma 1481:4380): a pure
 * black screen with the flowing halftone wave hero filling the top band, a
 * floating back/share header over it, and a keyboard-aware scroll area whose
 * content begins just below the wave. Purely presentational — no nav/auth logic.
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
      <WaveBackground height={HERO_HEIGHT} testID="auth-wave-background" />

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
