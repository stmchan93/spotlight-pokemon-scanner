import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AlertPreferences } from '@spotlight/api-client';
import { ScreenHeader, Text, borderWidths, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { resolveDeviceTimeZone } from '@/features/notifications/push-notifications';
import { usePushPermissionPrompt } from '@/features/notifications/use-push-registration';
import { useAppServices } from '@/providers/app-providers';

type AlertKey = keyof AlertPreferences;

const ROWS: { key: AlertKey; title: string; description: string; testID: string }[] = [
  {
    description: 'Cards you own or watch, when they move 10%+ and $5+',
    key: 'priceMovesEnabled',
    testID: 'alert-settings-price-moves',
    title: 'Price moves',
  },
  {
    description: 'Sunday evening: how your collection did',
    key: 'weeklySummaryEnabled',
    testID: 'alert-settings-weekly-summary',
    title: 'Weekly summary',
  },
  {
    description: 'Watched cards listed well below market',
    key: 'dealAlertsEnabled',
    testID: 'alert-settings-deals',
    title: 'Deals under market',
  },
];

const DEFAULT_PREFS: AlertPreferences = {
  dealAlertsEnabled: true,
  priceMovesEnabled: true,
  weeklySummaryEnabled: true,
};

export type AlertSettingsScreenProps = {
  onBack?: () => void;
  testID?: string;
};

/**
 * Alerts — three switches, nothing else. The anti-spam limits (1 push a day,
 * quiet hours, per-card cooldown) are enforced server-side and silently.
 *
 * Each switch shows pref AND OS permission, like the Account deal toggle did:
 * a switch that reads ON while iOS drops every push would be a lie. Turning one
 * ON without permission is the deliberate tap that may spend the iOS prompt.
 */
export function AlertSettingsScreen({ onBack, testID = 'alert-settings' }: AlertSettingsScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { spotlightRepository } = useAppServices();
  const {
    enablePushNotifications,
    isBusy: permissionBusy,
    isEnabled: permissionGranted,
    refresh: refreshPermission,
  } = usePushPermissionPrompt();

  const [prefs, setPrefs] = useState<AlertPreferences>(DEFAULT_PREFS);
  const [busyKey, setBusyKey] = useState<AlertKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    void spotlightRepository
      .fetchAlertPreferences()
      .then((next) => {
        if (!cancelled) {
          setPrefs(next);
        }
      })
      .catch(() => {
        // The repository already degrades to the defaults.
      });
    return () => {
      cancelled = true;
    };
  }, [spotlightRepository]);

  const handleToggle = useCallback(
    async (key: AlertKey, nextEnabled: boolean) => {
      if (busyKey || permissionBusy) {
        return;
      }
      const previous = prefs;
      setPrefs({ ...previous, [key]: nextEnabled });
      setBusyKey(key);
      try {
        if (nextEnabled && !permissionGranted) {
          const granted = await enablePushNotifications();
          if (!granted) {
            // enablePushNotifications has already explained itself.
            setPrefs(previous);
            return;
          }
        }
        const result = await spotlightRepository.updateAlertPreferences({
          [key]: nextEnabled,
          timezone: resolveDeviceTimeZone(),
        });
        if (result.status !== 'ok') {
          setPrefs(previous);
          Alert.alert('Could not update alerts', 'Something went wrong. Please try again.');
          return;
        }
        setPrefs(result.prefs);
      } finally {
        setBusyKey(null);
        void refreshPermission();
      }
    },
    [busyKey, enablePushNotifications, permissionBusy, permissionGranted, prefs, refreshPermission, spotlightRepository],
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <ScrollView
        contentContainerStyle={{
          paddingBottom: insets.bottom + theme.spacing.lg,
          paddingHorizontal: theme.layout.pageGutter,
        }}
      >
        <ScreenHeader
          layout="stacked"
          leftAccessory={onBack ? <ChromeBackButton onPress={onBack} testID={`${testID}-back`} /> : undefined}
          style={{ paddingBottom: theme.spacing.xxxs, paddingTop: theme.spacing.xxs }}
          title="Alerts"
        />
        {ROWS.map((row) => (
          <View
            key={row.key}
            style={[
              styles.row,
              {
                borderBottomColor: theme.colors.gray300,
                gap: theme.spacing.xs,
                paddingVertical: theme.spacing.sm,
              },
            ]}
          >
            <View style={styles.copy}>
              <Text style={[theme.typography.bodyStrong, { color: theme.colors.textPrimary }]}>
                {row.title}
              </Text>
              <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>
                {row.description}
              </Text>
            </View>
            <Switch
              accessibilityLabel={row.title}
              disabled={busyKey !== null || permissionBusy}
              onValueChange={(next) => {
                void handleToggle(row.key, next);
              }}
              testID={row.testID}
              value={prefs[row.key] && permissionGranted}
            />
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: borderWidths.rule,
    flexDirection: 'row',
  },
  safeArea: {
    flex: 1,
  },
});

export default AlertSettingsScreen;
