import { Image, ScrollView, StyleSheet, View } from 'react-native';

import type { NewsItem, SetSpotlight } from '@spotlight/api-client';
import {
  AppText,
  DeltaPill,
  RankedCardRow,
  VideoTile,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { MetaBlockHeader } from '@/features/meta-feed/components/meta-block-header';
import {
  formatAge,
  formatCompactCount,
  formatDuration,
  formatSignedPercent,
} from '@/features/meta-feed/screens/components/meta-format';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/** Rows the feed block shows; the Set page shows the full top 10. */
export const SET_SPOTLIGHT_BLOCK_ROWS = 3;

/** "Top 10 by price · 25th anniversary · 2021". */
export function setSpotlightCaption(spotlight: SetSpotlight): string {
  const year = spotlight.set.releaseDate?.slice(0, 4) ?? null;
  return ['Top 10 by price', spotlight.set.series, year].filter(Boolean).join(' · ');
}

/** "PokeRev · 212K views · 3d". */
export function videoMetaLabel(item: NewsItem, now = Date.now()): string {
  const channel = item.video?.channelTitle || item.source;
  const views = item.video?.viewCount != null ? `${formatCompactCount(item.video.viewCount)} views` : null;
  const age = formatAge(item.publishedAt, now) || null;
  return [channel, views, age].filter(Boolean).join(' · ');
}

export function hasSetSpotlightContent(spotlight: SetSpotlight | null): boolean {
  return spotlight != null && spotlight.topByPrice.length > 0;
}

export type SetSpotlightBlockProps = {
  spotlight: SetSpotlight | null;
  onPressCard?: (cardId: string) => void;
  /** "Open set ›"; the feed pushes `/set-spotlight/[setId]`. */
  onOpenSet?: (setId: string) => void;
  /** Video taps; defaults to the in-app browser. */
  onOpenLink?: (url: string) => void;
  showBand?: boolean;
  testID?: string;
};

/**
 * Social feed "Set spotlight": this week's set, its three priciest cards and,
 * once there are any, videos about it.
 */
export function SetSpotlightBlock({
  spotlight,
  onPressCard,
  onOpenSet,
  onOpenLink = (url) => void openLinkOut(url),
  showBand = true,
  testID = 'set-spotlight',
}: SetSpotlightBlockProps) {
  const theme = useSpotlightTheme();
  if (!spotlight || !hasSetSpotlightContent(spotlight)) {
    return null;
  }
  const { set } = spotlight;
  const rows = spotlight.topByPrice.slice(0, SET_SPOTLIGHT_BLOCK_ROWS);

  return (
    <View
      style={[
        styles.section,
        { borderBottomColor: theme.colors.gray100, borderBottomWidth: showBand ? 4 : 0 },
      ]}
      testID={testID}
    >
      <View style={styles.gutter}>
        <MetaBlockHeader
          actionLabel="Open set ›"
          onPressAction={onOpenSet ? () => onOpenSet(set.setId) : undefined}
          testID={`${testID}-header`}
          title="Set spotlight"
        />
      </View>

      <View style={styles.setRow}>
        <View
          style={[
            styles.setBadge,
            {
              backgroundColor: theme.colors.purple50,
              borderCurve: 'continuous',
              borderRadius: theme.radii.md,
            },
          ]}
        >
          {set.logoUrl ? (
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={{ uri: set.logoUrl }}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <AppText color="brandStrong" numberOfLines={1} variant="priceCaption">
              {set.code ?? set.name.slice(0, 3).toUpperCase()}
            </AppText>
          )}
        </View>
        <View style={styles.setIdentity}>
          <AppText color="gray900" numberOfLines={1} testID={`${testID}-name`} variant="titleSmall">
            {set.name}
          </AppText>
          <AppText color="gray600" numberOfLines={1} variant="captionMedium">
            {setSpotlightCaption(spotlight)}
          </AppText>
        </View>
        {set.valueChangePercent7d != null ? (
          <DeltaPill
            changePercent={set.valueChangePercent7d}
            label={formatSignedPercent(set.valueChangePercent7d)}
            style={styles.setDelta}
            testID={`${testID}-change`}
          />
        ) : null}
      </View>

      <View style={styles.rows}>
        {rows.map((card, index) => (
          <RankedCardRow
            changeLabel={card.changePercent7d != null ? formatSignedPercent(card.changePercent7d) : null}
            changePercent={card.changePercent7d}
            divider={index < rows.length - 1}
            imageUrl={card.imageUrl}
            key={card.cardId}
            name={card.name}
            onPress={onPressCard ? () => onPressCard(card.cardId) : undefined}
            priceLabel={formatCurrency(card.priceNow, card.currencyCode)}
            rank={index + 1}
            subtitle={[set.name, card.number].filter(Boolean).join(' · ')}
            testID={`${testID}-row-${card.cardId}`}
          />
        ))}
      </View>

      {spotlight.videos.length > 0 ? (
        <>
          <AppText color="gray900" style={styles.watchLabel} variant="captionStrong">
            Watch
          </AppText>
          <ScrollView
            contentContainerStyle={styles.videoRail}
            horizontal
            showsHorizontalScrollIndicator={false}
            testID={`${testID}-videos`}
          >
            {spotlight.videos.map((video) => (
              <VideoTile
                durationLabel={
                  video.video?.durationSeconds != null ? formatDuration(video.video.durationSeconds) : null
                }
                imageUrl={video.imageUrl}
                key={video.id}
                metaLabel={videoMetaLabel(video)}
                onPress={() => onOpenLink(video.url)}
                testID={`${testID}-video-${video.id}`}
                title={video.title}
              />
            ))}
          </ScrollView>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    alignSelf: 'stretch',
    paddingVertical: 16,
    width: '100%',
  },
  gutter: {
    paddingHorizontal: 16,
  },
  setRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  setBadge: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 44,
  },
  setIdentity: {
    flex: 1,
    minWidth: 0,
  },
  setDelta: {
    alignSelf: 'center',
  },
  rows: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  watchLabel: {
    paddingBottom: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  videoRail: {
    gap: 12,
    paddingHorizontal: 16,
  },
});
