import { type ReactElement, useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import type { SpotlightRepository } from '@spotlight/api-client';
import { Text, colors, textStyles } from '@spotlight/design-system';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { SignedOutFlow } from '@/features/auth/components/signed-out-flow';
import { AccountScreen } from '@/features/auth/screens/account-screen';
import { ChangePasswordScreen } from '@/features/auth/screens/change-password-screen';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { ScanCandidateReviewScreen } from '@/features/cards/screens/scan-candidate-review-screen';
import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';
import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { ExpansionDetailScreen } from '@/features/catalog/screens/expansion-detail-screen';
import { EventDetailScreen } from '@/features/events/screens/event-detail-screen';
import { EventsScreen } from '@/features/events/screens/events-screen';
import { InsightsScreen } from '@/features/insights/screens/insights-screen';
import { InventoryBrowserScreen } from '@/features/inventory/screens/inventory-browser-screen';
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
import { SalesHistoryScreen } from '@/features/portfolio/screens/sales-history-screen';
import { setDevProfileOverrides } from '@/features/profile/profile-service';
import { EditProfileScreen } from '@/features/profile/screens/edit-profile-screen';
import { FollowListScreen } from '@/features/profile/screens/follow-list-screen';
import { PublicProfileScreen } from '@/features/profile/screens/public-profile-screen';
import { TopTrendsBlock } from '@/features/social/components/top-trends-block';
import { setDevDmOverrides } from '@/features/social/dm-service';
import { BlockedAccountsScreen } from '@/features/social/screens/blocked-accounts-screen';
import { DmInboxScreen } from '@/features/social/screens/dm-inbox-screen';
import { DmThreadScreen } from '@/features/social/screens/dm-thread-screen';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { NewPostScreen } from '@/features/social/screens/new-post-screen';
import { NotificationsScreen } from '@/features/social/screens/notifications-screen';
import { PostDetailScreen } from '@/features/social/screens/post-detail-screen';
import { setDevFeedItemsOverride, setDevSocialOverrides } from '@/features/social/social-service';
import { useTopMovers } from '@/features/social/use-top-movers';
import { TargetPriceSheet } from '@/features/wishlist/components/target-price-sheet';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';
import {
  createDevRepository,
  DEV_EXPANSION_ID,
  DEV_EXPANSION_NAME,
  DEV_GRADED_CARD_ID,
  DEV_SEALED_CARD_ID,
} from '@/dev/dev-repository';
import { devFeedItems } from '@/dev/dev-feed-data';
import { candidateFor, DevScannerScreen, devScannerPricingMatrices } from '@/dev/dev-scanner-screen';
import { DEV_SCAN_BINDER, DEV_SCAN_SINGLE } from '@/dev/dev-scanner-fixtures';
import {
  DEV_CONVERSATION_ID,
  DEV_POST_ID,
  DEV_PROFILE_HANDLE,
  DEV_PROFILE_ID,
  devDmOverrides,
  devProfile,
  devProfileOverrides,
  devSocialOverrides,
} from '@/dev/dev-social-data';
import { AppProviders } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

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
  // Figma 5476:7127 / 5528:730 — mock feed from MockSpotlightRepository.
  events: () => <EventsScreen />,
  'event-detail': () => <EventDetailScreen eventId="hawaii-2026-10" onBack={() => undefined} />,
  'card-detail-owned': () => (
    <CardDetailScreen cardId="mcdonalds25-21" onBack={() => undefined} />
  ),
  // Sealed product PDP (ETB): no number/configurator/add/watch; served by the
  // dev repository's sealed override, not mock-data.
  'card-detail-sealed': () => (
    <CardDetailScreen cardId={DEV_SEALED_CARD_ID} onBack={() => undefined} />
  ),
  // App Store screenshots: the PDP opened on the PSA lane, so the Price Trend
  // block shows the full PSA 10 → PSA 1 ladder under the eBay mark. Served by
  // the dev repository's graded override (gradedReference picks the lane).
  'price-trend-graded': () => (
    <CardDetailScreen cardId={DEV_GRADED_CARD_ID} onBack={() => undefined} />
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
      groupKey="vintage:graded:psa10"
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
  // Zero watches: the teaching empty state (repository built without favorites).
  'watchlist-empty': () => <WishlistScreen />,
  // The watchlist target sheet over the PDP: the optional post-Watch prompt
  // and the edit sheet a Watchlist long-press opens.
  'target-sheet': () => <DevTargetSheetScreen mode="afterWatch" />,
  'target-sheet-edit': () => <DevTargetSheetScreen mode="edit" />,
  // App Store screenshots: the real scanner over a still photo (the simulator
  // has no camera), tray pre-filled from dev-scanner-fixtures.ts. Single card
  // in the reticle, and the 3x3 binder page with all nine rows.
  scanner: () => <DevScannerScreen mode="single" />,
  'scanner-binder': () => <DevScannerScreen mode="binder" />,
  // ── Typography audit routes (2026-10-18). Repository-backed screens read the
  // seeded mock; the Supabase-backed social screens read the fixtures installed
  // through the services' setDev*Overrides seams (see dev-social-data.ts).
  inventory: () => <InventoryBrowserScreen onBack={noop} onOpenAddCard={noop} onOpenEntry={noop} />,
  'sales-history': () => <SalesHistoryScreen onBack={noop} />,
  // Form fields come from the auth provider's test user (EXPO_PUBLIC_DEV_SCREENS=1
  // signs it in), so name is filled and bio/location/link show their placeholders.
  'edit-profile': () => <EditProfileScreen />,
  'public-profile': () => <PublicProfileScreen handle={DEV_PROFILE_HANDLE} onBack={noop} />,
  'follow-list': () => <FollowListScreen mode="followers" onBack={noop} userID={DEV_PROFILE_ID} />,
  'post-detail': () => <PostDetailScreen postId={DEV_POST_ID} />,
  'new-post': () => <NewPostScreen />,
  notifications: () => <NotificationsScreen />,
  messages: () => <DmInboxScreen />,
  conversation: () => (
    <DmThreadScreen
      conversationId={DEV_CONVERSATION_ID}
      otherUser={{
        avatarUrl: null,
        displayName: devProfile.displayName,
        handle: devProfile.handle,
        userId: devProfile.userID,
      }}
      title={devProfile.displayName ?? undefined}
    />
  ),
  // "Treecko" matches five mock catalog rows; `onSelectGame` turns the browse grid on.
  'catalog-search': () => (
    <CatalogSearchScreen initialQuery="Treecko" onClose={noop} onOpenCard={noop} onSelectGame={noop} />
  ),
  'expansion-browser': () => <ExpansionBrowserScreen onClose={noop} onSelectGame={noop} />,
  'expansion-detail': () => (
    <ExpansionDetailScreen
      expansionId={DEV_EXPANSION_ID}
      expansionName={DEV_EXPANSION_NAME}
      onClose={noop}
      onOpenCard={noop}
    />
  ),
  login: () => <DevLoginScreen />,
  account: () => <AccountScreen />,
  'blocked-accounts': () => <BlockedAccountsScreen onBack={noop} />,
  'change-password': () => <ChangePasswordScreen />,
  'scan-review': () => <DevScanReviewScreen />,
};

function noop() {
  return undefined;
}

// Mirrors app/(modal)/login.tsx: the signed-out stepper over the root auth
// provider's actions. Nothing is called until a button is tapped.
function DevLoginScreen() {
  const auth = useAuth();
  return (
    <SignedOutFlow
      appleSignInAvailable={auth.appleSignInAvailable}
      configurationIssue={auth.configurationIssue}
      emailAuth={auth}
      errorMessage={auth.errorMessage}
      isBusy={auth.isBusy}
      onAppleSignIn={noop}
      onClose={noop}
      onGoogleSignIn={noop}
    />
  );
}

// The "N cards found" review the PDP opens from a scan: the hero fixture as the
// closest match over its own still, the binder cards as the similar rail.
function DevScanReviewScreen() {
  const similar = DEV_SCAN_BINDER.slice(0, 5).map(candidateFor);
  return (
    <ScanCandidateReviewScreen
      candidates={similar}
      closestMatch={candidateFor(DEV_SCAN_SINGLE)}
      normalizedImageDimensions={{ width: 630, height: 880 }}
      normalizedImageUri={Image.resolveAssetSource(DEV_SCAN_SINGLE.image)?.uri ?? null}
      onBack={noop}
      onOpenCandidate={noop}
      totalCount={similar.length + 1}
    />
  );
}

// Screens whose data comes from the Supabase-layer services rather than the
// repository. Their overrides are installed during render (see DevScreenHost).
const socialOverrideScreens = new Set([
  'public-profile',
  'follow-list',
  'post-detail',
  'notifications',
  'messages',
  'conversation',
  'blocked-accounts',
]);

function setSocialOverridesInstalled(installed: boolean) {
  setDevSocialOverrides(installed ? devSocialOverrides : null);
  setDevProfileOverrides(installed ? devProfileOverrides : null);
  setDevDmOverrides(installed ? devDmOverrides : null);
}

function DevTargetSheetScreen({ mode }: { mode: 'afterWatch' | 'edit' }) {
  return (
    <>
      <CardDetailScreen cardId="sm7-1" onBack={() => undefined} />
      <TargetPriceSheet
        entry={{
          cardId: 'sm7-1',
          watchVariant: null,
          watchKey: 'sm7-1|',
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
  if (socialOverrideScreens.has(screen)) {
    setSocialOverridesInstalled(true);
  }

  useEffect(() => {
    let cancelled = false;
    // The PDP's module-level caches are keyed by cardId only — clear them so a
    // real session's data never bleeds into a dev screenshot (or vice versa).
    clearCardDetailCache();
    void createDevRepository({
      rawPricingMatrices: devScannerPricingMatrices,
      seedFavorites: screen !== 'watchlist-empty',
    }).then((repo) => {
      if (!cancelled) {
        setRepository(repo);
      }
    });
    return () => {
      cancelled = true;
      clearCardDetailCache();
      setDevFeedItemsOverride(null);
      setSocialOverridesInstalled(false);
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
