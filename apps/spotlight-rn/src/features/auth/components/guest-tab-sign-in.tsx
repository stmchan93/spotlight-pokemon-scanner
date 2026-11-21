import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { EkalightMark } from '@/components/ekalight-mark';

import { useGuestGate } from '@/features/auth/use-guest-gate';

/*
  What a GUEST sees on a signed-in-only tab (Collection, Social). These tabs
  used to bounce guests back to the scanner, but in the swipe pager that bounce
  fights the strip and stranded guests on a fallback "Scan cards" button
  (owner, 2026-11-20). Now the tab simply stays put and asks them to sign in:
  no navigation, nothing to fight, and it shows what signing in gets them.
*/
export function GuestTabSignIn({
  title,
  message,
  testID = 'guest-tab-sign-in',
}: {
  title: string;
  message: string;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const { openLogin } = useGuestGate();

  return (
    <SafeAreaView edges={['top']} style={[styles.root, { backgroundColor: theme.colors.gray0 }]} testID={testID}>
      <View style={styles.content}>
        <EkalightMark color={theme.colors.purple500} height={48} width={52} />
        <Text style={[theme.typography.titleSmall, styles.center, { color: theme.colors.gray900 }]}>{title}</Text>
        <Text style={[theme.typography.body, styles.center, { color: theme.colors.gray600 }]}>{message}</Text>
        <Button label="SIGN IN" onPress={openLogin} style={styles.button} testID={`${testID}-button`} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'stretch',
    marginTop: spacing.sm,
  },
  center: {
    textAlign: 'center',
  },
  content: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  root: {
    flex: 1,
    justifyContent: 'center',
  },
});
