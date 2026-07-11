import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';

import { colors, fontFamilies } from '../tokens';
import { getGraderAsset, psaGradeDescriptor } from './grader-wordmark';

/**
 * Slab "case" chrome around a graded card's image.
 *
 * PSA renders as a PHOTOGRAPHIC composite (the Figma slab mocks, e.g.
 * 2609:6977, are photos of real slabs — no vector treatment reads as "real
 * plastic"): the card image sits under a real empty-slab photo whose card
 * window is transparent, so the case's molded corners, well shadow, and label
 * print come from the photograph; only the label TEXT is drawn dynamically.
 * Template built from a straight-on photo of a PSA-slabbed card
 * (tools note: scratchpad build_template.py, geometry below is normalized to
 * that 714×1236 source).
 *
 * Other graders keep the vector frame: a label flag in the grader's color
 * with wordmark + info lines. Graders without bundled art get a neutral
 * label with their name — never breaks.
 */

// ---------------------------------------------------------------------------
// PSA photographic template
// ---------------------------------------------------------------------------

const PSA_TEMPLATE = require('../../assets/slabs/psa-slab-template.png');

// Kill-switch while the composite's on-device layout bug is being reproduced
// on a simulator (2026-07-11: template rendered unconstrained in Collection
// tiles). Vector fallback ships meanwhile; flip back after the fix is proven
// on-device.
const PSA_TEMPLATE_ENABLED = false;

// Normalized geometry of the template photo (fractions of its 714×1236 size).
// cardWindow is the transparent cut the card image shows through; the text
// boxes are the blank label areas the dynamic lines are laid out in.
const T = {
  cardWindow: { x: 0.098, y: 0.2718, w: 0.8179, h: 0.6594 },
  cardCornerRadiusFrac: 0.0411, // of window width
  infoLines: { x: 0.1022, y: 0.0696, w: 0.6611, h: 0.0793 },
  numberBox: { x: 0.8193, y: 0.0696, w: 0.0966, h: 0.0283 },
  descriptorBox: { x: 0.7143, y: 0.0979, w: 0.2017, h: 0.0251 },
  gradeBox: { x: 0.8193, y: 0.123, w: 0.0966, h: 0.0259 },
  certBox: { x: 0.6653, y: 0.1472, w: 0.2535, h: 0.0275 },
} as const;

// The card layer is drawn slightly larger than the window so no seam shows;
// the template's opaque well ring hides the overshoot.
const WINDOW_BLEED = 0.008;

const LABEL_INK = '#1A1A1E';

type NormBox = { x: number; y: number; w: number; h: number };

function boxStyle(box: NormBox, bleed = 0) {
  return {
    height: `${(box.h + bleed * 2) * 100}%` as const,
    left: `${(box.x - bleed) * 100}%` as const,
    position: 'absolute' as const,
    top: `${(box.y - bleed) * 100}%` as const,
    width: `${(box.w + bleed * 2) * 100}%` as const,
  };
}

// ---------------------------------------------------------------------------
// Vector fallback (non-PSA graders)
// ---------------------------------------------------------------------------

type SlabLabelStyle = {
  border: string; // the label's frame color (PSA red, CGC blue, …)
  accent: string; // the #number accent (red on real PSA labels)
};

// The PSA red used for the slab seal + label frame.
const PSA_RED = '#E01B22';

