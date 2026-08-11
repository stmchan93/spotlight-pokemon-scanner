import type { TextStyle, ViewStyle } from 'react-native';

export const fontFamilies = {
  display: 'SpotlightDisplay',
  bodyRegular: 'SpotlightBodyRegular',
  bodyMedium: 'SpotlightBodyMedium',
  bodySemiBold: 'SpotlightBodySemiBold',
  bodyBold: 'SpotlightBodyBold',
} as const;

export const colors = {
  // Page background is PURE white everywhere outside the scanner. It used to be
  // the warm off-white #FCFCFA, which read as a visible seam anywhere it met a
  // true-white surface — most obviously as a "border" around the centered logo
  // on the splash / auth-loading handoff. Keep `canvas` and the native splash
  // `backgroundColor` in app.json identical, or that seam comes back.
  canvas: '#FFFFFF',
  canvasElevated: '#FFFFFF',
  surface: '#F5F5F0',
  surfaceMuted: 'rgba(217, 174, 255, 0.18)',
  surfaceLight: '#FFFFFF',
  pageLight: '#FFFFFF',
  field: '#F2F1EC',
  fieldLight: '#FFFFFF',
  brand: '#D9AEFF',
  // Saturated violet for high-emphasis SOLID fills (primary Button). The pale
  // `brand` lilac reads low-emphasis as a button fill, so primary buttons use
  // this darker purple with a white label (~6.7:1 contrast). From Figma.
  brandStrong: '#7000FF',
  brandPurple: '#4B3FD8',
  // Color/purple/50 from Figma — the pale lavender fill behind the SELECTED row
  // in the grade/condition picker (Figma 1664:2597). Lighter than `brand`.
  purple50: '#F7EEFF',
  // Color/purple/300 from Figma — the lilac used for the change-card modal's
  // hero/selected-row borders and the "LOAD MORE" outline. Brighter than the
  // pale `brand` fill, dimmer than `brandStrong`.
  purple300: '#C47EFF',
  // Color/purple/500 from Figma — the saturated purple used for the scanner
  // "Scanning for" sheet's SELECTED radio (ring + inner dot). Brighter/more
  // saturated than purple300; matches scannerAddPurple but named per the Figma
  // color ramp so the radio's selected tone reads from a documented token.
  // Also the PDP ADD ITEM accent Button fill (Figma Color/purple/500).
  purple500: '#A54BFA',
  chartLine: '#9B5FE6',
  success: '#2DBB6D',
  info: '#B89A33',
  warning: '#F7C23D',
  danger: '#F27676',
  gray0: '#FFFFFF',
  gray50: '#F7F7F7',
  gray100: '#F2F2F2',
  gray200: '#E8E8E8',
  gray300: '#D4D4D4',
  gray400: '#BEBEBE',
  gray500: '#A0A0A0',
  gray600: '#717171',
  gray700: '#4A4A4A',
  gray800: '#2E2E2E',
  gray900: '#1A1A1A',
  yellow50: '#FFFBF0',
  // Color/yellow/400 from Figma — the scan-tray swipe rail's "Collection"
  // action chip fill (Figma 1768:4057).
  yellow400: '#FFC233',
  green100: '#E2F4E8',
  green400: '#4CAF6E',
  red100: '#FDECEC',
  red400: '#E0524C',
  dangerStrong: '#D93025',
  // Figma delta-pill ramp (Color/green|red/50 fill + 500 text) used by the
  // card list row's price-change pill.
  green50: '#F4FAF6',
  green500: '#2D9148',
  red50: '#FFF7F7',
  red500: '#D93025',
  // Current Figma delta-pill ramp (Color/green|red 100 fill + 600 text) — the
  // price-change pill on list rows + card tiles (Figma 1263:3132 / 1263:3381).
  deltaUpSurface: '#E2F4E8',
  deltaUpText: '#1E7A3C',
  deltaDownSurface: '#FFE9E9',
  deltaDownText: '#B22416',
  // Blue ramp from Figma (Color/blue/100 + Color/blue/500). Used for the
  // "traded" transaction badge; 100 = pale fill, 400 = saturated text/icon.
  blue100: '#ADCFFF',
  blue400: '#1A6FE8',
  textPrimary: '#1A1A1A',
  textSecondary: '#4D4F57',
  textMuted: '#4A4A4A',
  textInverse: '#1A1A1A',
  textSecondaryInverse: '#4D4F57',
  greenDelta: '#4CAF6E',
  redDelta: '#E0524C',
  starFavorited: '#F5C518',
  starOutline: '#BEBEBE',
  searchBorder: '#BEBEBE',
  outlineSubtle: 'rgba(0, 0, 0, 0.08)',
  outlineStrong: 'rgba(0, 0, 0, 0.16)',
  outlineLight: 'rgba(0, 0, 0, 0.08)',
  chartGuide: 'rgba(17, 17, 20, 0.16)',
  chartGrid: 'rgba(17, 17, 20, 0.08)',
  chartAxisLabel: 'rgba(17, 17, 20, 0.48)',
  scannerCanvas: '#050505',
  scannerTray: '#000000',
  scannerSurface: 'rgba(255, 255, 255, 0.04)',
  scannerSurfaceMuted: 'rgba(255, 255, 255, 0.03)',
  scannerSurfaceStrong: 'rgba(255, 255, 255, 0.08)',
  scannerOutline: 'rgba(255, 255, 255, 0.08)',
  scannerOutlineSubtle: 'rgba(255, 255, 255, 0.05)',
  /**
   * Fill for chrome floating over the live viewfinder — the EN/JP pill, the
   * selected zoom pill, the SCAN/TOTAL labels.
   *
   * Also the `fallbackColor` those surfaces hand to `GlassSurface`: iOS 26 gets
   * real Liquid Glass, and everything else (iOS < 26, Android) gets THIS, which
   * is byte-identical to what shipped before glass existed. A translucent dark
   * scrim is the native treatment for camera chrome on Android, so the fallback
   * is the right answer there rather than a downgrade.
   *
   * Previously three hard-coded `rgba(0, 0, 0, 0.35)` literals in two files.
   */
  scannerChromeFill: 'rgba(0, 0, 0, 0.35)',
  scannerTextPrimary: '#FFFFFF',
  scannerTextSecondary: 'rgba(255, 255, 255, 0.72)',
  scannerTextMuted: 'rgba(255, 255, 255, 0.58)',
  scannerTextMeta: 'rgba(255, 255, 255, 0.55)',
  scannerGlow: 'rgba(217, 174, 255, 0.14)',
  scannerValuePill: '#8EA086',
  scannerAddPurple: '#A54BFA',
  scannerConditionPill: '#7A5200',
} as const;

