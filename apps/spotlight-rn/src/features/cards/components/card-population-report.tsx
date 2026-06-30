import { StyleSheet, Text, View } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';
import type { CardPopulation } from '@spotlight/api-client';

type CardPopulationReportProps = {
  /** Full population payload keyed by grader (PSA/BGS/CGC/SGC). */
  population?: CardPopulation | null;
  /** The grading company currently selected on the PDP. */
  grader: string | null;
  testID?: string;
};

function formatCount(value: number): string {
  return value.toLocaleString();
}

/**
 * Population report (Figma 1874:11631): a single full-bleed gray band reading
 * "<GRADER> Population Report: <total>". The grader is dynamic — it re-renders
 * whenever the selected grading company flips. Renders nothing for the raw lane
 * or when the selected grader has no synced population, so the PDP omits it.
 */
export function CardPopulationReport({ population, grader, testID }: CardPopulationReportProps) {
  const theme = useSpotlightTheme();

  const normalizedGrader = (grader ?? '').trim().toUpperCase();
  const entry = normalizedGrader && population ? population[normalizedGrader] : undefined;
  if (!entry || !(entry.totalPopulation > 0)) {
    return null;
  }

  return (
    <View style={[styles.bar, { backgroundColor: theme.colors.gray100 }]} testID={testID}>
      <Text
        style={[theme.typography.label, styles.text, { color: theme.colors.gray900 }]}
        testID={testID ? `${testID}-title` : undefined}
      >
        {`${normalizedGrader} Population Report: ${formatCount(entry.totalPopulation)}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    justifyContent: 'center',
    // Full-bleed: cancel the PDP content's 16px gutter so the band spans edge to
    // edge (Figma 1874:11631 is full screen width), then re-inset its own text.
    marginHorizontal: -16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  text: {
    textAlign: 'center',
  },
});

export default CardPopulationReport;
