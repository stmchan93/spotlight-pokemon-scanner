import type { StyleProp, ViewStyle } from 'react-native';
import { View } from 'react-native';

import type { MetaExposure, MetaLaneFilter } from '@spotlight/api-client';
import { MetaCalloutCard } from '@spotlight/design-system';

import { trackMetaCalloutTapped } from '@/features/meta-feed/meta-analytics';
import { calloutHighlight } from '@/features/meta-feed/screens/components/meta-format';

export function hasExposureCallout(exposure: MetaExposure | null | undefined): boolean {
  return Boolean(exposure?.callout?.title);
}

/**
 * The viewer's "Your vintage is up +$312 this week" card. Nothing at all when
 * signed out (exposure null) or when nothing they own moved (callout null).
 */
export function MetaExposureCallout({
  exposure,
  lane,
  onOpenGroup,
  style,
  testID,
}: {
  exposure: MetaExposure | null | undefined;
  /** The lane the host page reads (analytics only). */
  lane: MetaLaneFilter;
  /** Opens the group the title is about (the callout's `groupKey`). */
  onOpenGroup?: (groupKey: string) => void;
  style?: StyleProp<ViewStyle>;
  testID: string;
}) {
  const callout = exposure?.callout;
  if (!callout || !callout.title) {
    return null;
  }
  const direction = callout.valueChangeUsd < 0 ? 'down' : 'up';
  const groupKey = callout.groupKey;
  return (
    <View style={style}>
      <MetaCalloutCard
        // Title only: the server's body counts cards across EVERY group moving
        // the same way ("2 cards in cooling groups"), which read as wrong next to
        // the one group the tap opens.
        body={null}
        highlight={calloutHighlight(callout.title)}
        highlightTone={direction}
        imageUrls={callout.imageUrls}
        onPress={onOpenGroup && groupKey
          ? () => {
              trackMetaCalloutTapped({ direction, groupKey, lane });
              onOpenGroup(groupKey);
            }
          : undefined}
        testID={testID}
        title={callout.title}
      />
    </View>
  );
}