/**
 * Match-confidence palette for the scanner change-card modal (Figma
 * Color/green|yellow|red/200–300). Each level pairs a muted `text` color for
 * the hero "% Match" caption with a pastel chip (`chipBg` + dark `chipText`)
 * for the per-candidate row badge. Thresholds live in change-card-picker
 * helpers (<34 red, 34–66 yellow, ≥67 green).
 */
export const matchConfidence = {
  green: { text: '#86C99A', chipBg: '#BBE5C8', chipText: '#0C3D1D' },
  yellow: { text: '#E2C46B', chipBg: '#FFE799', chipText: '#7A5200' },
  red: { text: '#E89A91', chipBg: '#FFCECE', chipText: '#67140B' },
} as const;

export type MatchConfidenceLevel = keyof typeof matchConfidence;

export const spacing = {
  xxxs: 4,
  xxs: 8,
  xs: 12,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 28,
  xxl: 32,
  xxxl: 40,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  pill: 999,
} as const;

export const borderWidths = {
  // Figma specs hairline rules at 0.5pt (e.g. Collection grid, PDP price-trend
  // dividers). Literal 0.5 — NOT StyleSheet.hairlineWidth, which is 1 physical
  // pixel (≈0.33pt on 3x devices) and renders lighter than the spec.
  rule: 0.5,
  // Standard 1pt container stroke (inventory dropdown shell, pop-report cells).
  containerRule: 1,
} as const;

export const layout = {
  pageGutter: 16,
  pageTopInset: 16,
  sectionGap: 16,
  sectionGapLarge: 32,
  titleBodyGap: 14,
  bottomNavHeight: 72,
  bottomNavSideInset: 16,
  // Rest gap between the floating nav pill and the safe-area edge. Kept tight
  // (Reddit-style) so the pill hugs the bottom of the screen.
  bottomNavBottomInset: 6,
  bottomNavIconSize: 52,
  chartCardRadius: 24,
  inventoryTileRadius: 18,
  // Card-art corner radius on grid tiles (Figma 2609:7016 / 2609:6977): raw
  // card scans get a subtle 2, slab photos stay square — the PSA case in the
  // photo has its own shape and rounding would clip it.
  inventoryArtRadiusRaw: 2,
  inventoryArtRadiusSlab: 0,
  recentSaleHeight: 96,
  recentSaleImageWidth: 72,
  recentSaleImageHeight: 96,
} as const;

