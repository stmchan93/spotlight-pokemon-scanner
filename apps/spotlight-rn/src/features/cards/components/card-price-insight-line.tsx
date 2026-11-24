import type { CardPriceInsight } from '@spotlight/api-client';
import { Text, useSpotlightTheme } from '@spotlight/design-system';

type CardPriceInsightLineProps = {
  insight: CardPriceInsight | null | undefined;
  testID?: string;
};

/** One small gray line of server-computed price facts; nothing at all when there is none. */
export function CardPriceInsightLine({ insight, testID = 'detail-price-insight' }: CardPriceInsightLineProps) {
  const theme = useSpotlightTheme();
  const text = insight?.text?.trim();
  if (!text) {
    return null;
  }
  return (
    <Text
      accessibilityLabel={text}
      accessibilityRole="text"
      numberOfLines={2}
      style={[theme.typography.caption, { color: theme.colors.gray600 }]}
      testID={testID}
    >
      {text}
    </Text>
  );
}
