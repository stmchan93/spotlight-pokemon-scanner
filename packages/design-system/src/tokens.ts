import { PixelRatio, Platform, type TextStyle, type ViewStyle } from 'react-native';

export const fontFamilies = {
  display: 'SpotlightDisplay',
  bodyLight: 'SpotlightBodyLight',
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
  // Color/purple/200 from Figma — the pale lilac stroke of the reticle outline,
  // at both scales (5085:15171 single card, 5085:15376 binder page), and the
  // binder's thirds grid inside it. One step lighter than purple300.
  purple200: '#D9AEFF',
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
  // Spotlight show flyer orange — default Events detail gradient (Figma 5528:731).
  eventAccent: '#FFB005',
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
  // Dims the viewfinder outside the reticle (Figma 5753:17030; 40% per design review 2026-10-18).
  scannerScrim: 'rgba(0, 0, 0, 0.40)',
  scannerTextPrimary: '#FFFFFF',
  scannerTextSecondary: 'rgba(255, 255, 255, 0.72)',
  scannerTextMuted: 'rgba(255, 255, 255, 0.58)',
  scannerTextMeta: 'rgba(255, 255, 255, 0.55)',
  scannerGlow: 'rgba(217, 174, 255, 0.14)',
  scannerValuePill: '#8EA086',
  scannerAddPurple: '#A54BFA',
  scannerConditionPill: '#7A5200',
  /**
   * Non-glass fallback fill for glass chrome (bubbles, button pills) on light
   * pages. Figma 4211:83834 "Fill + Shadow" specs a layered stack —
   * #FFFFFF@65% over #DDDDDD over #F7F7F7 — which composites to this flat
   * gray. The old `canvasElevated` (pure white) fallback vanished on white
   * pages; this one stays visible without imitating glass.
   */
  glassFallback: '#F3F3F3',
  /**
   * White tint painted INTO real Liquid Glass on chrome that floats over live
   * camera / photos. Untinted glass has no floor — it is only as bright as its
   * backdrop, so over a black slab a puck vanished (2026-09-04). ONE value for
   * every puck: at 60% the pucks still swung from mid-gray to white as the
   * camera panned and sat at three different grays in one row ("keeps
   * changing from light to dark", 2026-09-08). 85% then read too flat, so
   * 72% splits the difference: the backdrop gets ~28% say — visible frost,
   * a face that drifts only between light gray and white.
   */
  frostTint: 'rgba(255, 255, 255, 0.72)',
  // Tappable link text over dark/photo backgrounds (profile header cover).
  linkOnDark: '#D6E8FF',
  // Chrome drawn over video thumbnails (VideoTile): the duration badge's
  // scrim and the round play button.
  mediaScrim: 'rgba(0, 0, 0, 0.75)',
  mediaPlayButton: 'rgba(255, 255, 255, 0.9)',
} as const;

/**
 * Match-confidence palette for the scanner change-card modal (Figma
 * Color/green|yellow|red/200–300). Each level pairs a muted `text` color for
 * the hero "% Match" caption with a pastel chip (`chipBg` + dark `chipText`),
 * now used by the Who's That Pokémon result panel. Thresholds live in
 * change-card-picker helpers (<34 red, 34–66 yellow, ≥67 green).
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

// Every rounded surface pairs its radius with `borderCurve: 'continuous'`
// (iOS squircle ≈ Figma 60% corner smoothing; Android ignores the prop).
// Keep the pair together in new styles — View/Pressable styles only, the
// RN/expo Image style types don't accept borderCurve (clip via the wrapper).
export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  // Bottom sheets: TOP corners only, bottom square (Figma 5753:18889).
  sheet: 20,
  pill: 999,
} as const;

export const borderWidths = {
  // Figma specs hairline rules at 0.5pt (e.g. Collection grid, PDP price-trend
  // dividers). Literal 0.5 — NOT StyleSheet.hairlineWidth, which is 1 physical
  // pixel (≈0.33pt on 3x devices) and renders lighter than the spec.
  rule: 0.5,
  // `rule` snapped to whole physical pixels (2px on 3x, 1px on 2x). Use for
  // stacked list dividers: Yoga rounds a 1.5px line to 1px or 2px depending on
  // its y-offset, so plain `rule` rows alternate light/dark.
  ruleSnapped: PixelRatio.roundToNearestPixel(0.5),
  // Standard 1pt container stroke (inventory dropdown shell).
  containerRule: 1,
  // Thick gray-100 band between Social feed blocks and between sections of
  // the pages they open (Meta, News, Set spotlight).
  sectionBand: 4,
} as const;

/**
 * CARD-VIEW GRID (Collection, Wishlist, public profile): white tiles on a
 * gray-50 page, separated by gaps instead of hairlines (Figma 5722:21021).
 * One definition so every surface with a card grid draws the same one.
 */
