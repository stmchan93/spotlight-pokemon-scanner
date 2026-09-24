import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, View } from 'react-native';

import type { AlertPreferences } from '@spotlight/api-client';
import { Text, borderWidths, useSpotlightTheme } from '@spotlight/design-system';

import { resolveDeviceTimeZone } from '@/features/notifications/push-notifications';
import { usePushPermissionPrompt } from '@/features/notifications/use-push-registration';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

type AlertKey = keyof AlertPreferences;

const PREF_ANALYTICS_NAME: Record<AlertKey, 'price_moves' | 'weekly_summary' | 'deals'> = {
  dealAlertsEnabled: 'deals',
  priceMovesEnabled: 'price_moves',
  weeklySummaryEnabled: 'weekly_summary',
};

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

export type AlertSettingsSectionProps = {
  testID?: string;
};

/**
 * Alert switches, shown inline on the Account screen. Three switches, nothing else. The anti-spam limits (1 push a day,
 * quiet hours, per-card cooldown) are enforced server-side and silently.
 *
 * Each switch shows pref AND OS permission, like the Account deal toggle did:
 * a switch that reads ON while iOS drops every push would be a lie. Turning one
 * ON without permission is the deliberate tap that may spend the iOS prompt.
 */
export function AlertSettingsSection({ testID = 'alert-settings' }: AlertSettingsSectionProps) {
  const theme = useSpotlightTheme();
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
        capturePostHogEvent(AnalyticsEvent.alertPrefChanged, {
          pref: PREF_ANALYTICS_NAME[key],
          enabled: nextEnabled,
        });
      } finally {
        setBusyKey(null);
        void refreshPermission();
      }
    },
    [busyKey, enablePushNotifications, permissionBusy, permissionGranted, prefs, refreshPermission, spotlightRepository],
  );

  return (
    <View testID={testID}>
      {ROWS.map((row, index) => (
        <View
          key={row.key}
          style={[
            styles.row,
            {
              borderBottomColor: theme.colors.gray300,
              borderBottomWidth: index === ROWS.length - 1 ? 0 : borderWidths.rule,
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
    </View>
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
    flexDirection: 'row',
  },
});
