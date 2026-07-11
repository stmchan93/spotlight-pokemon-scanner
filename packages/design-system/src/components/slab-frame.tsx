import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';

import { colors, fontFamilies } from '../tokens';
import { getGraderAsset, psaGradeDescriptor } from './grader-wordmark';

/**
 * Slab "case" chrome around a graded card's image.
 *
 * PSA/CGC/BGS/TAG render as PHOTOGRAPHIC composites (the Figma slab mocks,
 * e.g. 2609:6977, are photos of real slabs — no vector treatment reads as
 * "real plastic"): the card image sits under a real empty-slab photo whose
 * card window is transparent, so each case's molded corners, well shadow, and
 * label print come from the photograph; only the label TEXT is drawn
 * dynamically over the blanked areas. Templates were built from straight-on
 * photos of real slabs (scratchpad build_template*.py; the geometry constants
 * below are normalized to each source photo's size).
 *
 * Unknown graders keep the vector frame: a label flag in the grader's color
 * with wordmark + info lines — never breaks.
 */

// ---------------------------------------------------------------------------
// Photographic templates
// ---------------------------------------------------------------------------

type NormBox = { x: number; y: number; w: number; h: number };

// A text slot on a template label: where it sits, how it aligns, and its font
// size as a fraction of the box height.
type TemplateTextBox = NormBox & {
  align: 'left' | 'center' | 'right';
  sizeFactor: number;
  bold?: boolean;
};

type SlabTemplateConfig = {
  source: number;
  /** Transparent cut the card image shows through. */
  cardWindow: NormBox;
  /** Card corner radius as a fraction of the window width. */
  cardCornerRadiusFrac: number;
  /** Label text color (near-black on light labels, near-white on TAG). */
  ink: string;
  /** Up to three info lines (set / name / detail), stacked on a 3-line pitch. */
  infoLines: NormBox;
  /** PSA-style red "#088" collector number (only PSA shows one). */
  numberBox?: TemplateTextBox;
  /** Grade descriptor line ("GEM MT", "GEM MINT", "MINT"...). */
  descriptorBox?: TemplateTextBox;
  /** The grade numeral. */
  gradeBox: TemplateTextBox;
  /** Certification number line. */
  certBox?: TemplateTextBox;
  /** Grade → descriptor text; null/undefined hides the descriptor line. */
  descriptorForGrade: (grade: string) => string | null | undefined;
};

// Grade descriptor scales (exact-match only; unknown grades show no line).
const BGS_DESCRIPTORS: Record<string, string> = {
  '10': 'PRISTINE',
  '9.5': 'GEM MINT',
  '9': 'MINT',
  '8.5': 'NM-MT+',
  '8': 'NM-MT',
  '7.5': 'NM+',
  '7': 'NEAR MINT',
};
const CGC_DESCRIPTORS: Record<string, string> = {
  '10': 'GEM MINT',
  '9.5': 'MINT+',
  '9': 'MINT',
  '8.5': 'NM/MINT+',
  '8': 'NM/MINT',
};
const TAG_DESCRIPTORS: Record<string, string> = {
  '10': 'GEM MINT',
  '9.5': 'MINT+',
  '9': 'MINT',
  '8': 'NM-MINT',
  '7': 'NEAR MINT',
};

