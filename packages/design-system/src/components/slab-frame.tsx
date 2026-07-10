import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fontFamilies } from '../tokens';
import { psaGradeDescriptor } from './grader-wordmark';

/**
 * Slab "case" chrome around a graded card's image (Figma 2609:6812 — the
 * Collectr-style tile where the card sits inside its grading slab): a light
 * plastic-looking case border with the grader's label band on top — grader
 * name left, big grade right — then the card art below.
 *
 * The label's accent color is keyed by THIS entry's grader (PSA red label,
 * CGC blue, Beckett silver-gray, TAG black); unknown graders get a neutral
 * gray label so nothing ever breaks.
 */

type SlabLabelStyle = {
  accent: string; // label border/accent — the grader's label color
  text: string; // label text color
};

const SLAB_LABEL_STYLES: Record<string, SlabLabelStyle> = {
  psa: { accent: '#DA2128', text: '#1A1A1A' }, // PSA red label
  cgc: { accent: '#1E5AA8', text: '#1A1A1A' }, // CGC blue label
  beckett: { accent: '#9AA2AB', text: '#1A1A1A' }, // BGS silver label
  bgs: { accent: '#9AA2AB', text: '#1A1A1A' },
  tag: { accent: '#1A1A1A', text: '#1A1A1A' }, // TAG black slab
};

const NEUTRAL_LABEL: SlabLabelStyle = { accent: '#BEBEBE', text: '#1A1A1A' };

function labelStyleFor(grader: string): SlabLabelStyle {
  return SLAB_LABEL_STYLES[grader.trim().toLowerCase()] ?? NEUTRAL_LABEL;
}

export type SlabFrameSize = 'sm' | 'md';

type SlabFrameProps = {
  /** The entry's own grader — drives the label branding. */
  grader: string;
  grade?: string | null;
  /**
   * sm = list-row thumbnail (58×80): grade number only on the label.
   * md = grid tile: grader name + PSA descriptor when it fits.
   */
  size?: SlabFrameSize;
  /** The card image (fills the case below the label). */
  children: ReactNode;
  testID?: string;
};

export function SlabFrame({ grader, grade, size = 'md', children, testID }: SlabFrameProps) {
  const label = labelStyleFor(grader);
  const gradeText = (grade ?? '').trim();
  const isSmall = size === 'sm';
  // PSA labels lead with the grade's descriptor ("GEM MT   10"); only room on
  // the md (tile) label. Other graders show their name.
  const descriptor = grader.trim().toLowerCase() === 'psa' && gradeText
    ? psaGradeDescriptor(gradeText)
    : null;
  const leftText = isSmall
    ? grader.trim().toUpperCase()
    : (descriptor ?? grader.trim().toUpperCase());

  return (
    <View style={[styles.case, isSmall ? styles.caseSmall : null]} testID={testID}>
      <View
        style={[
          styles.label,
          isSmall ? styles.labelSmall : null,
          { borderColor: label.accent },
        ]}
        testID={testID ? `${testID}-label` : undefined}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.labelText,
            isSmall ? styles.labelTextSmall : null,
            { color: label.text },
          ]}
        >
          {leftText}
        </Text>
        {gradeText ? (
          <Text
            numberOfLines={1}
            style={[
              styles.gradeText,
              isSmall ? styles.gradeTextSmall : null,
              { color: label.text },
            ]}
            testID={testID ? `${testID}-grade` : undefined}
          >
            {gradeText}
          </Text>
        ) : null}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    overflow: 'hidden',
  },
  // The clear plastic case: a light border + faint inner edge so the card
  // reads as sitting inside a slab rather than a plain image crop.
  case: {
    backgroundColor: colors.gray100,
    borderColor: 'rgba(0, 0, 0, 0.14)',
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    overflow: 'hidden',
    padding: 2.5,
  },
  caseSmall: {
    borderRadius: 4,
    padding: 2,
  },
  gradeText: {
    fontFamily: fontFamilies.bodyBold,
    fontSize: 12,
    lineHeight: 14,
  },
  gradeTextSmall: {
    fontSize: 9,
    lineHeight: 11,
  },
  label: {
    alignItems: 'center',
    backgroundColor: colors.gray0,
    borderRadius: 2,
    borderWidth: 1.5,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'space-between',
    marginBottom: 2,
    minHeight: 18,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  labelSmall: {
    borderWidth: 1,
    marginBottom: 1.5,
    minHeight: 13,
    paddingHorizontal: 3,
    paddingVertical: 0.5,
  },
  labelText: {
    flexShrink: 1,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 9,
    letterSpacing: 0.3,
    lineHeight: 12,
  },
  labelTextSmall: {
    fontSize: 7,
    letterSpacing: 0.2,
    lineHeight: 9,
  },
});
