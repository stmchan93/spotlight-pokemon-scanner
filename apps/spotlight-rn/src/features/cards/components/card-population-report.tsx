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

// Grade labels are dotted-decimal strings ("10", "9.5", "9", …). Drop any zero
// counts and sort highest grade first so the report reads top-down like a real
// PSA/BGS pop report.
function sortedGradeEntries(grades: Record<string, number>): [string, number][] {
  return Object.entries(grades)
    .filter(([, count]) => count > 0)
    .sort((a, b) => Number(b[0]) - Number(a[0]));
}

/**
 * Dynamic population report: renders the grade distribution for the grading
 * company currently selected on the PDP (Figma 1664:255 — PSA selected shows the
 * PSA pop report). Re-renders whenever `grader` flips. Renders nothing for the raw
 * lane or when the selected grader has no synced population, so the PDP simply
 * omits the section rather than showing an empty shell.
 */
export function CardPopulationReport({ population, grader, testID }: CardPopulationReportProps) {
  const theme = useSpotlightTheme();

  const normalizedGrader = (grader ?? '').trim().toUpperCase();
  const entry = normalizedGrader && population ? population[normalizedGrader] : undefined;
  if (!entry) {
    return null;
  }

  const grades = sortedGradeEntries(entry.grades);
  if (grades.length === 0) {
    return null;
  }
  // Scale bars to the most-populous grade so the distribution is legible even
  // when one grade dwarfs the rest.
  const maxCount = grades.reduce((max, [, count]) => Math.max(max, count), 0) || 1;

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.header}>
        <Text style={theme.typography.titleMedium}>{`${normalizedGrader} Population`}</Text>
        <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray600 }]}>
          {entry.gemRate != null
            ? `${formatCount(entry.totalPopulation)} total · ${entry.gemRate.toFixed(1)}% gem`
            : `${formatCount(entry.totalPopulation)} total`}
        </Text>
      </View>

      <View style={styles.rows}>
        {grades.map(([grade, count]) => (
          <View key={grade} style={styles.row} testID={testID ? `${testID}-grade-${grade}` : undefined}>
            <Text style={[theme.typography.label, styles.gradeLabel, { color: theme.colors.gray900 }]}>
              {grade}
            </Text>
            <View style={[styles.track, { backgroundColor: theme.colors.gray50 }]}>
              <View
                style={[
                  styles.fill,
                  {
                    backgroundColor: theme.colors.gray900,
                    width: `${Math.max(2, (count / maxCount) * 100)}%`,
                  },
                ]}
              />
            </View>
            <Text
              style={[theme.typography.bodyMedium, styles.count, { color: theme.colors.gray700 }]}
            >
              {formatCount(count)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  count: {
    minWidth: 56,
    textAlign: 'right',
  },
  fill: {
    borderRadius: 999,
    height: '100%',
  },
  gradeLabel: {
    minWidth: 32,
  },
  header: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  root: {
    gap: 12,
    width: '100%',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  rows: {
    gap: 8,
  },
  track: {
    borderRadius: 999,
    flex: 1,
    height: 8,
    overflow: 'hidden',
  },
});

export default CardPopulationReport;