export const shadows = {
  card: {
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: {
      width: 0,
      height: 6,
    },
    elevation: 3,
  } satisfies ViewStyle,
} as const;

const numericFontVariant = {
  fontVariant: ['tabular-nums', 'lining-nums'] as TextStyle['fontVariant'],
} as const;

/**
 * Ceiling on iOS/Android Dynamic Type scaling. Allows modest accessibility
 * growth without letting large system fonts blow up our fixed-size layouts
 * (absolute fontSize + baked lineHeight tokens). Applied globally at the app
 * root and on the shared text primitives; nudge here to loosen/tighten.
 */
export const MAX_FONT_SIZE_MULTIPLIER = 1.2;

export const textStyles = {
  display: {
    ...numericFontVariant,
    fontFamily: fontFamilies.display,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -0.9,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Figma "Display" — 28/700/120% gray-900
  displayLarge: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 28,
    lineHeight: 33.6,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Title-medium" — 18/600/130% gray-900
  // Figma "Title-large" — 22/700/125% gray-900
  titleLarge: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 22,
    lineHeight: 27.5,
    color: colors.gray900,
  } satisfies TextStyle,
  titleMedium: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 18,
    lineHeight: 23.4,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Title-small" — 16/600/135% gray-900
  titleSmall: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 16,
    lineHeight: 21.6,
    color: colors.gray900,
  } satisfies TextStyle,
  // Compact sheet title — 14/600 gray-900 (Figma New Post header 3147:10838).
  titleXsmall: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 14,
    lineHeight: 21,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Body-medium" — 14/500/150% gray-900
  bodyMedium: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 14,
    lineHeight: 21,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Body" — 14/400/150% gray-900. The regular-weight sibling of
  // `bodyMedium`, and a genuinely different role from `body` (15/400): Figma
  // uses it for long-form copy that sits UNDER a 14/500 label, e.g. the social
  // post body under the author name (Figma 3505:14436).
  bodySmall: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 14,
    lineHeight: 21,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Caption-medium" — 12/500/140% gray-600
  captionMedium: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    lineHeight: 16.8,
    color: colors.gray600,
  } satisfies TextStyle,
  title: {
    ...numericFontVariant,
    fontFamily: fontFamilies.display,
    fontSize: 25,
    lineHeight: 30,
    letterSpacing: -0.55,
    color: colors.textPrimary,
  } satisfies TextStyle,
  titleCompact: {
    ...numericFontVariant,
    fontFamily: fontFamilies.display,
    fontSize: 21,
    lineHeight: 26,
    letterSpacing: -0.35,
    color: colors.textPrimary,
  } satisfies TextStyle,
  headline: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 16,
    lineHeight: 21.6,
    color: colors.textPrimary,
  } satisfies TextStyle,
  body: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 15,
    lineHeight: 20,
    color: colors.textPrimary,
  } satisfies TextStyle,
  bodyStrong: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.textPrimary,
  } satisfies TextStyle,
  control: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.textPrimary,
  } satisfies TextStyle,
  caption: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
  } satisfies TextStyle,
  micro: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    color: colors.textSecondary,
  } satisfies TextStyle,
  overline: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14.3,
    letterSpacing: 0,
    color: colors.textSecondary,
  } satisfies TextStyle,
  cardMeta: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 11,
    lineHeight: 14.3,
    color: colors.textMuted,
  } satisfies TextStyle,
  deltaPill: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 9.76,
    letterSpacing: 0,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Search field placeholder + input — 13/500/140% gray-400 per Figma "Label"
  label: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18.2,
    color: colors.gray400,
  } satisfies TextStyle,
  // SemiBold sibling of "label" — 13/600/140%, color applied separately
  labelStrong: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 13,
    lineHeight: 18.2,
  } satisfies TextStyle,
  // Bold caption used for the inventory tile market price — 12/700/140% gray-900
  priceCaption: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 12,
    lineHeight: 16.8,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Bottom-tab label, unselected — 11/500 (Medium) per Figma nav spec.
  navLabel: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Bottom-tab label, selected — 11/600 (SemiBold). Same color; weight conveys
  // selection alongside the filled icon.
  navLabelSelected: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 11,
    color: colors.textPrimary,
  } satisfies TextStyle,
} as const;

export const spotlightTheme = {
  colors,
  spacing,
  radii,
  borderWidths,
  layout,
  shadows,
  typography: textStyles,
} as const;

export type SpotlightTheme = typeof spotlightTheme;
