import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavArrowLeft } from 'iconoir-react-native';

import { EkalightWordmark, useSpotlightTheme } from '@spotlight/design-system';

type AuthScreenLayoutProps = {
  /** Content flows top-down inside the scroll area on the white screen. */
  children: ReactNode;
  onBack?: () => void;
  backTestID?: string;
  /** Pinned to the bottom of the screen (e.g. the terms/privacy line). */
  footer?: ReactNode;
  testID?: string;
};

const HEADER_BUTTON_SIZE = 40;
// Figma 3686:58352 renders the lockup at 32pt tall inside the top toolbar.
const WORDMARK_HEIGHT = 32;

/**
 * Shared presentation for the auth flow (Figma 2161:6847 "Log In" /
 * 2170:7283 "Password Reset"): a white screen with a floating header — a
 * circular gray back button (left) and the centered purple Ekalight wordmark
 * (Figma 3686:58352) — above a keyboard-aware scroll area, plus an optional
 * bottom-pinned footer. Purely presentational — no nav/auth logic.
 *
 * Every auth surface routes through here, so the wordmark lands on log in,
 * sign up, and change password alike.
 */
export function AuthScreenLayout({
  children,
  onBack,
  backTestID,
  footer,
  testID,
}: AuthScreenLayoutProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  // Header row: insets.top + 16 padding + 40 button; content starts 32 below it
  // (the toolbar's 16 bottom padding plus a 16 gap, per Figma 4255:88306).
  const contentTop = insets.top + 16 + HEADER_BUTTON_SIZE + 32;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.gray0 }]} testID={testID}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardShell}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + 96, paddingTop: contentTop },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Header: circular back button (left) + centered EKALIGHT wordmark. */}
      <View
        pointerEvents="box-none"
        style={[styles.header, { backgroundColor: theme.colors.gray0, paddingTop: insets.top + 16 }]}
      >
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

        {/* Purple lockup, not plain text (Figma 3686:58352). */}
        <EkalightWordmark height={WORDMARK_HEIGHT} testID="auth-header-wordmark" />

        {/* Right spacer keeps the title centered. */}
        <View style={styles.headerButton} />
      </View>

      {footer ? (
        <View
          pointerEvents="box-none"
          style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    bottom: 0,
    left: 0,
    paddingHorizontal: 16,
    position: 'absolute',
    right: 0,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingBottom: 16,
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
    gap: 24,
    paddingHorizontal: 16,
  },
});
