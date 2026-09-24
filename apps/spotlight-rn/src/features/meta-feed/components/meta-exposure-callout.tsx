import type { StyleProp, ViewStyle } from 'react-native';
import { View } from 'react-native';

import type { MetaExposure } from '@spotlight/api-client';
import { MetaCalloutCard } from '@spotlight/design-system';

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
  style,
  testID,
}: {
  exposure: MetaExposure | null | undefined;
  style?: StyleProp<ViewStyle>;
  testID: string;
}) {
  const callout = exposure?.callout;
  if (!callout || !callout.title) {
    return null;
  }
  return (
    <View style={style}>
      <MetaCalloutCard
        body={callout.body || null}
        highlight={calloutHighlight(callout.title)}
        highlightTone={callout.valueChangeUsd < 0 ? 'down' : 'up'}
        imageUrls={callout.imageUrls}
        testID={testID}
        title={callout.title}
      />
    </View>
  );
}
