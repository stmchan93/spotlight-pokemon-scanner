import { ScrollView, StyleSheet, Text, View } from 'react-native';

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
// counts and sort highest grade first so the report reads left-to-right like a
// real PSA/BGS pop report.
function sortedGradeEntries(grades: Record<string, number>): [string, number][] {
  return Object.entries(grades)
    .filter(([, count]) => count > 0)
    .sort((a, b) => Number(b[0]) - Number(a[0]));
}

/**
 * Dynamic population report (Figma 1640:4229 title + 1640:4230 grade values): a
 * centered "<GRADER> Population Report: <total>" heading over a horizontally-
 * scrolling row of grade cells, each stacking the grade label over its slab count
 * inside a top/bottom-ruled container. Re-renders whenever `grader` flips. Renders
 * nothing for the raw lane or when the selected grader has no synced population, so
 * the PDP simply omits the section.
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

  return (
    <View style={styles.root} testID={testID}>
      <Text
        style={[theme.typography.label, styles.title, { color: theme.colors.gray600 }]}
        testID={testID ? `${testID}-title` : undefined}
      >
        {`${normalizedGrader} Population Report: ${formatCount(entry.totalPopulation)}`}
      </Text>

      <ScrollView
        contentContainerStyle={styles.row}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {grades.map(([grade, count]) => (
          <View
            key={grade}
            style={[styles.cell, { borderColor: theme.colors.gray100 }]}
            testID={testID ? `${testID}-grade-${grade}` : undefined}
          >
            <View style={styles.cellInner}>
              <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
                {grade}
              </Text>
              <Text style={theme.typography.bodyMedium}>{formatCount(count)}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Figma 1640:4231 — each grade sits in a 12px-padded container ruled top and
  // bottom (gray-100); adjacent cells share the rule into one continuous band.
  cell: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    padding: 12,
  },
  cellInner: {
    alignItems: 'center',
    gap: 8,
    width: 56,
  },
  root: {
    gap: 12,
    width: '100%',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  // Figma 1640:4229 — the report title is left-aligned (x=16, start of the row).
  title: {
    textAlign: 'left',
  },
});

export default CardPopulationReport;
