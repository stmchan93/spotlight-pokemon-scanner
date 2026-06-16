import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NavArrowLeft, ShareIos } from 'iconoir-react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

type AuthScreenLayoutProps = {
  /** Pinned content below the scroll area is not used by the Figma; everything
   *  flows top-down inside the scroll, so screens just pass children. */
  children: ReactNode;
  /** Header title (e.g. "Sign / Signup"). Omit on the entry screen for no header. */
  title?: string;
  onBack?: () => void;
  backTestID?: string;
  /** Defaults to sharing the app; pass null to hide the share affordance. */
  onShare?: (() => void) | null;
  testID?: string;
};

const HEADER_BUTTON_SIZE = 36;

/**
 * Shared presentation for the redesigned auth flow (Figma 1543:2170): a plain
 * white screen with an optional top header (back circle, centered title, share
 * circle) and a keyboard-aware scroll area with 32px content margins. Content
 * flows top-down (wordmark → fields → buttons); nothing is bottom-pinned.
 * Purely presentational — no navigation/auth logic.
 */
export function AuthScreenLayout({
  children,
  title,
  onBack,
  backTestID,
  onShare,
  testID,
}: AuthScreenLayoutProps) {
  const theme = useSpotlightTheme();
  const showHeader = Boolean(title || onBack || onShare !== null);

  const handleShare = onShare
    ?? (() => {
      void Share.share({ message: 'Track your card collection with Ekalight.' }).catch(() => {
        /* user dismissed the share sheet */
      });
    });

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      {showHeader ? (
        <View style={styles.header}>
          {onBack ? (
            <Pressable
              accessibilityLabel="Back"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onBack}
              style={({ pressed }) => [
                styles.headerButton,
                { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.8 : 1 },
              ]}
              testID={backTestID}
            >
              <NavArrowLeft color={theme.colors.gray900} height={24} width={24} />
            </Pressable>
          ) : (
            <View style={styles.headerButton} />
          )}

          <Text
            numberOfLines={1}
            style={[styles.headerTitle, { color: theme.colors.gray900 }]}
          >
            {title ?? ''}
          </Text>

          {onShare !== null ? (
            <Pressable
              accessibilityLabel="Share Ekalight"
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleShare}
              style={({ pressed }) => [
                styles.headerButton,
                { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.8 : 1 },
              ]}
              testID="auth-share-button"
            >
              <ShareIos color={theme.colors.gray900} height={20} width={20} />
            </Pressable>
          ) : (
            <View style={styles.headerButton} />
          )}
        </View>
      ) : null}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardShell}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  headerButton: {
    alignItems: 'center',
    borderRadius: 100,
    height: HEADER_BUTTON_SIZE,
    justifyContent: 'center',
    width: HEADER_BUTTON_SIZE,
  },
  headerTitle: {
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 18,
    lineHeight: 23,
    textAlign: 'center',
  },
  keyboardShell: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    gap: 16,
    paddingBottom: 32,
    paddingHorizontal: 32,
    paddingTop: 24,
  },
});
