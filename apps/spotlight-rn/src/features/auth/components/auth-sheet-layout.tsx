import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NavArrowLeft } from 'iconoir-react-native';

import { IconButton, useSpotlightTheme } from '@spotlight/design-system';

type AuthSheetLayoutProps = {
  actions?: ReactNode;
  backTestID?: string;
  children: ReactNode;
  onBack?: () => void;
  testID?: string;
};

/**
 * Shared presentation for the email-auth flow: a full-bleed purple background
 * (purple300) with a dark scrim, and a white sheet anchored to the bottom that
 * fills most of the screen (rounded top corners, a centered drag handle, an
 * optional circular back button, a scrollable content area, and a pinned
 * bottom actions area). Purely presentational — no navigation logic.
 */
export function AuthSheetLayout({
  actions,
  backTestID,
  children,
  onBack,
  testID,
}: AuthSheetLayoutProps) {
  const theme = useSpotlightTheme();

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.purple300 }]}
      testID={testID}
    >
      <View style={styles.scrim} pointerEvents="none" />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardShell}
      >
        <View style={[styles.sheet, { backgroundColor: theme.colors.gray0 }]}>
          <View style={[styles.handle, { backgroundColor: theme.colors.gray200 }]} />

          {onBack ? (
            <View style={styles.backRow}>
              <IconButton
                accessibilityLabel="Back"
                onPress={onBack}
                size={36}
                testID={backTestID}
                variant="subtle"
              >
                <NavArrowLeft color={theme.colors.gray900} height={20} width={20} />
              </IconButton>
            </View>
          ) : null}

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
          >
            {children}
          </ScrollView>

          {actions ? <View style={styles.actions}>{actions}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  backRow: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  handle: {
    alignSelf: 'center',
    borderRadius: 999,
    height: 4,
    marginTop: 10,
    width: 36,
  },
  keyboardShell: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  safeArea: {
    flex: 1,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    gap: 16,
    paddingBottom: 16,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '92%',
    paddingBottom: 24,
  },
});