const SLAB_TEMPLATES: Record<string, SlabTemplateConfig> = {
  // 714×1236 source photo.
  psa: {
    source: require('../../assets/slabs/psa-slab-template.png'),
    cardWindow: { x: 0.098, y: 0.2718, w: 0.8179, h: 0.6594 },
    cardCornerRadiusFrac: 0.0411,
    ink: '#1A1A1E',
    infoLines: { x: 0.1022, y: 0.0696, w: 0.6611, h: 0.0793 },
    numberBox: { x: 0.8193, y: 0.0696, w: 0.0966, h: 0.0283, align: 'right', sizeFactor: 0.85 },
    descriptorBox: { x: 0.7143, y: 0.0979, w: 0.2017, h: 0.0251, align: 'right', sizeFactor: 0.9 },
    gradeBox: { x: 0.8193, y: 0.123, w: 0.0966, h: 0.0259, align: 'right', sizeFactor: 1.05, bold: true },
    certBox: { x: 0.6653, y: 0.1472, w: 0.2535, h: 0.0275, align: 'right', sizeFactor: 0.85 },
    descriptorForGrade: (grade) => psaGradeDescriptor(grade)?.replace('-', ' '),
  },
  // 722×1244 source photo.
  cgc: {
    source: require('../../assets/slabs/cgc-slab-template.png'),
    cardWindow: { x: 0.1136, y: 0.299, w: 0.8006, h: 0.6334 },
    cardCornerRadiusFrac: 0.0415,
    ink: '#141416',
    infoLines: { x: 0.1427, y: 0.1093, w: 0.5014, h: 0.0916 },
    descriptorBox: { x: 0.6856, y: 0.1125, w: 0.1981, h: 0.0241, align: 'center', sizeFactor: 0.8, bold: true },
    gradeBox: { x: 0.6856, y: 0.1383, w: 0.1981, h: 0.0563, align: 'center', sizeFactor: 0.95, bold: true },
    certBox: { x: 0.464, y: 0.2074, w: 0.1801, h: 0.0225, align: 'center', sizeFactor: 0.8 },
    descriptorForGrade: (grade) => CGC_DESCRIPTORS[grade],
  },
  // 754×1202 source photo. Real BGS labels also print per-category subgrades;
  // we don't have that data, so the subgrade row stays blank gold.
  bgs: {
    source: require('../../assets/slabs/bgs-slab-template.png'),
    cardWindow: { x: 0.1021, y: 0.2313, w: 0.7599, h: 0.6656 },
    cardCornerRadiusFrac: 0.0401,
    ink: '#17150E',
    infoLines: { x: 0.2653, y: 0.0549, w: 0.431, h: 0.0532 },
    descriptorBox: { x: 0.7507, y: 0.1231, w: 0.1645, h: 0.0166, align: 'center', sizeFactor: 0.85, bold: true },
    gradeBox: { x: 0.7507, y: 0.0483, w: 0.1645, h: 0.0732, align: 'center', sizeFactor: 0.95, bold: true },
    certBox: { x: 0.7507, y: 0.1414, w: 0.1645, h: 0.0166, align: 'center', sizeFactor: 0.8 },
    descriptorForGrade: (grade) => BGS_DESCRIPTORS[grade],
  },
  // 462×804 source photo.
  tag: {
    source: require('../../assets/slabs/tag-slab-template.png'),
    cardWindow: { x: 0.0714, y: 0.2711, w: 0.8593, h: 0.6517 },
    cardCornerRadiusFrac: 0.0403,
    ink: '#F4F4F6',
    infoLines: { x: 0.1082, y: 0.107, w: 0.4805, h: 0.0846 },
    descriptorBox: { x: 0.7576, y: 0.1692, w: 0.1299, h: 0.0249, align: 'center', sizeFactor: 0.8, bold: true },
    gradeBox: { x: 0.7576, y: 0.0945, w: 0.1299, h: 0.0771, align: 'center', sizeFactor: 0.95, bold: true },
    descriptorForGrade: (grade) => TAG_DESCRIPTORS[grade],
  },
};

// Beckett entries arrive as either "Beckett" or "BGS".
const TEMPLATE_GRADER_ALIASES: Record<string, string> = { beckett: 'bgs' };

// The card layer is drawn slightly larger than the window so no seam shows;
// the template's opaque well ring hides the overshoot.
const WINDOW_BLEED = 0.008;

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

/** One absolutely-positioned label text slot, sized against the slab height. */
function TemplateText({
  box,
  text,
  ink,
  fontBasis,
  testID,
}: {
  box: TemplateTextBox;
  text: string;
  ink: string;
  fontBasis: number;
  testID?: string;
}) {
  const fontSize = fontBasis * box.h * box.sizeFactor;
  const alignItems =
    box.align === 'left' ? 'flex-start' : box.align === 'right' ? 'flex-end' : 'center';
  return (
    <View style={[boxStyle(box), templateStyles.slot, { alignItems }]}>
      <Text
        // Wide values ("9.5", long cert numbers) shrink to the box instead of
        // ellipsizing — the real label never truncates.
        adjustsFontSizeToFit
        allowFontScaling={false}
        minimumFontScale={0.4}
        numberOfLines={1}
        style={[
          templateStyles.slotText,
          box.bold ? templateStyles.slotTextBold : null,
          { color: ink, fontSize },
        ]}
        testID={testID}
      >
        {text}
      </Text>
    </View>
  );
}

/**
 * The photographic composite: card layer under the transparent-window slab
 * photo, label text drawn over the photo's blanked label areas. Fonts scale
 * with the measured height so the label reads correctly at every slot size.
 */
