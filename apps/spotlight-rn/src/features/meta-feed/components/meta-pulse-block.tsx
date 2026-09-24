import { StyleSheet, View } from 'react-native';

import { gameDisplayName, type MetaGroup, type MetaPulse } from '@spotlight/api-client';
import { AppText, MetaGroupRow, useSpotlightTheme } from '@spotlight/design-system';

import { MetaBlockHeader } from '@/features/meta-feed/components/meta-block-header';
import {
  formatSignedCompactUsd,
  formatSignedPercent,
} from '@/features/meta-feed/screens/components/meta-format';

/** Groups the feed block shows; the Meta page shows the rest. */
export const META_PULSE_BLOCK_GROUPS = 3;

/**
 * The block's rows: the top risers plus the biggest cooler, so a mixed week
 * reads as mixed (mockup: two up, one down). Payload order is kept — it is
 * already sorted risers first — and an all-rising or all-cooling week simply
 * shows its first three.
 */
export function metaPulseFeedGroups(groups: MetaGroup[], count = META_PULSE_BLOCK_GROUPS): MetaGroup[] {
  const coolers = groups.filter((group) => group.medianChangePercent < 0);
  const risers = groups.filter((group) => group.medianChangePercent >= 0);
  if (coolers.length === 0 || risers.length === 0 || count < 2) {
    return groups.slice(0, count);
  }
  const biggestCooler = coolers[coolers.length - 1];
  return [...risers.slice(0, count - 1), biggestCooler];
}

/** "Pokémon · past 7 days · from price changes, raw and graded". */
export function metaPulseCaption(pulse: MetaPulse): string {
  const lanes = new Set(pulse.groups.map((group) => group.lane));
  const source = lanes.has('raw') && lanes.has('graded')
    ? 'from price changes, raw and graded'
    : lanes.has('graded')
      ? 'from graded price changes'
      : 'from raw price changes';
  return `${gameDisplayName(pulse.game)} · past ${pulse.windowDays} days · ${source}`;
}

/** Same rule the block renders by, so the feed can lay out seams from it. */
export function hasMetaPulseContent(pulse: MetaPulse | null): boolean {
  return pulse != null && pulse.groups.length > 0;
}

export type MetaPulseBlockProps = {
  pulse: MetaPulse | null;
  /** "See the meta ›" and group taps; the feed pushes `/meta`. */
  onOpenMeta?: (pulse: MetaPulse) => void;
  /** Draw the closing 4pt band (off when the feed's first cell owns it). */
  showBand?: boolean;
  testID?: string;
};

/**
 * Social feed "Meta pulse" (docs/meta-feed-mockup/Main.dc.html): which card
 * groups are rising or cooling in price, with a templated headline. Renders
 * nothing until there is a group to show — no placeholder flash.
 */
export function MetaPulseBlock({
  pulse,
  onOpenMeta,
  showBand = true,
  testID = 'meta-pulse',
}: MetaPulseBlockProps) {
  const theme = useSpotlightTheme();
  if (!pulse || !hasMetaPulseContent(pulse)) {
    return null;
  }
  const groups = metaPulseFeedGroups(pulse.groups);
  const open = onOpenMeta ? () => onOpenMeta(pulse) : undefined;

  return (
    <View
      style={[
        styles.section,
        { borderBottomColor: theme.colors.gray100, borderBottomWidth: showBand ? 4 : 0 },
      ]}
      testID={testID}
    >
      <MetaBlockHeader
        actionLabel="See the meta ›"
        onPressAction={open}
        testID={`${testID}-header`}
        title="Meta pulse"
      />
      {pulse.headline.title ? (
        <AppText color="gray900" style={styles.headline} testID={`${testID}-headline`} variant="titleSmall">
          {pulse.headline.title}
        </AppText>
      ) : null}
      <AppText color="gray600" style={styles.caption} variant="captionMedium">
        {metaPulseCaption(pulse)}
      </AppText>
      <View
        style={[
          styles.groups,
          {
            borderColor: theme.colors.gray200,
            borderCurve: 'continuous',
            borderRadius: theme.radii.md,
            borderWidth: theme.borderWidths.containerRule,
          },
        ]}
      >
        {groups.map((group, index) => (
          <MetaGroupRow
            changeLabel={formatSignedPercent(group.medianChangePercent)}
            changePercent={group.medianChangePercent}
            description={group.description}
            divider={index > 0}
            key={group.groupKey}
            label={group.label}
            lane={group.lane}
            onPress={open}
            testID={`${testID}-group-${group.groupKey}`}
            valueLabel={`${formatSignedCompactUsd(group.valueChangeUsd)} value`}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 16 all round; the band is a BORDER, same reason as the Top Trends block.
  section: {
    alignSelf: 'stretch',
    padding: 16,
    width: '100%',
  },
  headline: {
    marginTop: 8,
  },
  caption: {
    marginTop: 4,
  },
  groups: {
    marginTop: 12,
    overflow: 'hidden',
  },
});
