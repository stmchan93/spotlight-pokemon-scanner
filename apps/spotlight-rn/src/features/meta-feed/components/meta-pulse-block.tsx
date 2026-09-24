import { StyleSheet, View } from 'react-native';

import { gameDisplayName, type MetaExposure, type MetaGroup, type MetaPulse } from '@spotlight/api-client';
import { AppText, useSpotlightTheme } from '@spotlight/design-system';

import { MetaBarList } from '@/features/meta-feed/components/meta-bar-list';
import { MetaBlockHeader } from '@/features/meta-feed/components/meta-block-header';
import { MetaExposureCallout } from '@/features/meta-feed/components/meta-exposure-callout';
import { maxGroupMagnitude, splitMetaGroups } from '@/features/meta-feed/screens/components/meta-format';

/** Rows per direction in the feed block; the Meta page shows every group. */
export const META_PULSE_BLOCK_ROWS = 3;

/** The feed block's rows: up to three risers and up to three coolers. */
export function metaPulseFeedGroups(groups: MetaGroup[], count = META_PULSE_BLOCK_ROWS) {
  return splitMetaGroups(groups, count);
}

/** "Pokémon · past 7 days". */
export function metaPulseCaption(pulse: MetaPulse): string {
  return `${gameDisplayName(pulse.game)} · past ${pulse.windowDays} days`;
}

/** Same rule the block renders by, so the feed can lay out seams from it. */
export function hasMetaPulseContent(pulse: MetaPulse | null): boolean {
  if (pulse == null) {
    return false;
  }
  const { risers, coolers } = splitMetaGroups(pulse.groups, 1);
  return risers.length + coolers.length > 0;
}

export type MetaPulseBlockProps = {
  pulse: MetaPulse | null;
  /** The viewer's exposure; null (signed out / owns nothing) hides the callout and tags. */
  exposure?: MetaExposure | null;
  /** "See all ›"; the feed pushes `/meta`. */
  onOpenMeta?: (pulse: MetaPulse) => void;
  /** Row taps; the feed pushes `/meta/group/[groupKey]`. */
  onOpenGroup?: (group: MetaGroup, pulse: MetaPulse) => void;
  /** Draw the closing 4pt band (off when the feed's first cell owns it). */
  showBand?: boolean;
  testID?: string;
};

/**
 * Social feed "Meta pulse" v4 (docs/meta-feed-mockup/v2/MetaPulseV4.dc.html):
 * the templated headline, the viewer's callout, then three risers and three
 * coolers as bar rows scaled against the biggest move shown. Renders nothing
 * until there is a row to show — no placeholder flash.
 */
export function MetaPulseBlock({
  pulse,
  exposure = null,
  onOpenMeta,
  onOpenGroup,
  showBand = true,
  testID = 'meta-pulse',
}: MetaPulseBlockProps) {
  const theme = useSpotlightTheme();
  if (!pulse || !hasMetaPulseContent(pulse)) {
    return null;
  }
  const { risers, coolers } = metaPulseFeedGroups(pulse.groups);
  const maxMagnitude = maxGroupMagnitude([...risers, ...coolers]);
  // Exposure for another game would tag the wrong groups.
  const viewerExposure = exposure && exposure.game === pulse.game ? exposure : null;
  const openGroup = onOpenGroup ? (group: MetaGroup) => onOpenGroup(group, pulse) : undefined;

  return (
    <View
      style={[
        styles.section,
        { borderBottomColor: theme.colors.gray100, borderBottomWidth: showBand ? 4 : 0 },
      ]}
      testID={testID}
    >
      <MetaBlockHeader
        actionLabel="See all ›"
        onPressAction={onOpenMeta ? () => onOpenMeta(pulse) : undefined}
        size="large"
        testID={`${testID}-header`}
        title="Meta pulse"
      />
      <AppText color="gray600" style={styles.caption} testID={`${testID}-caption`} variant="captionMedium">
        {metaPulseCaption(pulse)}
      </AppText>
      {pulse.headline.title ? (
        <AppText color="gray900" style={styles.headline} testID={`${testID}-headline`} variant="feedTitle">
          {pulse.headline.title}
        </AppText>
      ) : null}
      <MetaExposureCallout exposure={viewerExposure} style={styles.callout} testID={`${testID}-callout`} />
      <MetaBarList
        direction="up"
        exposure={viewerExposure}
        groups={risers}
        maxMagnitude={maxMagnitude}
        onOpenGroup={openGroup}
        testID={`${testID}-up`}
      />
      <MetaBarList
        direction="down"
        exposure={viewerExposure}
        groups={coolers}
        maxMagnitude={maxMagnitude}
        onOpenGroup={openGroup}
        testID={`${testID}-down`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Mockup: 20 top / 18 bottom / 16 sides. The band is a BORDER, same reason
  // as the Top Trends block.
  section: {
    alignSelf: 'stretch',
    paddingBottom: 18,
    paddingHorizontal: 16,
    paddingTop: 20,
    width: '100%',
  },
  caption: {
    marginTop: 2,
  },
  headline: {
    marginTop: 14,
  },
  callout: {
    marginTop: 14,
  },
});