function TemplateSlab({
  template,
  grade,
  title,
  setLine,
  detailLine,
  cardNumber,
  certNumber,
  children,
  testID,
}: Omit<SlabFrameProps, 'grader' | 'size'> & { template: SlabTemplateConfig }) {
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(event.nativeEvent.layout.height);
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const gradeText = (grade ?? '').trim();
  const descriptor = gradeText ? template.descriptorForGrade(gradeText) : null;
  const numberText = shortCardNumber(cardNumber);
  const certText = (certNumber ?? '').trim();
  const infoLines = [
    (setLine ?? '').trim().toUpperCase(),
    (title ?? '').trim().toUpperCase(),
    (detailLine ?? '').trim().toUpperCase(),
  ].filter(Boolean);

  // Font sizing from the measured height (fractions match each template
  // photo's own label typography). Before the first layout pass a nominal
  // md-tile height sizes the text so nothing pops in.
  const fontBasis = height > 0 ? height : 240;
  // Line pitch = the label's 3-line grid, so 2-line labels stack like the
  // real print instead of spreading.
  const infoPitch = (fontBasis * template.infoLines.h) / 3;
  const infoFont = infoPitch * 0.82;

  return (
    <View onLayout={onLayout} style={templateStyles.root} testID={testID}>
      {/* Card layer, under the template; bleed hides under the well ring. */}
      <View
        style={[
          boxStyle(template.cardWindow, WINDOW_BLEED),
          {
            borderRadius: Math.max(
              2,
              width * template.cardWindow.w * template.cardCornerRadiusFrac,
            ),
            overflow: 'hidden',
          },
        ]}
      >
        {children}
      </View>

      {/* The slab photo: molded case, well shadow, label print. */}
      <Image
        resizeMode="stretch"
        source={template.source}
        style={templateStyles.template}
        testID={testID ? `${testID}-template` : undefined}
      />

      {/* Label text over the photo's blanked areas. */}
      <View style={[boxStyle(template.infoLines), templateStyles.infoColumn]}>
        {infoLines.map((line, index) => (
          <Text
            allowFontScaling={false}
            key={`${index}-${line}`}
            numberOfLines={1}
            style={[
              templateStyles.infoLine,
              { color: template.ink, fontSize: infoFont, lineHeight: infoPitch },
            ]}
          >
            {line}
          </Text>
        ))}
      </View>
      {template.numberBox && numberText ? (
        <TemplateText box={template.numberBox} fontBasis={fontBasis} ink={template.ink} text={numberText} />
      ) : null}
      {template.descriptorBox && descriptor ? (
        <TemplateText box={template.descriptorBox} fontBasis={fontBasis} ink={template.ink} text={descriptor} />
      ) : null}
      {gradeText ? (
        <TemplateText
          box={template.gradeBox}
          fontBasis={fontBasis}
          ink={template.ink}
          testID={testID ? `${testID}-grade` : undefined}
          text={gradeText}
        />
      ) : null}
      {template.certBox && certText ? (
        <TemplateText box={template.certBox} fontBasis={fontBasis} ink={template.ink} text={certText} />
      ) : null}
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

  // Known graders: the photographic composite. Unknown ones: the vector frame.
  const template = SLAB_TEMPLATES[TEMPLATE_GRADER_ALIASES[graderKey] ?? graderKey];
  if (template) {
    return (
      <TemplateSlab
        cardNumber={cardNumber}
        certNumber={certNumber}
        detailLine={detailLine}
        grade={grade}
        setLine={setLine}
        template={template}
        testID={testID}
        title={title}
      >
        {children}
      </TemplateSlab>
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

const templateStyles = StyleSheet.create({
  infoColumn: {
    justifyContent: 'flex-start',
  },
  infoLine: {
    fontFamily: fontFamilies.bodyMedium,
    letterSpacing: 0.1,
  },
  root: {
    flex: 1,
  },
  slot: {
    justifyContent: 'center',
  },
  slotText: {
    fontFamily: fontFamilies.bodyMedium,
  },
  slotTextBold: {
    fontFamily: fontFamilies.bodyBold,
  },
  // NOT StyleSheet.absoluteFill: right/bottom insets resolve to the image's
  // intrinsic size under the grid tile's aspectRatio-derived parents (the
  // template rendered 714pt wide, top-left corner only). Explicit percentage
  // width/height sizes correctly in every hosting context.
  template: {
    height: '100%',
    left: 0,
    position: 'absolute',
    top: 0,
    width: '100%',
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
