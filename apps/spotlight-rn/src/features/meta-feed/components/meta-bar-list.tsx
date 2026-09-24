import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { MetaExposure, MetaGroup } from '@spotlight/api-client';
import { AppText, MetaBarRow } from '@spotlight/design-system';

import {
  formatSignedCompactUsd,
  formatSignedPercent,
  groupBarFraction,
  ownedGroupLabel,
} from '@/features/meta-feed/screens/components/meta-format';

export type MetaBarListProps = {
  /** `up` = "ON THE WAY UP" in green, `down` = "COOLING OFF" in red. */
  direction: 'up' | 'down';
  groups: MetaGroup[];
  /** Largest |median %| across EVERY row the host shows (both lists). */
  maxMagnitude: number;
  exposure?: MetaExposure | null;
  onOpenGroup?: (group: MetaGroup) => void;
  /** Right side of the eyebrow row (the Meta page's lane control). */
  accessory?: ReactNode;
  testID: string;
};

export const META_DIRECTION_LABEL = { down: 'COOLING OFF', up: 'ON THE WAY UP' } as const;

/**
 * An eyebrow plus a stack of `MetaBarRow`s — the "On the way up" / "Cooling
 * off" lists shared by the Meta pulse block and the Meta page. Renders nothing
 * without groups.
 */
export function MetaBarList({
  direction,
  groups,
  maxMagnitude,
  exposure = null,
  onOpenGroup,
  accessory,
  testID,
}: MetaBarListProps) {
  if (groups.length === 0) {
    return null;
  }
  return (
    <View testID={testID}>
      <View style={styles.eyebrowRow}>
        <AppText
          color={direction === 'up' ? 'deltaUpText' : 'deltaDownText'}
          testID={`${testID}-label`}
          variant="feedEyebrow"
        >
          {META_DIRECTION_LABEL[direction]}
        </AppText>
        {accessory}
      </View>
      {groups.map((group) => (
        <MetaBarRow
          barFraction={groupBarFraction(group.medianChangePercent, maxMagnitude)}
          changeLabel={formatSignedPercent(group.medianChangePercent)}
          changePercent={group.medianChangePercent}
          imageUrl={group.topCards[0]?.imageUrl ?? null}
          key={group.groupKey}
          label={group.label}
          onPress={onOpenGroup ? () => onOpenGroup(group) : undefined}
          ownedLabel={ownedGroupLabel(exposure, group.groupKey)}
          sparkPoints={group.sparkPoints}
          testID={`${testID}-row-${group.groupKey}`}
          valueLabel={formatSignedCompactUsd(group.valueChangeUsd)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 2,
    paddingTop: 14,
  },
});
