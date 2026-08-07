import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { GlassSurface, Text, useSpotlightTheme } from '@spotlight/design-system';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScanNavSymbol } from '@/components/nav-tab-symbols';
import {
  cardDetailPreviewFromInventoryEntry,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  defaultLaneFromPreview,
  prefetchCardDetail,
} from '@/features/cards/card-detail-prefetch';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { useAppServices } from '@/providers/app-providers';

/**
 * Collection as a native tab, plus the Scan entry point that used to be the
 * bar's middle slot.
 *
 * The button is local to this route rather than added to `PortfolioScreen`,
 * because that component is shared with the live pager and must not grow a
 * second scan affordance while both navigation shells exist. If this shape
 * wins, the button moves into the screen and this file goes back to being thin.
 *
 * It sits ABOVE the native tab bar, not in it — the bar cannot host a
 * push-button (see `_layout.tsx` for the JUMP_TO constraint).
 */
export default function NativeTabsCollection() {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();

  return (
    <NativeTabsPageBridge page="portfolio">
      <View style={styles.fill}>
        <PortfolioScreen
          onOpenInventoryEntry={(entry) => {
            const preview = cardDetailPreviewFromInventoryEntry(entry);
            prefetchCardDetail(
              spotlightRepository,
              entry.cardId,
              defaultLaneFromPreview(preview),
              preview.largeImageUrl ?? preview.imageUrl,
            );
            router.push({
              pathname: '/cards/[cardId]',
              params: {
                cardId: entry.cardId,
                entryId: entry.id,
                previewId: saveCardDetailPreviewFromInventoryEntry(entry),
              },
            });
          }}
        />

        <View pointerEvents="box-none" style={styles.scanSlot}>
          <Pressable
            accessibilityLabel="Scan a card"
            accessibilityRole="button"
            // See the DM inbox for why `as never`: expo-router's typed-route
            // union lives in a gitignored generated file that only refreshes
            // while the dev server runs, so a new route isn't in it yet.
            onPress={() => router.push('/native-scan' as never)}
            style={({ pressed }) => [styles.scanButton, { opacity: pressed ? 0.85 : 1 }]}
            testID="native-tabs-scan-button"
          >
            <GlassSurface
              fallbackColor={theme.colors.gray900}
              glassEffectStyle="regular"
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
            />
            <ScanNavSymbol color={theme.colors.gray0} size={20} />
            <Text style={[theme.typography.label, { color: theme.colors.gray0 }]}>SCAN</Text>
          </Pressable>
        </View>
      </View>
    </NativeTabsPageBridge>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  scanButton: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  // Clear of the native tab bar, which owns the very bottom of the screen.
  scanSlot: {
    alignItems: 'center',
    bottom: 24,
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