const SLAB_LABEL_STYLES: Record<string, SlabLabelStyle> = {
  psa: { border: PSA_RED, accent: PSA_RED },
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
  /** Certification number — the label's bottom-right line when known. */
  certNumber?: string | null;
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

/**
 * The PSA composite: card layer under the transparent-window slab photo,
 * label text drawn over the photo's blanked label areas. Fonts scale with the
 * measured height so the label reads correctly at every slot size.
 */
function PsaTemplateSlab({
  grade,
  title,
  setLine,
  detailLine,
  cardNumber,
  certNumber,
  children,
  testID,
}: Omit<SlabFrameProps, 'grader' | 'size'>) {
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(event.nativeEvent.layout.height);
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const gradeText = (grade ?? '').trim();
  const descriptor = gradeText ? psaGradeDescriptor(gradeText)?.replace('-', ' ') : null;
  const numberText = shortCardNumber(cardNumber);
  const certText = (certNumber ?? '').trim();
  const infoLines = [
    (setLine ?? '').trim().toUpperCase(),
    (title ?? '').trim().toUpperCase(),
    (detailLine ?? '').trim().toUpperCase(),
  ].filter(Boolean);

  // Font sizing from the measured height (fractions match the template photo's
  // own label typography). Before the first layout pass a nominal md-tile
  // height sizes the text so nothing pops in.
  const fontBasis = height > 0 ? height : 240;
  const infoFont = fontBasis * 0.0217;
  const rightColFonts = {
    number: fontBasis * 0.024,
    descriptor: fontBasis * 0.0226,
    grade: fontBasis * 0.0272,
    cert: fontBasis * 0.0234,
  };

  return (
    <View onLayout={onLayout} style={psaTemplateStyles.root} testID={testID}>
      {/* Card layer, under the template; bleed hides under the well ring. */}
      <View
        style={[
          boxStyle(T.cardWindow, WINDOW_BLEED),
          {
            borderRadius: Math.max(2, width * T.cardWindow.w * T.cardCornerRadiusFrac),
            overflow: 'hidden',
          },
        ]}
      >
        {children}
      </View>

      {/* The slab photo: molded case, well shadow, label print. */}
      <Image
        resizeMode="stretch"
        source={PSA_TEMPLATE}
        style={StyleSheet.absoluteFill}
        testID={testID ? `${testID}-template` : undefined}
      />

      {/* Label text over the photo's blanked areas. */}
      <>
        <View style={[boxStyle(T.infoLines), psaTemplateStyles.infoColumn]}>
            {infoLines.map((line, index) => (
              <Text
                allowFontScaling={false}
                key={`${index}-${line}`}
                numberOfLines={1}
                style={[psaTemplateStyles.infoLine, { fontSize: infoFont, lineHeight: infoFont * 1.22 }]}
              >
                {line}
              </Text>
            ))}
          </View>
          {numberText ? (
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              style={[
                boxStyle(T.numberBox),
                psaTemplateStyles.rightText,
                { fontSize: rightColFonts.number, lineHeight: rightColFonts.number * 1.15 },
              ]}
            >
              {numberText}
            </Text>
          ) : null}
          {descriptor ? (
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              style={[
                boxStyle(T.descriptorBox),
                psaTemplateStyles.rightText,
                { fontSize: rightColFonts.descriptor, lineHeight: rightColFonts.descriptor * 1.1 },
              ]}
            >
              {descriptor}
            </Text>
          ) : null}
          {gradeText ? (
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              style={[
                boxStyle(T.gradeBox),
                psaTemplateStyles.rightText,
                psaTemplateStyles.gradeBold,
                { fontSize: rightColFonts.grade, lineHeight: rightColFonts.grade * 1.1 },
              ]}
              testID={testID ? `${testID}-grade` : undefined}
            >
              {gradeText}
            </Text>
          ) : null}
          {certText ? (
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              style={[
                boxStyle(T.certBox),
                psaTemplateStyles.rightText,
                { fontSize: rightColFonts.cert, lineHeight: rightColFonts.cert * 1.15 },
              ]}
            >
              {certText}
            </Text>
          ) : null}
      </>
    </View>
  );
}

export function SlabFrame({
  grader,
  grade,
  title,
  setLine,
  detailLine,
  cardNumber,
  certNumber,
  size = 'md',
  children,
  testID,
}: SlabFrameProps) {
  const graderKey = grader.trim().toLowerCase();

  // PSA: the photographic composite. Other graders: the vector frame until
  // they get their own template photos.
  if (graderKey === 'psa' && PSA_TEMPLATE_ENABLED) {
    return (
      <PsaTemplateSlab
        cardNumber={cardNumber}
        certNumber={certNumber}
        detailLine={detailLine}
        grade={grade}
        setLine={setLine}
        testID={testID}
        title={title}
      >
        {children}
      </PsaTemplateSlab>
    );
  }

  const label = SLAB_LABEL_STYLES[graderKey] ?? NEUTRAL_LABEL;
  const asset = getGraderAsset(grader);
  const gradeText = (grade ?? '').trim();
  const isSmall = size === 'sm';
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
        {/* Card-info lines (set / name / rarity), like the real label. */}
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

        {/* Right: #number over the grade. */}
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

const psaTemplateStyles = StyleSheet.create({
  gradeBold: {
    fontFamily: fontFamilies.bodyBold,
  },
  infoColumn: {
    justifyContent: 'space-between',
  },
  infoLine: {
    color: LABEL_INK,
    fontFamily: fontFamilies.bodyMedium,
    letterSpacing: 0.1,
  },
  rightText: {
    color: LABEL_INK,
    fontFamily: fontFamilies.bodyMedium,
    textAlign: 'right',
  },
  root: {
    flex: 1,
  },
});

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
