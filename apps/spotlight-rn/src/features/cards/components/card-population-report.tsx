import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { borderWidths, radii, useSpotlightTheme } from '@spotlight/design-system';
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
 * Population report (Figma 2489:7486): an inset gray-100 rounded card titled
 * "POP REPORT", holding a horizontally scrolling strip of white cells that
 * share their 1px gray-200 edges — first the "<GRADER> TOTAL" cell, then one
 * cell per grade (grade label over slab count), with the strip's outer corners
 * rounded to 8. Dynamic by grader; re-renders when the selected grading company
 * flips. Renders nothing for the raw lane or a grader with no synced
 * population, so the PDP omits it.
 */
export function CardPopulationReport({ population, grader, testID }: CardPopulationReportProps) {
  const theme = useSpotlightTheme();

  const normalizedGrader = (grader ?? '').trim().toUpperCase();
  const entry = normalizedGrader && population ? population[normalizedGrader] : undefined;
  if (!entry || !(entry.totalPopulation > 0)) {
    return null;
  }

  const grades = sortedGradeEntries(entry.grades ?? {});
  const cellColors = {
    backgroundColor: theme.colors.gray0,
    borderColor: theme.colors.gray200,
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.gray100 }]} testID={testID}>
      <Text
        style={[theme.typography.captionMedium, { color: theme.colors.gray900 }]}
        testID={testID ? `${testID}-title` : undefined}
      >
        POP REPORT
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        testID={testID ? `${testID}-grades` : undefined}
      >
        {/* Cells share edges: every cell draws top/bottom/right, only the first
            draws left, and only the outer corners round — so adjacent borders
            never double up (Figma 2489:7486). */}
        <View
          style={[
            styles.cell,
            styles.cellFirst,
            grades.length === 0 ? styles.cellLast : null,
            cellColors,
          ]}
        >
          <View style={styles.totalCellInner}>
            <Text
              numberOfLines={1}
              style={[theme.typography.overline, { color: theme.colors.gray600 }]}
            >
              {`${normalizedGrader} TOTAL`}
            </Text>
            <Text
              numberOfLines={1}
              style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
            >
              {formatCount(entry.totalPopulation)}
            </Text>
          </View>
        </View>
        {grades.map(([grade, count], index) => (
          <View
            key={grade}
            style={[
              styles.cell,
              index === grades.length - 1 ? styles.cellLast : null,
              cellColors,
            ]}
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
  );
}

const styles = StyleSheet.create({
  cell: {
    alignItems: 'center',
    borderBottomWidth: borderWidths.containerRule,
    borderRightWidth: borderWidths.containerRule,
    borderTopWidth: borderWidths.containerRule,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cellFirst: {
    borderBottomLeftRadius: radii.sm,
    borderLeftWidth: borderWidths.containerRule,
    borderTopLeftRadius: radii.sm,
  },
  cellInner: {
    alignItems: 'center',
    gap: 8,
    width: 56,
  },
  // The "<GRADER> TOTAL" cell hugs its content so the label stays on ONE line
  // (Figma 2489-7489) — the fixed 56px grade-cell width wrapped it to two.
  totalCellInner: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  cellLast: {
    borderBottomRightRadius: radii.sm,
    borderTopRightRadius: radii.sm,
  },
  cellText: {
    textAlign: 'center',
    width: '100%',
  },
  // Inset rounded card (Figma 2489:7486) — no more full-bleed negative margins;
  // radius 10 comes from the Figma frame (between radii.sm 8 and radii.md 12).
  container: {
    borderRadius: 10,
    gap: 10,
    padding: 16,
  },
});

export default CardPopulationReport;
