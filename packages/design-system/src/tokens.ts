import type { TextStyle, ViewStyle } from 'react-native';

export const fontFamilies = {
  display: 'SpotlightDisplay',
  bodyRegular: 'SpotlightBodyRegular',
  bodyMedium: 'SpotlightBodyMedium',
  bodySemiBold: 'SpotlightBodySemiBold',
  bodyBold: 'SpotlightBodyBold',
} as const;

export const colors = {
  canvas: '#FCFCFA',
  canvasElevated: '#FFFFFF',
  surface: '#F5F5F0',
  surfaceMuted: 'rgba(254, 227, 51, 0.18)',
  surfaceLight: '#FFFFFF',
  pageLight: '#FCFCFA',
  field: '#F2F1EC',
  fieldLight: '#FFFFFF',
  brand: '#FEE333',
  success: '#2DBB6D',
  info: '#B89A33',
  warning: '#F7C23D',
  danger: '#F27676',
  textPrimary: '#0F0F12',
  textSecondary: '#4D4F57',
  textInverse: '#0F0F12',
  textSecondaryInverse: '#4D4F57',
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
  scannerTextPrimary: '#FFFFFF',
  scannerTextSecondary: 'rgba(255, 255, 255, 0.72)',
  scannerTextMuted: 'rgba(255, 255, 255, 0.58)',
  scannerTextMeta: 'rgba(255, 255, 255, 0.55)',
  scannerGlow: 'rgba(254, 227, 51, 0.14)',
  scannerValuePill: '#8EA086',
} as const;

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

export const layout = {
  pageGutter: 16,
  pageTopInset: 16,
  sectionGap: 16,
  sectionGapLarge: 32,
  titleBodyGap: 14,
  bottomNavHeight: 72,
  bottomNavSideInset: 16,
  bottomNavBottomInset: 16,
  bottomNavIconSize: 52,
  chartCardRadius: 24,
  inventoryTileRadius: 18,
  inventoryArtRadius: 14,
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

export const textStyles = {
  display: {
    ...numericFontVariant,
    fontFamily: fontFamilies.display,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -0.9,
    color: colors.textPrimary,
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
    lineHeight: 20,
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
} as const;

export const spotlightTheme = {
  colors,
  spacing,
  radii,
  layout,
  shadows,
  typography: textStyles,
} as const;

export type SpotlightTheme = typeof spotlightTheme;
