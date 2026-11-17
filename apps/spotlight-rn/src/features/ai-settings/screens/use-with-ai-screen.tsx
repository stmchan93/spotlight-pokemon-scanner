import { useCallback, useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AiSettings } from '@spotlight/api-client';
import { Button, SurfaceCard, Text, borderWidths, colors, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  listConnectedApps,
  revokeConnectedApp,
  type ConnectedApp,
} from '@/features/ai-settings/connected-apps';
import { resolveRepositoryBaseUrl, useAppServices } from '@/providers/app-providers';

/** The MCP connector lives at `<API base>/mcp` (Caddy routes it to the MCP process). */
export function resolveMcpServerUrl(baseUrl: string | null = resolveRepositoryBaseUrl()): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, '');
  return trimmed ? `${trimmed}/mcp` : null;
}

const CLAUDE_STEPS = [
  'In Claude, open Settings → Connectors → Add custom connector.',
  'Paste the URL above and add it.',
  'Tap Connect, log in with Ekalight, then tap Approve.',
];

type SettingsState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; settings: AiSettings };

function formatGrantedAt(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export type UseWithAiScreenProps = {
  onBack?: () => void;
  /** Defaults to the app's configured API base URL + `/mcp`. */
  mcpUrl?: string | null;
};

export function UseWithAiScreen({ onBack, mcpUrl = resolveMcpServerUrl() }: UseWithAiScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { spotlightRepository } = useAppServices();
  const sectionTitle = [theme.typography.titleSmall, { color: theme.colors.textPrimary }];
  const bodySecondary = [theme.typography.body, { color: theme.colors.textSecondary }];

  const [settingsState, setSettingsState] = useState<SettingsState>({ status: 'loading' });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  // undefined = loading, null = can't list here (show the fallback line).
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[] | null | undefined>(undefined);
  const [revokingClientId, setRevokingClientId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void spotlightRepository.getAiSettings().then((settings) => {
      if (!cancelled) {
        setSettingsState(settings ? { settings, status: 'ready' } : { status: 'failed' });
      }
    });
    void listConnectedApps().then((apps) => {
      if (!cancelled) {
        setConnectedApps(apps);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [spotlightRepository]);

  const handleCopyUrl = useCallback(async () => {
    if (!mcpUrl) {
      return;
    }
    try {
      await Clipboard.setStringAsync(mcpUrl);
      setUrlCopied(true);
    } catch {
      // The URL is on screen and selectable; a failed copy isn't a dead end.
    }
  }, [mcpUrl]);

  const handleToggleEdits = useCallback(
    async (nextEnabled: boolean) => {
      if (settingsBusy || settingsState.status !== 'ready') {
        return;
      }
      const previous = settingsState.settings;
      setSettingsState({ settings: { allowMcpEdits: nextEnabled }, status: 'ready' });
      setSettingsBusy(true);
      try {
        const result = await spotlightRepository.setAiSettings({ allowMcpEdits: nextEnabled });
        if (result.status !== 'ok') {
          setSettingsState({ settings: previous, status: 'ready' });
          Alert.alert('Could not update this setting', 'Something went wrong. Please try again.');
          return;
        }
        setSettingsState({ settings: result.settings, status: 'ready' });
      } finally {
        setSettingsBusy(false);
      }
    },
    [settingsBusy, settingsState, spotlightRepository],
  );

  const confirmRevoke = useCallback(async (app: ConnectedApp) => {
    setRevokingClientId(app.clientId);
    try {
      const revoked = await revokeConnectedApp(app.clientId);
      if (!revoked) {
        Alert.alert('Could not disconnect', 'Something went wrong. Please try again.');
        return;
      }
      setConnectedApps((current) => current?.filter((item) => item.clientId !== app.clientId) ?? current);
    } finally {
      setRevokingClientId(null);
    }
  }, []);

  const handleRevoke = useCallback(
    (app: ConnectedApp) => {
      Alert.alert(`Disconnect ${app.name}?`, `${app.name} will no longer be able to see your Ekalight collection.`, [
        { style: 'cancel', text: 'Cancel' },
        {
          onPress: () => {
            void confirmRevoke(app);
          },
          style: 'destructive',
          text: 'Disconnect',
        },
      ]);
    },
    [confirmRevoke],
  );

  const editsEnabled = settingsState.status === 'ready' && settingsState.settings.allowMcpEdits;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
      <ScrollView
        contentContainerStyle={[
          {
            gap: theme.spacing.md,
            paddingBottom: theme.spacing.xxxl + insets.bottom,
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
        showsVerticalScrollIndicator={false}
        testID="use-with-ai"
      >
        <View style={[styles.header, { gap: theme.spacing.md }]}>
          {onBack ? <ChromeBackButton onPress={onBack} testID="use-with-ai-back" /> : null}
          <View style={{ gap: theme.spacing.xxs }}>
            <Text style={theme.typography.display}>Use with AI</Text>
            <Text style={bodySecondary}>
              Ask Claude or ChatGPT about your Ekalight collection: what it&apos;s worth, what you&apos;re missing,
              and how prices moved.
            </Text>
          </View>
        </View>

        <SurfaceCard padding={theme.spacing.md} radius={theme.spacing.xl}>
          <View style={{ gap: theme.spacing.sm }}>
            <Text style={sectionTitle}>CONNECTOR URL</Text>
            {mcpUrl ? (
              <>
                <Text selectable style={[theme.typography.bodyMedium, { color: theme.colors.textPrimary }]} testID="use-with-ai-url">
                  {mcpUrl}
                </Text>
                <Button
                  label={urlCopied ? 'Copied' : 'Copy URL'}
                  onPress={() => {
                    void handleCopyUrl();
                  }}
                  size="lg"
                  testID="use-with-ai-copy-url"
                  variant="outline"
                />
              </>
            ) : (
              <Text style={bodySecondary} testID="use-with-ai-url-missing">
                The connector isn&apos;t available in this build.
              </Text>
            )}
          </View>
        </SurfaceCard>

        <SurfaceCard padding={theme.spacing.md} radius={theme.spacing.xl}>
          <View style={{ gap: theme.spacing.sm }}>
            <Text style={sectionTitle}>CONNECT CLAUDE</Text>
            {CLAUDE_STEPS.map((step, index) => (
              <View key={step} style={[styles.stepRow, { gap: theme.spacing.xs }]} testID={`use-with-ai-step-${index + 1}`}>
                <Text style={[theme.typography.bodyMedium, { color: theme.colors.textPrimary }]}>{index + 1}.</Text>
                <Text style={[theme.typography.body, styles.stepText, { color: theme.colors.textPrimary }]}>{step}</Text>
              </View>
            ))}
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              Using ChatGPT? Add the same URL as a custom connector.
            </Text>
          </View>
        </SurfaceCard>

        <SurfaceCard padding={theme.spacing.md} radius={theme.spacing.xl}>
          <View style={[styles.toggleRow, { gap: theme.spacing.sm }]}>
            <View style={[styles.toggleCopy, { gap: theme.spacing.xxxs }]}>
              <Text style={[theme.typography.bodyMedium, { color: theme.colors.textPrimary }]}>
                Let AI assistants edit my collection
              </Text>
              <Text style={bodySecondary}>
                Lets Claude or ChatGPT add cards, change quantity or condition, and add cards to your Watchlist
                when you ask. They can&apos;t delete anything.
              </Text>
              {settingsState.status === 'failed' ? (
                <Text style={[theme.typography.caption, { color: theme.colors.danger }]} testID="use-with-ai-settings-error">
                  Couldn&apos;t load this setting. Try again later.
                </Text>
              ) : null}
            </View>
            <Switch
              accessibilityLabel="Let AI assistants edit my collection"
              disabled={settingsBusy || settingsState.status !== 'ready'}
              onValueChange={(next) => {
                void handleToggleEdits(next);
              }}
              testID="use-with-ai-edits-toggle"
              value={editsEnabled}
            />
          </View>
        </SurfaceCard>

        <SurfaceCard padding={theme.spacing.md} radius={theme.spacing.xl}>
          <View style={{ gap: theme.spacing.sm }} testID="use-with-ai-connected-apps">
            <Text style={sectionTitle}>CONNECTED APPS</Text>
            {connectedApps === undefined ? null : connectedApps === null ? (
              <Text style={bodySecondary} testID="use-with-ai-connected-fallback">
                To disconnect an assistant, remove Ekalight from the connectors in Claude or ChatGPT settings.
              </Text>
            ) : connectedApps.length === 0 ? (
              <Text style={bodySecondary} testID="use-with-ai-connected-empty">
                No AI apps connected yet.
              </Text>
            ) : (
              connectedApps.map((app, index) => {
                const grantedAt = formatGrantedAt(app.grantedAt);
                return (
                  <View
                    key={app.clientId}
                    style={[
                      styles.appRow,
                      {
                        borderTopColor: theme.colors.gray300,
                        borderTopWidth: index === 0 ? 0 : borderWidths.rule,
                        gap: theme.spacing.xs,
                        paddingTop: index === 0 ? 0 : theme.spacing.sm,
                      },
                    ]}
                    testID={`use-with-ai-app-${app.clientId}`}
                  >
                    <View style={styles.toggleCopy}>
                      <Text style={[theme.typography.bodyMedium, { color: theme.colors.textPrimary }]}>{app.name}</Text>
                      {grantedAt ? (
                        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                          Connected {grantedAt}
                        </Text>
                      ) : null}
                    </View>
                    <Button
                      disabled={revokingClientId !== null}
                      label={revokingClientId === app.clientId ? 'Disconnecting…' : 'Disconnect'}
                      onPress={() => {
                        handleRevoke(app);
                      }}
                      size="md"
                      testID={`use-with-ai-revoke-${app.clientId}`}
                      variant="outline"
                    />
                  </View>
                );
              })
            )}
          </View>
        </SurfaceCard>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  appRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  header: {
    alignItems: 'flex-start',
  },
  safeArea: {
    flex: 1,
  },
  stepRow: {
    flexDirection: 'row',
  },
  stepText: {
    flex: 1,
  },
  toggleCopy: {
    flex: 1,
  },
  toggleRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
});