export const cardGrid = {
  background: colors.gray50,
  gap: 4,
  tileFill: colors.gray0,
  tileRadius: 4,
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
  // PDP hero card art (Figma 4211:86063 "Product Image" — 194x270 r=6).
  heroArtRadius: 6,
  // Raw card-art slot on a list row (`CardListRow`, Figma 4173:82045 — 58x80,
  // radius `inventoryArtRadiusRaw`). Anything that sits in a list beside those
  // rows (the Watchlist Deals band) uses the same slot.
  rowThumbnailWidth: 58,
  rowThumbnailHeight: 80,
  // Width of the action revealed behind a swipe-left row (Delete / Dismiss).
  swipeActionWidth: 88,
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
  // Glass-chrome fallback lift (Figma 4211:83834: drop shadow 0/8, blur 40 @
  // 15%). CALayer's shadowRadius is ~half a Figma blur, hence 20.
  glassPill: {
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: {
      width: 0,
      height: 8,
    },
    elevation: 6,
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
  /*
    Figma library scale (2026-10-18): Plus Jakarta Sans, AUTO line height,
    0 tracking. Line boxes here are round(size × 1.3) so Android never clips a
    descender. The eleven library roles keep their Figma names; everything after
    "non-library" matches text the frames still draw RAW (SemiBold 13/14/15/16,
    Bold 15 prices) and is flagged for the designer in
    docs/type-scale-migration/README.md. Legacy roles alias the nearest library
    role so call sites keep compiling until they are re-roled per screen.
  */
  // Figma "Display" — 29/700. Was ExtraBold 36 with -0.9 tracking.
  display: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 29,
    lineHeight: 38,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Figma "Title-large" — 23/700
  titleLarge: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 23,
    lineHeight: 30,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Title-medium" — 19/600
  titleMedium: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 19,
    lineHeight: 25,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Title-small" — 17/600
  titleSmall: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Body-large" — 16/400
  bodyLarge: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 16,
    lineHeight: 21,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Figma "Body" — 14/400 (was 15/20)
  body: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 14,
    lineHeight: 18,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Figma "Body-medium" — 14/500
  bodyMedium: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 14,
    lineHeight: 18,
    color: colors.gray900,
  } satisfies TextStyle,
  // Figma "Label" — 14/500 (was 13). Color stays the placeholder gray; sites override.
  label: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 14,
    lineHeight: 18,
    color: colors.gray400,
  } satisfies TextStyle,
  // Figma "Caption" — 13/400 (was Medium 12)
  caption: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 13,
    lineHeight: 17,
    color: colors.textSecondary,
  } satisfies TextStyle,
  // Figma "Caption-medium" — 13/500 (was 12)
  captionMedium: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 17,
    color: colors.gray600,
  } satisfies TextStyle,
  // Figma "Overline" — 12/400 (was Medium 11)
  overline: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
    color: colors.textSecondary,
  } satisfies TextStyle,
  // --- non-library: metrics the frames draw raw; no Figma style yet ---
  // Raw Light 12 (Collection balance eyebrow "MAIN COLLECTION", Figma 5938:18043).
  overlineLight: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyLight,
    fontSize: 12,
    lineHeight: 16,
    color: colors.gray600,
  } satisfies TextStyle,
  // Medium 12 — the uppercase "since added"/"since watched" trend suffix.
  overlineMedium: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    lineHeight: 16,
    color: colors.gray600,
  } satisfies TextStyle,
  // Raw Regular 10 (Top Trends game caption "Pokemon", Figma 5768:27141).
  captionTiny: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 10,
    lineHeight: 13,
    color: colors.gray600,
  } satisfies TextStyle,
  // Figma "Body-medium" as set on social post text — 15/500 (5768:27193).
  postBody: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 15,
    lineHeight: 20,
    color: colors.gray800,
  } satisfies TextStyle,
  // Raw Medium 16, uppercase on the PDP ("PRICE TREND", "PRODUCT DETAILS", Figma 5768:21988).
  headlineMedium: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 16,
    lineHeight: 21,
    color: colors.gray900,
  } satisfies TextStyle,
  // Raw SemiBold 16 (post author, section titles). Tray rows should move to titleSmall.
  headline: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 16,
    lineHeight: 21,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Raw SemiBold 15 (mover-tile price, drawer stats)
  bodyStrong: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Raw SemiBold 14 (toolbar titles "WISHLIST", sheet headers)
  titleXsmall: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.gray900,
  } satisfies TextStyle,
  // Raw SemiBold 13 (scanner pills, sheet actions, sold comps). Color applied separately.
  labelStrong: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 13,
    lineHeight: 17,
  } satisfies TextStyle,
  // Raw Bold 15 (list prices "$1,450.12", event card titles). Color applied separately.
  feedRowTitle: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 15,
    lineHeight: 20,
  } satisfies TextStyle,
  // Raw Bold 19 (event detail title)
  detailTitleBold: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 19,
    lineHeight: 25,
    color: colors.gray900,
  } satisfies TextStyle,
  // Raw SemiBold 12 (vendor table ids, feed section links). Color applied separately.
  captionStrong: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 12,
    lineHeight: 16,
  } satisfies TextStyle,
  // Light sibling of "label" — 13/300/normal, uppercase (profile bio, Figma 5938:19528)
  labelLight: {
    fontFamily: fontFamilies.bodyLight,
    fontSize: 13,
    lineHeight: 17,
    textTransform: 'uppercase',
  } satisfies TextStyle,
  // Input placeholder — Light 13 (Figma 5938:21811 "Placeholder Text"). TextInput
  // can't style the placeholder alone, so fields apply this only while empty.
  // Color stays with each field's placeholderTextColor.
  placeholder: {
    fontFamily: fontFamilies.bodyLight,
    fontSize: 13,
    lineHeight: 17,
  } satisfies TextStyle,
  // Bold 12 inventory-tile price
  priceCaption: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textPrimary,
  } satisfies TextStyle,
  micro: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    color: colors.textSecondary,
  } satisfies TextStyle,
  // Raw Regular 11 (vendor tags, news meta)
  cardMeta: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 11,
    lineHeight: 14,
    color: colors.textMuted,
  } satisfies TextStyle,
  // SemiBold sibling of cardMeta. Color applied separately.
  cardMetaStrong: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 11,
    lineHeight: 14,
  } satisfies TextStyle,
  deltaPill: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 9.76,
    letterSpacing: 0,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // Delta pills and outlined chips — 11/600, color applied separately
  chipLabel: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 11,
    lineHeight: 14,
  } satisfies TextStyle,
  // Uppercase status tag — 10/700 (LaneTag RAW / GRADED)
  tag: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 10,
    lineHeight: 13,
  } satisfies TextStyle,
  // Bottom-tab labels (Figma draws them raw SemiBold 10; native tabs own the real bar).
  navLabel: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    color: colors.textPrimary,
  } satisfies TextStyle,
  navLabelSelected: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 11,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // --- legacy aliases: same metrics as a library role; re-role call sites, then delete ---
  // = display
  displayLarge: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 29,
    lineHeight: 38,
    color: colors.gray900,
  } satisfies TextStyle,
  // = titleLarge (was ExtraBold 25)
  title: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 23,
    lineHeight: 30,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // = titleMedium (was ExtraBold 21)
  titleCompact: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 19,
    lineHeight: 25,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // = titleSmall (was Bold 17)
  sectionTitleBold: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.gray900,
  } satisfies TextStyle,
  // = body
  bodySmall: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 14,
    lineHeight: 18,
    color: colors.gray900,
  } satisfies TextStyle,
  // = bodyMedium: Figma buttons are Medium 14 (was SemiBold 15)
  control: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 14,
    lineHeight: 18,
    color: colors.textPrimary,
  } satisfies TextStyle,
  // = overline
  captionRegular: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 12,
    lineHeight: 16,
    color: colors.gray700,
  } satisfies TextStyle,
  // = titleMedium (was ExtraBold 20)
  feedTitle: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 19,
    lineHeight: 25,
  } satisfies TextStyle,
  // = titleLarge (was ExtraBold 24)
  feedPageTitle: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 23,
    lineHeight: 30,
  } satisfies TextStyle,
  // = titleSmall (was ExtraBold 17)
  feedSectionTitle: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 17,
    lineHeight: 22,
  } satisfies TextStyle,
  // = display (was ExtraBold 34)
  feedDeltaLarge: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 29,
    lineHeight: 38,
  } satisfies TextStyle,
  // = titleSmall (was ExtraBold 18)
  feedDelta: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 17,
    lineHeight: 22,
  } satisfies TextStyle,
  // = overline (was ExtraBold 12 tracked)
  feedEyebrow: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
  } satisfies TextStyle,
  // = chipLabel (was ExtraBold 11)
  feedTag: {
    ...numericFontVariant,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 11,
    lineHeight: 14,
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
