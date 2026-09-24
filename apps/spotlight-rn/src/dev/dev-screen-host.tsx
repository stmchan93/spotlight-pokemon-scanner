import { type ReactElement, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import type { SpotlightRepository } from '@spotlight/api-client';
import { Text, colors, textStyles } from '@spotlight/design-system';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { InsightsScreen } from '@/features/insights/screens/insights-screen';
import { ComingUpBlock } from '@/features/meta-feed/components/coming-up-block';
import { HotCardsBlock } from '@/features/meta-feed/components/hot-cards-block';
import { MetaPulseBlock } from '@/features/meta-feed/components/meta-pulse-block';
import { NewsBlock } from '@/features/meta-feed/components/news-block';
import { SetSpotlightBlock } from '@/features/meta-feed/components/set-spotlight-block';
import {
  CALENDAR_BLOCK_LIMIT,
  NEWS_FEED_BLOCK_LIMIT,
  useCalendar,
  useHotCards,
  useMetaExposure,
  useMetaPulse,
  useNewsFeed,
  useSetSpotlight,
} from '@/features/meta-feed/hooks/use-meta-feed';
import { CalendarScreen } from '@/features/meta-feed/screens/calendar-screen';
import { MetaGroupScreen } from '@/features/meta-feed/screens/meta-group-screen';
import { MetaScreen } from '@/features/meta-feed/screens/meta-screen';
import { NewsScreen } from '@/features/meta-feed/screens/news-screen';
import { SetSpotlightScreen } from '@/features/meta-feed/screens/set-spotlight-screen';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { TopTrendsBlock } from '@/features/social/components/top-trends-block';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { setDevFeedItemsOverride } from '@/features/social/social-service';
import { useTopMovers } from '@/features/social/use-top-movers';
import { TargetPriceSheet } from '@/features/wishlist/components/target-price-sheet';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';
import { createDevRepository, DEV_SEALED_CARD_ID } from '@/dev/dev-repository';
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
  // Sealed product PDP (ETB): no number/configurator/add/watch; served by the
  // dev repository's sealed override, not mock-data.
  'card-detail-sealed': () => (
    <CardDetailScreen cardId={DEV_SEALED_CARD_ID} onBack={() => undefined} />
  ),
  // Feed data comes from the social-service override installed on mount below,
  // not the mock repository — the feed reads Supabase-direct.
  feed: () => <FeedScreen />,
  'feed-empty': () => <FeedScreen />,
  insights: () => <InsightsScreen />,
  portfolio: () => <PortfolioScreen />,
  // The Top Trends section alone (Figma 4969:4101), fed by the dev
  // repository's `getTopMovers` — the feed route also carries it, but this
  // isolates the block for a tight diff against the "Title content" frame.
  'top-trends': () => <DevTopTrendsScreen />,
  // The meta feed blocks alone, in feed order, fed by the mock
  // repository's meta feed reads (docs/meta-feed-mockup/Main.dc.html). The
  // feed route carries them too, around Top Trends.
  'meta-blocks': () => <DevMetaBlocksScreen />,
  // The pages those blocks open (docs/meta-feed-mockup/Meta, Set, News.dc.html;
  // v2/MetaV4, GroupV6, CalendarV5.dc.html).
  meta: () => <MetaScreen onBack={() => undefined} onOpenGroup={() => undefined} />,
  'meta-group': () => (
    <MetaGroupScreen
      groupKey="vintage:graded:psa10:pop_le_50"
      onBack={() => undefined}
      onOpenCard={() => undefined}
    />
  ),
  calendar: () => <CalendarScreen onBack={() => undefined} onOpenEvent={() => undefined} />,
  'set-spotlight': () => (
    <SetSpotlightScreen onBack={() => undefined} onOpenCard={() => undefined} setId="cel25" />
  ),
  news: () => <NewsScreen onBack={() => undefined} onOpenCard={() => undefined} />,
  wishlist: () => <WishlistScreen />,
  // The watchlist target sheet over the PDP: the optional post-Watch prompt
  // and the edit sheet a Watchlist long-press opens.
  'target-sheet': () => <DevTargetSheetScreen mode="afterWatch" />,
  'target-sheet-edit': () => <DevTargetSheetScreen mode="edit" />,
};

function DevTargetSheetScreen({ mode }: { mode: 'afterWatch' | 'edit' }) {
  return (
    <>
      <CardDetailScreen cardId="sm7-1" onBack={() => undefined} />
      <TargetPriceSheet
        entry={{
          cardId: 'sm7-1',
          cardNumber: '001/096',
          currencyCode: 'USD',
          favoritedAt: '2026-09-23T00:00:00.000Z',
          imageUrl: 'https://images.scrydex.com/pokemon/sm7-1/small',
          isOwned: false,
          largeImageUrl: null,
          marketPrice: 12.4,
          name: 'Treecko',
          setName: 'Celestial Storm',
          smallImageUrl: null,
          targetPriceCents: mode === 'edit' ? 1000 : null,
        }}
        mode={mode}
        onClose={() => undefined}
        onSubmit={async () => 'saved'}
      />
    </>
  );
}

function DevTopTrendsScreen() {
  const { movers, loading } = useTopMovers();
  return (
    <ScrollView
      contentContainerStyle={styles.topTrendsContent}
      style={styles.topTrends}
      testID="dev-top-trends"
    >
      <TopTrendsBlock loading={loading} movers={movers} onPressCard={() => undefined} />
    </ScrollView>
  );
}

function DevMetaBlocksScreen() {
  const pulse = useMetaPulse();
  const exposure = useMetaExposure();
  const hot = useHotCards();
  const spotlight = useSetSpotlight();
  const calendar = useCalendar({ limit: CALENDAR_BLOCK_LIMIT });
  const news = useNewsFeed({ limit: NEWS_FEED_BLOCK_LIMIT });
  const noop = () => undefined;
  return (
    <ScrollView
      contentContainerStyle={styles.topTrendsContent}
      style={styles.topTrends}
      testID="dev-meta-blocks"
    >
      <MetaPulseBlock exposure={exposure.data} onOpenGroup={noop} onOpenMeta={noop} pulse={pulse.data} />
      <HotCardsBlock hot={hot.data} onPressCard={noop} />
      <SetSpotlightBlock onOpenLink={noop} onOpenSet={noop} onPressCard={noop} spotlight={spotlight.data} />
      <ComingUpBlock feed={calendar.data} onOpenCalendar={noop} onOpenEvent={noop} />
      <NewsBlock feed={news.data} onOpenLink={noop} onOpenNews={noop} />
    </ScrollView>
  );
}

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
  topTrends: {
    backgroundColor: colors.gray0,
    flex: 1,
  },
  // Clear the pinned status bar so the title row lands where the feed puts it.
  topTrendsContent: {
    paddingTop: 59,
  },
});
