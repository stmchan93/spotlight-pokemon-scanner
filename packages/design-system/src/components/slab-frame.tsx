import type { ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, fontFamilies } from '../tokens';
import { getGraderAsset, psaGradeDescriptor } from './grader-wordmark';

/**
 * Slab "case" chrome around a graded card's image (Figma 2609:14258 + the
 * real-label reference photo): the card sits inside its grading slab with an
 * authentic-looking label flag on top. For PSA that means the real anatomy —
 * red-framed white label, tiny card-info lines at left ("2024 POKEMON SV5K JP
 * / GENGAR ex / SUPER RARE"), the PSA logo center, and the red #number over
 * "GEM MT" over the bold grade at right.
 *
 * Branding is keyed by THIS entry's grader; graders without bundled art get a
 * neutral label with their name — never breaks.
 */

type SlabLabelStyle = {
  border: string; // the label's frame color (PSA red, CGC blue, …)
  accent: string; // the #number accent (red on real PSA labels)
};

const SLAB_LABEL_STYLES: Record<string, SlabLabelStyle> = {
  psa: { border: '#E31B23', accent: '#E31B23' },
  cgc: { border: '#1E5AA8', accent: '#1E5AA8' },
  beckett: { border: '#9AA2AB', accent: '#1A1A1A' },
  bgs: { border: '#9AA2AB', accent: '#1A1A1A' },
  tag: { border: '#1A1A1A', accent: '#1A1A1A' },
};

const NEUTRAL_LABEL: SlabLabelStyle = { border: '#BEBEBE', accent: '#1A1A1A' };

export type SlabFrameSize = 'sm' | 'md';

type SlabFrameProps = {
  /** The entry's own grader — drives the label branding. */
  grader: string;
  grade?: string | null;
  /** Card name — the label's second info line (uppercased like the real label). */
  title?: string | null;
  /** Set line — the label's first info line (e.g. set name, uppercased). */
  setLine?: string | null;
  /** Third info line — rarity/variant when available. */
  detailLine?: string | null;
  /** Collector number; rendered as the red "#088"-style number. */
  cardNumber?: string | null;
  /**
   * sm = list-row thumbnail (the 84×136 slab slot). md = grid tile.
   */
  size?: SlabFrameSize;
  /** The card image (fills the case below the label). */
  children: ReactNode;
  testID?: string;
};

// "#088/091" / "088/091" / "215/203" → "#088" (the real label shows only the
// leading collector number).
function shortCardNumber(cardNumber: string | null | undefined): string | null {
  const lead = (cardNumber ?? '').trim().replace(/^#/, '').split('/')[0]?.trim();
  return lead ? `#${lead}` : null;
}

export function SlabFrame({
  grader,
  grade,
  title,
  setLine,
  detailLine,
  cardNumber,
  size = 'md',
  children,
  testID,
}: SlabFrameProps) {
  const graderKey = grader.trim().toLowerCase();
  const label = SLAB_LABEL_STYLES[graderKey] ?? NEUTRAL_LABEL;
  const asset = getGraderAsset(grader);
  const gradeText = (grade ?? '').trim();
  const isSmall = size === 'sm';
  const descriptor = graderKey === 'psa' && gradeText
    ? psaGradeDescriptor(gradeText)?.replace('-', ' ')
    : null;
  const numberText = shortCardNumber(cardNumber);
  const infoLines = [
    (setLine ?? '').trim().toUpperCase(),
    (title ?? '').trim().toUpperCase(),
    (detailLine ?? '').trim().toUpperCase(),
  ].filter(Boolean);
  const logoHeight = isSmall ? 6 : 9;

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
        {/* Left: the card-info lines (set / name / rarity), like the real label. */}
        <View style={styles.infoColumn}>
          {infoLines.length > 0 ? (
            infoLines.map((line, index) => (
              <Text
                key={`${index}-${line}`}
                numberOfLines={1}
                style={[styles.infoLine, isSmall ? styles.infoLineSmall : null]}
              >
                {line}
              </Text>
            ))
          ) : (
            <Text
              numberOfLines={1}
              style={[styles.infoLine, isSmall ? styles.infoLineSmall : null]}
            >
              {grader.trim().toUpperCase()}
            </Text>
          )}
          {/* Grader logo tucked under the info text, center-ish like the real flag. */}
          {asset ? (
            <Image
              accessibilityLabel={grader}
              resizeMode="contain"
              source={asset.source}
              style={[
                styles.logo,
                { height: logoHeight, width: Math.round(logoHeight * asset.aspectRatio) },
              ]}
              testID={testID ? `${testID}-logo` : undefined}
            />
          ) : null}
        </View>

        {/* Right: red #number over the grade descriptor over the bold grade. */}
        <View style={styles.gradeColumn}>
          {numberText ? (
            <Text
              numberOfLines={1}
              style={[
                styles.numberText,
                isSmall ? styles.numberTextSmall : null,
                { color: label.accent },
              ]}
            >
              {numberText}
            </Text>
          ) : null}
          {descriptor ? (
            <Text
              numberOfLines={1}
              style={[styles.descriptor, isSmall ? styles.descriptorSmall : null]}
            >
              {descriptor}
            </Text>
          ) : null}
          {gradeText ? (
            <Text
              numberOfLines={1}
              style={[styles.gradeText, isSmall ? styles.gradeTextSmall : null]}
              testID={testID ? `${testID}-grade` : undefined}
            >
              {gradeText}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.body}>
        {/* The real slab crop (Figma 2609:14258 "Card Image"): the card art is
            scaled up and nudged so the case shows the card's printed border
            edge-to-edge, not letterboxed. body clips the overflow. */}
        <View style={styles.imageCrop}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    overflow: 'hidden',
  },
  // Figma 2609:14258 "Card Image": scale + offset so the slab case frames the
  // card to its printed border. body's overflow:hidden crops the overshoot.
  imageCrop: {
    height: '115.83%',
    left: '-19.63%',
    position: 'absolute',
    top: '-3.86%',
    width: '140.19%',
  },
  // The clear plastic case around label + card.
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
    color: colors.gray900,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 6.5,
    letterSpacing: 0.2,
    lineHeight: 8,
    textAlign: 'right',
  },
  descriptorSmall: {
    fontSize: 4.5,
    letterSpacing: 0.1,
    lineHeight: 5.5,
  },
  gradeColumn: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  gradeText: {
    color: colors.gray900,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 12,
    lineHeight: 14,
  },
  gradeTextSmall: {
    fontSize: 8.5,
    lineHeight: 10,
  },
  infoColumn: {
    flex: 1,
    gap: 0.5,
    justifyContent: 'center',
    minWidth: 0,
  },
  infoLine: {
    color: colors.gray900,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 5.5,
    letterSpacing: 0.1,
    lineHeight: 7,
  },
  infoLineSmall: {
    fontSize: 4,
    letterSpacing: 0,
    lineHeight: 5,
  },
  // The label flag: white, framed in the grader's color (the red frame on
  // real PSA labels).
  label: {
    alignItems: 'center',
    backgroundColor: colors.gray0,
    borderRadius: 1.5,
    borderWidth: 1.25,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'space-between',
    marginBottom: 2.5,
    minHeight: 30,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  labelSmall: {
    borderWidth: 1,
    gap: 3,
    marginBottom: 2,
    minHeight: 21,
    paddingHorizontal: 3,
    paddingVertical: 1.5,
  },
  logo: {
    marginTop: 1,
  },
  numberText: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 6.5,
    lineHeight: 8,
    textAlign: 'right',
  },
  numberTextSmall: {
    fontSize: 4.5,
    lineHeight: 5.5,
  },
});
