import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Share, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShareIos } from 'iconoir-react-native';

import type { NewsItem, SetSpotlight, SetSpotlightCard } from '@spotlight/api-client';
import {
  DeltaPill,
  GlassNavBubble,
  NewsRow,
  RankedCardRow,
  SegmentedControl,
  SkeletonBlock,
  StateCard,
  Text,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  radii,
  spacing,
  useSpotlightTheme,
  VideoTile,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import {
  formatCount,
  formatReleaseMonth,
  formatSignedPercent,
  gradeLabel,
  newsSourceLine,
  videoMetaLine,
  formatDuration,
} from '@/features/meta-feed/screens/components/meta-format';
import { MetaPageHeader, MetaSection } from '@/features/meta-feed/screens/components/meta-page-chrome';
import { useSetSpotlightPageData } from '@/features/meta-feed/screens/components/meta-page-data';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { formatCompactCurrency, formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

type TopTab = 'price' | 'movers' | 'psa10';

const TOP_TABS: readonly { label: string; value: TopTab }[] = [
  { label: 'By price', value: 'price' },
  { label: 'Movers', value: 'movers' },
  { label: 'PSA 10', value: 'psa10' },
];

/** Rows shown before "Show all". */
const TOP_COLLAPSED_COUNT = 5;
const SET_LOGO_SIZE = 64;
const CALLOUT_ART = { height: 78, width: 56 } as const;

function listFor(spotlight: SetSpotlight, tab: TopTab): SetSpotlightCard[] {
  if (tab === 'movers') return spotlight.topMovers;
  if (tab === 'psa10') return spotlight.topPsa10;
  return spotlight.topByPrice;
}

export function setMetaLine(set: SetSpotlight['set']): string {
  return [set.series, formatReleaseMonth(set.releaseDate), `${formatCount(set.cardCount)} cards`]
    .filter(Boolean)
    .join(' · ');
}

export type SetSpotlightScreenProps = {
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
  /** Omitted = this week's pick. */
  setId?: string | null;
};

/**
 * Set spotlight page (docs/meta-feed-mockup/Set.dc.html): a set's value, its
 * top 10 by price / movers / PSA 10, the week's callout, and videos + news
 * tagged to it. Sections with nothing to show are left out.
 */
export function SetSpotlightScreen({ onBack, onOpenCard, setId }: SetSpotlightScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const { data: spotlight, loading, refresh, status } = useSetSpotlightPageData({ setId: setId ?? null });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const handleShare = useCallback(() => {
    if (!spotlight) return;
    const top = spotlight.topByPrice[0];
    const lines = [`${spotlight.set.name} on Ekalight`];
    if (top) {
      lines.push(`Top card: ${top.name} · ${formatCompactCurrency(top.priceNow, top.currencyCode)}`);
    }
    void Share.share({ message: lines.join('\n') }).catch(() => {});
  }, [spotlight]);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}>
      <MetaPageHeader
        onBack={onBack}
        rightAccessory={
          spotlight ? (
            <GlassNavBubble accessibilityLabel="Share set" onPress={handleShare} size="medium" testID="set-spotlight-share">
              <ShareIos
                color={theme.colors.gray900}
                height={glassNavBubbleGlyphSize}
                strokeWidth={glassNavBubbleGlyphStrokeWidth}
                width={glassNavBubbleGlyphSize}
              />
            </GlassNavBubble>
          ) : null
        }
        testID="set-spotlight-header"
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} />}
        testID="set-spotlight-scroll"
      >
        {spotlight ? (
          <SetSpotlightBody loading={loading} onOpenCard={onOpenCard} spotlight={spotlight} />
        ) : status === 'loading' ? (
          <View style={styles.skeleton} testID="set-spotlight-loading">
            <SkeletonBlock height={SET_LOGO_SIZE} radius={radii.lg} width={SET_LOGO_SIZE} />
            <SkeletonBlock height={72} radius={radii.md} />
            {Array.from({ length: 5 }).map((_, index) => (
              <SkeletonBlock key={index} height={50} radius={radii.sm} />
            ))}
          </View>
        ) : (
          <View style={styles.stateWrap}>
            {status === 'disabled' ? (
              <StateCard
                message="Set spotlights aren't switched on yet. Check back soon."
                testID="set-spotlight-disabled"
                title="Coming soon"
                variant="muted"
              />
            ) : (
              <StateCard
                actionLabel="Try again"
                actionTestID="set-spotlight-retry"
                message="We couldn't load this set. Check your connection and try again."
                onActionPress={() => void refresh()}
                testID="set-spotlight-error"
                title="This set isn't available right now"
              />
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SetSpotlightBody({
  loading,
  onOpenCard,
  spotlight,
}: {
  loading: boolean;
  onOpenCard: (cardId: string) => void;
  spotlight: SetSpotlight;
}) {
  const theme = useSpotlightTheme();
  const { set } = spotlight;
  const tabs = useMemo(() => TOP_TABS.filter((tab) => listFor(spotlight, tab.value).length > 0), [spotlight]);
  const [tab, setTab] = useState<TopTab>('price');
  const [expanded, setExpanded] = useState(false);
  const activeTab = tabs.some((candidate) => candidate.value === tab) ? tab : tabs[0]?.value ?? 'price';
  const cards = listFor(spotlight, activeTab);
  const visibleCards = expanded ? cards : cards.slice(0, TOP_COLLAPSED_COUNT);

  const calloutArt = useMemo(() => {
    if (!spotlight.callout) return null;
    const all = [...spotlight.topPsa10, ...spotlight.topByPrice, ...spotlight.topMovers];
    return all.find((card) => card.cardId === spotlight.callout?.cardId)?.imageUrl ?? null;
  }, [spotlight]);

  // Which sections render, in order — the last one drops its closing band.
  const sections = [
    cards.length > 0 ? 'top' : null,
    spotlight.callout ? 'callout' : null,
    spotlight.videos.length > 0 ? 'videos' : null,
    spotlight.news.length > 0 ? 'news' : null,
  ].filter((section): section is string => section !== null);
  const lastSection = sections[sections.length - 1];

  const openItem = (item: NewsItem) => void openLinkOut(item.url);

  return (
    <View style={loading ? styles.stale : null} testID="set-spotlight-content">
      <View style={styles.setHeader}>
        <SetLogo code={set.code} logoUrl={set.logoUrl} name={set.name} />
        <View style={styles.setCopy}>
          <Text accessibilityRole="header" style={theme.typography.titleLarge} testID="set-spotlight-name">
            {set.name}
          </Text>
          <Text style={theme.typography.captionMedium}>{setMetaLine(set)}</Text>
        </View>
      </View>
      <View style={[styles.statRow, sections.length > 0 ? { borderBottomColor: theme.colors.gray100, borderBottomWidth: spacing.xxxs } : null]}>
        <StatTile
          change={set.valueChangePercent7d}
          label="Set value"
          testID="set-stat-value"
          value={formatCompactCurrency(set.valueNow)}
        />
        <StatTile
          change={set.psa10ChangePercent7d}
          label="PSA 10 value"
          testID="set-stat-psa10"
          value={set.psa10ValueNow == null ? '—' : formatCompactCurrency(set.psa10ValueNow)}
        />
        <StatTile
          caption="on Ekalight"
          label="In collections"
          testID="set-stat-collectors"
          value={formatCount(set.collectorsCount)}
        />
      </View>

      {cards.length > 0 ? (
        <MetaSection caption="7-day change" showBand={lastSection !== 'top'} testID="set-top" title="Top 10 cards">
          {tabs.length > 1 ? (
            <View style={styles.tabs}>
              <SegmentedControl
                items={tabs}
                onChange={(next) => {
                  setTab(next);
                  setExpanded(false);
                }}
                testID="set-top-tabs"
                tone="inverted"
                value={activeTab}
              />
            </View>
          ) : null}
          {visibleCards.map((card, index) => {
            const grade = gradeLabel(card.grader, card.grade);
            return (
              <RankedCardRow
                key={`${activeTab}:${card.cardId}:${card.grader ?? ''}:${card.grade ?? ''}`}
                changeLabel={card.changePercent7d == null ? null : formatSignedPercent(card.changePercent7d)}
                changePercent={card.changePercent7d}
                divider={index < visibleCards.length - 1 || cards.length > visibleCards.length}
                imageUrl={card.imageUrl}
                name={card.name}
                onPress={() => onOpenCard(card.cardId)}
                priceLabel={formatCurrency(card.priceNow, card.currencyCode)}
                rank={index + 1}
                subtitle={[set.name, card.number].filter(Boolean).join(' · ')}
                tag={card.lane === 'graded' ? { label: grade ?? undefined, lane: 'graded' } : null}
                testID={`set-top-card-${card.cardId}`}
              />
            );
          })}
          {cards.length > TOP_COLLAPSED_COUNT ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setExpanded((current) => !current)}
              style={styles.showAll}
              testID="set-top-toggle"
            >
              <Text style={[theme.typography.titleXsmall, { color: theme.colors.brandStrong }]}>
                {expanded ? 'Show fewer' : `Show all ${cards.length}`}
              </Text>
            </Pressable>
          ) : null}
        </MetaSection>
      ) : null}

      {spotlight.callout ? (
        <MetaSection showBand={lastSection !== 'callout'} testID="set-callout" title="What's moving in this set">
          <Pressable
            accessibilityLabel={`${spotlight.callout.title}. ${spotlight.callout.body}`}
            accessibilityRole="button"
            onPress={() => onOpenCard(spotlight.callout!.cardId)}
            style={({ pressed }) => [
              styles.callout,
              { backgroundColor: theme.colors.purple50, opacity: pressed ? 0.9 : 1 },
            ]}
            testID="set-callout-card"
          >
            <View style={[styles.calloutArt, { backgroundColor: theme.colors.gray200 }]}>
              {calloutArt ? (
                <CachedImage cachePolicy={imageCachePolicy.thumbnail} style={styles.fill} uri={calloutArt} />
              ) : null}
            </View>
            <View style={styles.setCopy}>
              <Text style={theme.typography.bodyMedium}>{spotlight.callout.title}</Text>
              <Text style={theme.typography.cardMeta}>{spotlight.callout.body}</Text>
            </View>
          </Pressable>
        </MetaSection>
      ) : null}

      {spotlight.videos.length > 0 ? (
        <MetaSection
          caption="from YouTube channels we follow"
          showBand={lastSection !== 'videos'}
          testID="set-videos"
          title="Top videos"
        >
          <ScrollView
            horizontal
            contentContainerStyle={styles.videoRail}
            showsHorizontalScrollIndicator={false}
            style={styles.videoRailBleed}
            testID="set-videos-rail"
          >
            {spotlight.videos.map((item) => (
              <VideoTile
                key={item.id}
                durationLabel={item.video?.durationSeconds != null ? formatDuration(item.video.durationSeconds) : null}
                imageUrl={item.imageUrl}
                metaLabel={videoMetaLine(item)}
                onPress={() => openItem(item)}
                testID={`set-video-${item.id}`}
                title={item.title}
              />
            ))}
          </ScrollView>
        </MetaSection>
      ) : null}

      {spotlight.news.length > 0 ? (
        <MetaSection showBand={lastSection !== 'news'} testID="set-news" title="In the news">
          {spotlight.news.map((item, index) => (
            <NewsRow
              key={item.id}
              divider={index < spotlight.news.length - 1}
              imageUrl={item.imageUrl}
              onPress={() => openItem(item)}
              sourceLabel={newsSourceLine(item)}
              tags={item.tags}
              testID={`set-news-${item.id}`}
              title={item.title}
            />
          ))}
        </MetaSection>
      ) : null}
    </View>
  );
}

function SetLogo({ code, logoUrl, name }: { code: string | null; logoUrl: string | null; name: string }) {
  const theme = useSpotlightTheme();
  const fallback = (code ?? name).slice(0, 4).toUpperCase();
  return (
    <View
      accessibilityLabel={`${name} logo`}
      style={[styles.logo, { backgroundColor: theme.colors.purple50 }]}
      testID="set-spotlight-logo"
    >
      {logoUrl ? (
        <CachedImage cachePolicy={imageCachePolicy.thumbnail} contentFit="contain" style={styles.logoImage} uri={logoUrl} />
      ) : (
        <Text style={[theme.typography.titleXsmall, { color: theme.colors.brandStrong }]}>{fallback}</Text>
      )}
    </View>
  );
}

function StatTile({
  caption,
  change,
  label,
  testID,
  value,
}: {
  caption?: string;
  change?: number | null;
  label: string;
  testID: string;
  value: string;
}) {
  const theme = useSpotlightTheme();
  const changeLabel = change == null ? null : formatSignedPercent(change);
  return (
    <View
      accessibilityLabel={[label, value, changeLabel, caption].filter(Boolean).join(', ')}
      accessible
      style={[styles.statTile, { backgroundColor: theme.colors.gray50 }]}
      testID={testID}
    >
      <Text style={theme.typography.cardMeta}>{label}</Text>
      <Text numberOfLines={1} style={theme.typography.titleSmall}>
        {value}
      </Text>
      {changeLabel ? (
        <View style={styles.statChange}>
          <DeltaPill changePercent={change ?? null} label={changeLabel} />
        </View>
      ) : caption ? (
        <Text style={theme.typography.cardMeta}>{caption}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  callout: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: 10,
    padding: spacing.xs,
  },
  calloutArt: {
    borderCurve: 'continuous',
    borderRadius: spacing.xxxs,
    height: CALLOUT_ART.height,
    overflow: 'hidden',
    width: CALLOUT_ART.width,
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  logo: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.lg,
    height: SET_LOGO_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: SET_LOGO_SIZE,
  },
  logoImage: {
    height: SET_LOGO_SIZE - spacing.xs,
    width: SET_LOGO_SIZE - spacing.xs,
  },
  safeArea: {
    flex: 1,
  },
  setCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  setHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xxxs,
  },
  showAll: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingTop: spacing.xxs,
  },
  skeleton: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  stale: {
    opacity: 0.6,
  },
  stateWrap: {
    paddingHorizontal: spacing.sm,
  },
  statChange: {
    alignItems: 'flex-start',
    marginTop: 2,
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  statTile: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flex: 1,
    minWidth: 0,
    padding: 10,
  },
  videoRail: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  // The rail scrolls edge to edge while its first tile lines up with the gutter.
  videoRailBleed: {
    marginHorizontal: -spacing.sm,
    marginTop: 10,
  },
  tabs: {
    marginBottom: spacing.xxxs,
    marginTop: spacing.xs,
  },
});
