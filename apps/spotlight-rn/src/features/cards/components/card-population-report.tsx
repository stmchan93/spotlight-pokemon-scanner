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

/** Grades with at least one slab, highest grade first ("10", "9.5", "9", …). */
function sortedGradeEntries(grades: Record<string, number>): [string, number][] {
  return Object.entries(grades)
    .filter(([, count]) => count > 0)
    .sort((a, b) => Number(b[0]) - Number(a[0]));
}

/**
 * Population report (Figma 1874:11631 + 1874:23015): a full-bleed gray band
 * reading "<GRADER> Population Report: <total>", followed by a horizontally
 * scrolling row of per-grade cells — each a 56px centered column with the grade
 * label (Overline / gray-600) above its slab count (Body-medium / gray-900),
 * topped-and-tailed by gray-200 rules. Both are dynamic by grader and re-render
 * when the selected grading company flips. Renders nothing for the raw lane or a
 * grader with no synced population, so the PDP omits it.
 */
export function CardPopulationReport({ population, grader, testID }: CardPopulationReportProps) {
  const theme = useSpotlightTheme();

  const normalizedGrader = (grader ?? '').trim().toUpperCase();
  const entry = normalizedGrader && population ? population[normalizedGrader] : undefined;
  if (!entry || !(entry.totalPopulation > 0)) {
    return null;
  }

  const grades = sortedGradeEntries(entry.grades ?? {});

  return (
    <View testID={testID}>
      <View style={[styles.bar, { backgroundColor: theme.colors.gray100 }]}>
        <Text
          style={[theme.typography.label, styles.text, { color: theme.colors.gray900 }]}
          testID={testID ? `${testID}-title` : undefined}
        >
          {`${normalizedGrader} Population Report: ${formatCount(entry.totalPopulation)}`}
        </Text>
      </View>

      {grades.length > 0 ? (
        // Full-bleed frame carries the top/bottom rules so they span edge to edge
        // even when only a couple of grades exist (Figma 1874:23015) — drawing them
        // per-cell stopped the line short at the last grade.
        <View style={[styles.rowFrame, { borderColor: theme.colors.gray200 }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            testID={testID ? `${testID}-grades` : undefined}
          >
            {grades.map(([grade, count]) => (
            <View
              key={grade}
              style={[styles.cell, { backgroundColor: theme.colors.gray0 }]}
              testID={testID ? `${testID}-grade-${grade}` : undefined}
            >
              <View style={styles.cellInner}>
                <Text
                  style={[theme.typography.overline, styles.cellText, { color: theme.colors.gray600 }]}
                >
                  {grade}
                </Text>
                <Text
                  style={[theme.typography.bodyMedium, styles.cellText, { color: theme.colors.gray900 }]}
                >
                  {formatCount(count)}
                </Text>
              </View>
            </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
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
  // Full-bleed frame: the top/bottom rules live here so they run edge to edge
  // regardless of how many grade cells exist. Each cell keeps its own 16px
  // padding, so the first grade still aligns with the page gutter.
  rowFrame: {
    marginHorizontal: -16,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cellInner: {
    alignItems: 'center',
    gap: 8,
    width: 56,
  },
  cellText: {
    textAlign: 'center',
    width: '100%',
  },
});

export default CardPopulationReport;
