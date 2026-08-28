import { type ReactElement, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import type { SpotlightRepository } from '@spotlight/api-client';
import { Text, colors, textStyles } from '@spotlight/design-system';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { InsightsScreen } from '@/features/insights/screens/insights-screen';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { setDevFeedItemsOverride } from '@/features/social/social-service';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';
import { createDevRepository } from '@/dev/dev-repository';
import { devFeedItems } from '@/dev/dev-feed-data';
import { AppProviders } from '@/providers/app-providers';

/**
 * Dev-only host behind `spotlight://dev/<screen>` (see `app/dev/[screen].tsx`).
 *
 * Renders the REAL container screens inside a nested `AppProviders` whose
 * repository is the seeded mock from `dev-repository.ts` — `useAppServices()`
 * reads the nearest provider, so the subtree fetches deterministic data while
 * production paths stay untouched. Used by the /sync-design workflow to take
 * pixel-reproducible simulator screenshots (registry entries are listed in
 * design-map.json at the repo root).
 *
 * Adding a screen = one registry entry below + a design-map.json deepLink.
 */
const devScreens: Record<string, () => ReactElement> = {
  // Card must exist in mock-data's `mockCardDetails` (sm7-1, mcdonalds25-21,
  // xyp-111) or the PDP renders its error state. Two PDP states, per the Figma
  // sections: UNOWNED browse (ADD ITEM/SHARE footer, trend list) and OWNED
  // edit-in-place (Inventory panel, SAVE/CANCEL footer).
  'card-detail': () => <CardDetailScreen cardId="sm7-1" onBack={() => undefined} />,
  'card-detail-owned': () => (
    <CardDetailScreen cardId="mcdonalds25-21" onBack={() => undefined} />
  ),
  // Feed data comes from the social-service override installed on mount below,
  // not the mock repository — the feed reads Supabase-direct.
  feed: () => <FeedScreen />,
  'feed-empty': () => <FeedScreen />,
  insights: () => <InsightsScreen />,
  portfolio: () => <PortfolioScreen />,
  wishlist: () => <WishlistScreen />,
};

export function DevScreenHost({ screen }: { screen: string }) {
  const [repository, setRepository] = useState<SpotlightRepository | null>(null);

  // Installed during render, not in an effect: a child screen's data effect
  // fires before this component's own effects, so an effect-installed
  // override misses the child's first fetch.
  if (screen === 'feed' || screen === 'feed-empty') {
    setDevFeedItemsOverride(screen === 'feed' ? devFeedItems : []);
  }

  useEffect(() => {
    let cancelled = false;
    // The PDP's module-level caches are keyed by cardId only — clear them so a
    // real session's data never bleeds into a dev screenshot (or vice versa).
    clearCardDetailCache();
    void createDevRepository().then((repo) => {
      if (!cancelled) {
        setRepository(repo);
      }
    });
    return () => {
      cancelled = true;
      clearCardDetailCache();
      setDevFeedItemsOverride(null);
    };
  }, [screen]);

  const renderScreen = devScreens[screen];

  if (!renderScreen) {
    return (
      <View style={styles.fallback}>
        <Text style={textStyles.headline}>Unknown dev screen “{screen}”</Text>
        <Text style={styles.fallbackBody}>
          Registered: {Object.keys(devScreens).sort().join(', ')}
        </Text>
      </View>
    );
  }

  if (!repository) {
    // Deliberately blank (no spinner) so a too-early screenshot is obviously
    // wrong rather than subtly mid-animation.
    return <View style={styles.fallback} />;
  }

  return (
    <AppProviders sessionOwnerKey="dev-screens" spotlightRepository={repository}>
      <NativeTabsPageBridge page="portfolio">
        <StatusBar style="dark" />
        {renderScreen()}
      </NativeTabsPageBridge>
    </AppProviders>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    flex: 1,
    gap: 8,
    justifyContent: 'center',
    padding: 24,
  },
  fallbackBody: {
    ...textStyles.body,
    color: colors.gray600,
    textAlign: 'center',
  },
});
