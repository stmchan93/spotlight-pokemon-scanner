import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { VendorSettings, VendorTierKey } from '@spotlight/api-client';
import { Button, SurfaceCard, Text, TextField, colors, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { useVendorSettings } from '@/features/vendor/use-vendor-settings';
import { SELL_PERCENT_MAX, SELL_PERCENT_MIN } from '@/features/vendor/vendor-pricing';

const TIER_ROWS: { key: VendorTierKey; label: string }[] = [
  { key: 'bulk', label: 'Bulk (under $5)' },
  { key: 'under50', label: '$5 – $50' },
  { key: 'over50', label: '$50 and up' },
  { key: 'slab', label: 'Slabs' },
];

type Draft = {
  buyPercent: string;
  sellPercent: string;
  tiersEnabled: boolean;
  tiers: Record<VendorTierKey, string>;
};

function draftFrom(settings: VendorSettings): Draft {
  return {
    buyPercent: String(settings.buyPercent),
    sellPercent: String(settings.sellPercent),
    tiersEnabled: settings.tiersEnabled,
    tiers: {
      bulk: String(settings.tiers.bulk),
      under50: String(settings.tiers.under50),
      over50: String(settings.tiers.over50),
      slab: String(settings.tiers.slab),
    },
  };
}

function parsePercent(value: string, min: number, max: number): number | null {
  const parsed = Number(value.trim().replace('%', ''));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.round(parsed * 100) / 100 : null;
}

/** Validated patch, or the first problem as a message. */
export function vendorSettingsPatchFromDraft(draft: Draft): { patch: Partial<VendorSettings> } | { error: string } {
  const sellPercent = parsePercent(draft.sellPercent, SELL_PERCENT_MIN, SELL_PERCENT_MAX);
  if (sellPercent == null) {
    return { error: `Sell price must be ${SELL_PERCENT_MIN}–${SELL_PERCENT_MAX}% of market.` };
  }
  const buyPercent = parsePercent(draft.buyPercent, 1, 100);
  if (!draft.tiersEnabled && buyPercent == null) {
    return { error: 'Buy price must be 1–100% of market.' };
  }
  const tiers = {} as Record<VendorTierKey, number>;
  for (const { key, label } of TIER_ROWS) {
    const value = parsePercent(draft.tiers[key], 1, 100);
    if (value == null) {
      if (draft.tiersEnabled) {
        return { error: `${label} must be 1–100% of market.` };
      }
      continue;
    }
    tiers[key] = value;
  }
  return {
    patch: {
      sellPercent,
      tiersEnabled: draft.tiersEnabled,
      ...(buyPercent != null ? { buyPercent } : {}),
      ...(Object.keys(tiers).length > 0 ? { tiers: tiers as VendorSettings['tiers'] } : {}),
    },
  };
}

export function VendorSettingsScreen({ onBack }: { onBack?: () => void }) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { settings, loaded, save } = useVendorSettings();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string }>(
    { kind: 'idle' },
  );

  // The first server read replaces the defaults the form opened with.
  useEffect(() => {
    if (loaded) {
      setDraft(draftFrom(settings));
    }
  }, [loaded, settings]);

  const sectionTitle = [theme.typography.titleSmall, { color: theme.colors.textPrimary }];
  const bodySecondary = [theme.typography.body, { color: theme.colors.textSecondary }];

  const handleSave = async () => {
    const result = vendorSettingsPatchFromDraft(draft);
    if ('error' in result) {
      setStatus({ kind: 'error', message: result.error });
      return;
    }
    setStatus({ kind: 'saving' });
    const ok = await save(result.patch);
    setStatus(ok ? { kind: 'saved' } : { kind: 'error', message: "Couldn't save. Try again." });
  };

  const percentField = (label: string, value: string, onChange: (next: string) => void, testID: string) => (
    <TextField
      keyboardType="decimal-pad"
      label={label}
      onChangeText={(next) => {
        setStatus({ kind: 'idle' });
        onChange(next);
      }}
      testID={testID}
      trailing={<Text style={bodySecondary}>%</Text>}
      value={value}
    />
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
      <ScrollView
        contentContainerStyle={{
          gap: theme.spacing.md,
          paddingBottom: theme.spacing.xxxl + insets.bottom,
          paddingHorizontal: theme.layout.pageGutter,
          paddingTop: theme.layout.pageTopInset,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        testID="vendor-settings"
      >
        <View style={[styles.header, { gap: theme.spacing.md }]}>
          {onBack ? <ChromeBackButton onPress={onBack} testID="vendor-settings-back" /> : null}
          <View style={{ gap: theme.spacing.xxs }}>
            <Text style={theme.typography.display}>Vendor pricing</Text>
            <Text style={bodySecondary}>
              Your buy and sell prices as a share of TCGplayer market. Turn them on in the scanner from the
              TOTAL menu: each scan then shows market → your price.
            </Text>
          </View>
        </View>

        <SurfaceCard padding={theme.spacing.md} radius={theme.spacing.xl}>
          <View style={{ gap: theme.spacing.sm }}>
            <Text style={sectionTitle}>BUY PRICE</Text>
            <View style={[styles.toggleRow, { gap: theme.spacing.sm }]}>
              <View style={styles.toggleCopy}>
                <Text style={[theme.typography.bodyMedium, { color: theme.colors.textPrimary }]}>Price by tier</Text>
                <Text style={bodySecondary}>Pay less for bulk and more for big cards.</Text>
              </View>
              <Switch
                accessibilityLabel="Price by tier"
                onValueChange={(next) => {
                  setStatus({ kind: 'idle' });
                  setDraft((current) => ({ ...current, tiersEnabled: next }));
                }}
                testID="vendor-settings-tiers-toggle"
                value={draft.tiersEnabled}
              />
            </View>
            {draft.tiersEnabled
              ? TIER_ROWS.map(({ key, label }) => (
                <View key={key}>
                  {percentField(
                    label,
                    draft.tiers[key],
                    (next) => setDraft((current) => ({ ...current, tiers: { ...current.tiers, [key]: next } })),
                    `vendor-settings-tier-${key}`,
                  )}
                </View>
              ))
              : percentField(
                'Buy at',
                draft.buyPercent,
                (next) => setDraft((current) => ({ ...current, buyPercent: next })),
                'vendor-settings-buy',
              )}
          </View>
        </SurfaceCard>

        <SurfaceCard padding={theme.spacing.md} radius={theme.spacing.xl}>
          <View style={{ gap: theme.spacing.sm }}>
            <Text style={sectionTitle}>SELL PRICE</Text>
            <Text style={bodySecondary}>
              {`For your own price tags. 100% = at market (${SELL_PERCENT_MIN}–${SELL_PERCENT_MAX}%).`}
            </Text>
            {percentField(
              'Sell at',
              draft.sellPercent,
              (next) => setDraft((current) => ({ ...current, sellPercent: next })),
              'vendor-settings-sell',
            )}
          </View>
        </SurfaceCard>

        {status.kind === 'error' ? (
          <Text style={[theme.typography.caption, { color: theme.colors.danger }]} testID="vendor-settings-error">
            {status.message}
          </Text>
        ) : null}
        <Button
          disabled={status.kind === 'saving'}
          label={status.kind === 'saved' ? 'Saved' : status.kind === 'saving' ? 'Saving…' : 'Save'}
          onPress={() => {
            void handleSave();
          }}
          size="lg"
          testID="vendor-settings-save"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'flex-start',
  },
  safeArea: {
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
