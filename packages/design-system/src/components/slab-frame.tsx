import type { ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, fontFamilies } from '../tokens';
import { getGraderAsset, psaGradeDescriptor } from './grader-wordmark';

/**
 * Slab "case" chrome around a graded card's image (Figma 2609:6812/6977 — the
 * Collectr-style treatment where the card sits inside its grading slab). The
 * top label mirrors the REAL label: PSA = white flag with the red border, the
 * PSA logo at left, and the grade descriptor stacked over the bold grade at
 * right — so a PSA slab is recognizable at a glance.
 *
 * Label branding is keyed by THIS entry's grader; graders we don't carry art
 * or colors for get a neutral label with their name — never breaks.
 */

type SlabLabelStyle = {
  border: string; // the label's frame color (PSA red, CGC blue, …)
  text: string;
};

const SLAB_LABEL_STYLES: Record<string, SlabLabelStyle> = {
  psa: { border: '#E31B23', text: '#1A1A1A' }, // PSA red label frame
  cgc: { border: '#1E5AA8', text: '#1A1A1A' }, // CGC blue
  beckett: { border: '#9AA2AB', text: '#1A1A1A' }, // BGS silver
  bgs: { border: '#9AA2AB', text: '#1A1A1A' },
  tag: { border: '#1A1A1A', text: '#1A1A1A' }, // TAG black
};

const NEUTRAL_LABEL: SlabLabelStyle = { border: '#BEBEBE', text: '#1A1A1A' };

export type SlabFrameSize = 'sm' | 'md';

type SlabFrameProps = {
  /** The entry's own grader — drives the label branding. */
  grader: string;
  grade?: string | null;
  /**
   * sm = list-row thumbnail (the 84×136 slab slot, Figma 2609:6977).
   * md = grid tile (roomier label: logo + descriptor + grade).
   */
  size?: SlabFrameSize;
  /** The card image (fills the case below the label). */
  children: ReactNode;
  testID?: string;
};

export function SlabFrame({ grader, grade, size = 'md', children, testID }: SlabFrameProps) {
  const graderKey = grader.trim().toLowerCase();
  const label = SLAB_LABEL_STYLES[graderKey] ?? NEUTRAL_LABEL;
  const asset = getGraderAsset(grader);
  const gradeText = (grade ?? '').trim();
  const isSmall = size === 'sm';
  // Real PSA labels stack the descriptor ("GEM MT") over the grade.
  const descriptor = graderKey === 'psa' && gradeText
    ? psaGradeDescriptor(gradeText)?.replace('-', ' ')
    : null;
  const logoHeight = isSmall ? 9 : 14;

  return (
    <View style={[styles.case, isSmall ? styles.caseSmall : null]} testID={testID}>
      <View
        style={[
          styles.label,
          isSmall ? styles.labelSmall : null,
          { borderColor: label.border },
        ]}
        testID={testID ? `${testID}-label` : undefined}
      >
        {asset ? (
          <Image
            accessibilityLabel={grader}
            resizeMode="contain"
            source={asset.source}
            style={{ height: logoHeight, width: Math.round(logoHeight * asset.aspectRatio) }}
            testID={testID ? `${testID}-logo` : undefined}
          />
        ) : (
          <Text
            numberOfLines={1}
            style={[
              styles.graderName,
              isSmall ? styles.graderNameSmall : null,
              { color: label.text },
            ]}
          >
            {grader.trim().toUpperCase()}
          </Text>
        )}
        {gradeText ? (
          <View style={styles.gradeColumn}>
            {descriptor && !isSmall ? (
              <Text numberOfLines={1} style={[styles.descriptor, { color: label.text }]}>
                {descriptor}
              </Text>
            ) : null}
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
          </View>
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
  // The clear plastic case: a light border + faint edge so the card reads as
  // sitting inside a slab rather than a plain image crop.
  case: {
    backgroundColor: colors.gray100,
    borderColor: 'rgba(0, 0, 0, 0.14)',
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    overflow: 'hidden',
    padding: 3,
  },
  caseSmall: {
    borderRadius: 4,
    padding: 2,
  },
  descriptor: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 6,
    letterSpacing: 0.4,
    lineHeight: 7,
    textAlign: 'right',
  },
  gradeColumn: {
    alignItems: 'flex-end',
  },
  gradeText: {
    fontFamily: fontFamilies.bodyBold,
    fontSize: 13,
    lineHeight: 15,
  },
  gradeTextSmall: {
    fontSize: 10,
    lineHeight: 12,
  },
  graderName: {
    flexShrink: 1,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 8,
    letterSpacing: 0.3,
    lineHeight: 10,
  },
  graderNameSmall: {
    fontSize: 7,
    lineHeight: 9,
  },
  // The label flag: white, framed in the grader's color (the real PSA label's
  // red frame), logo left / grade right.
  label: {
    alignItems: 'center',
    backgroundColor: colors.gray0,
    borderRadius: 2,
    borderWidth: 1.5,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'space-between',
    marginBottom: 2.5,
    minHeight: 24,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  labelSmall: {
    borderWidth: 1.25,
    marginBottom: 2,
    minHeight: 16,
    paddingHorizontal: 3.5,
    paddingVertical: 1,
  },
});
