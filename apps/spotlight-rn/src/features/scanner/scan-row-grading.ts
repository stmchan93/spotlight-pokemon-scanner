import {
  deckConditionOptions,
  type CardPriceTrendRow,
  type DeckConditionCode,
  type RawPricingMatrixVariant,
  type SlabContext,
} from '@spotlight/api-client';

import type { ScannerMode } from './screens/scanner-screen-types';

/**
 * A tray row's grading pick: the row's grader dropdown + its second dropdown.
 *
 * Stored on the row's price selection as `grading`. ABSENT means "the scan's
 * own default" (RAW for a raw scan, the detected grader + grade for a slab);
 * `grader: null` is an explicit RAW pick (only needed on a slab scan, whose
 * default is graded). `marketPrice` is the stored graded price for
 * grader + grade: undefined = not looked up yet, null = no USD price.
 */
export type ScanRowGrading = {
  grader: string | null;
  grade: string | null;
  marketPrice?: number | null;
};

export const SCAN_ROW_RAW_KEY = 'RAW';
export const SCAN_ROW_GRADERS = ['PSA', 'CGC', 'BGS', 'SGC', 'TAG'] as const;
export const SCAN_ROW_DEFAULT_GRADE = '10';
// 10, 9.5, 9 … 1.
export const SCAN_ROW_GRADES: readonly string[] = Array.from(
  { length: 19 },
  (_, index) => String(10 - index * 0.5),
);

export type ScanRowOption = { key: string; label: string };

export const scanRowGraderOptions: readonly ScanRowOption[] = [
  { key: SCAN_ROW_RAW_KEY, label: 'RAW' },
  ...SCAN_ROW_GRADERS.map((grader) => ({ key: grader, label: grader })),
];

export const scanRowGradeOptions: readonly ScanRowOption[] = SCAN_ROW_GRADES.map((grade) => ({
  key: grade,
  label: grade,
}));

// Keys are the pricing matrix's condition codes, so a pick prices straight off it.
const conditionMatrixCodes: Record<DeckConditionCode, string> = {
  near_mint: 'NM',
  lightly_played: 'LP',
  moderately_played: 'MP',
  heavily_played: 'HP',
  damaged: 'DM',
};

export const scanRowConditionOptions: readonly ScanRowOption[] = deckConditionOptions.map((option) => ({
  key: conditionMatrixCodes[option.code],
  label: option.shortLabel,
}));

export function conditionMatrixCode(code: DeckConditionCode | null | undefined): string {
  return conditionMatrixCodes[code ?? 'near_mint'] ?? 'NM';
}

export function conditionShortLabelFor(code: DeckConditionCode | null | undefined): string {
  return deckConditionOptions.find((option) => option.code === (code ?? 'near_mint'))?.shortLabel ?? 'NM';
}

function deckConditionForMatrixCode(code: string): DeckConditionCode {
  const match = (Object.keys(conditionMatrixCodes) as DeckConditionCode[])
    .find((deckCode) => conditionMatrixCodes[deckCode] === code);
  return match ?? 'near_mint';
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Same grade written two ways ("9" vs "9.0") compares equal. */
export function sameGrade(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = cleanText(a);
  const right = cleanText(b);
  if (!left || !right) {
    return left === right;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber === rightNumber;
  }
  return left.toUpperCase() === right.toUpperCase();
}

type GradingCapture = {
  mode: ScannerMode;
  slabContext: SlabContext | null;
};

/** What the row starts on before any pick: RAW, or the slab's own label. */
export function scanDefaultGrading(capture: GradingCapture): { grader: string | null; grade: string | null } {
  const grader = cleanText(capture.slabContext?.grader)?.toUpperCase() ?? null;
  if (capture.mode !== 'slabs' && !grader) {
    return { grader: null, grade: null };
  }
  return { grader, grade: cleanText(capture.slabContext?.grade) };
}

/** The grader + grade the row is on right now (null grader = RAW). */
export function effectiveScanRowGrading(
  capture: GradingCapture,
  selection: { grading?: ScanRowGrading | null } | null | undefined,
): { grader: string | null; grade: string | null; isScanDefault: boolean } {
  const grading = selection?.grading;
  if (grading) {
    return {
      grader: grading.grader,
      grade: grading.grader ? grading.grade ?? SCAN_ROW_DEFAULT_GRADE : null,
      isScanDefault: false,
    };
  }
  return { ...scanDefaultGrading(capture), isScanDefault: true };
}

/**
 * The graded price for `grade` out of one grader's `price-trends` rows (keys
 * "<grader> <grade>"). USD only: the backend converts what it can and leaves a
 * row in its native currency when no FX rate is cached — that row is dropped,
 * never shown as yen.
 */
export function gradedPriceFromTrendRows(
  rows: readonly CardPriceTrendRow[] | null | undefined,
  grader: string,
  grade: string,
): number | null {
  const match = (rows ?? []).find((row) => {
    const [rowGrader, ...rest] = String(row.key ?? '').replace('|', ' ').trim().split(/\s+/);
    return rowGrader?.toUpperCase() === grader.toUpperCase() && sameGrade(rest.join(' '), grade);
  });
  if (!match || match.currencyCode !== 'USD') {
    return null;
  }
  const price = match.currentPrice;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

/** Structural selection shape this module needs (see ScanPriceSheetSelection). */
export type GradableSelection = {
  variantKey: string;
  variantLabel: string;
  variantIsNonDefault?: boolean;
  conditionCode: DeckConditionCode;
  conditionShortLabel: string;
  marketPrice: number | null;
  grading?: ScanRowGrading;
};

function selectionForCondition(
  variant: RawPricingMatrixVariant | null,
  matrixCode: string,
  previous: GradableSelection | null,
): GradableSelection {
  const conditionCode = deckConditionForMatrixCode(matrixCode);
  const conditionShortLabel = conditionShortLabelFor(conditionCode);
  if (!variant) {
    // No matrix yet: no printing named (empty key/label = "none chosen").
    return {
      variantKey: previous?.variantKey ?? '',
      variantLabel: previous?.variantLabel ?? '',
      ...(previous?.variantIsNonDefault != null ? { variantIsNonDefault: previous.variantIsNonDefault } : {}),
      conditionCode,
      conditionShortLabel,
      marketPrice: null,
    };
  }
  const market = variant.conditions.find((entry) => entry.code === matrixCode)?.market ?? null;
  return {
    variantKey: variant.variantKey,
    variantLabel: variant.variant,
    ...(previous?.variantIsNonDefault != null ? { variantIsNonDefault: previous.variantIsNonDefault } : {}),
    conditionCode,
    conditionShortLabel,
    marketPrice: market,
  };
}

function withGrading(
  base: GradableSelection,
  grading: ScanRowGrading | undefined,
): GradableSelection {
  const { grading: _dropped, ...rest } = base;
  return grading ? { ...rest, grading } : rest;
}

/**
 * Applies a pick from either row dropdown. `kind` 'grader' is the first
 * dropdown (RAW/PSA/…); 'detail' is the second (a condition on RAW, a grade
 * otherwise). Returns the row's next selection, `previous` itself when the
 * pick changes nothing, or null when the row is back on its untouched default.
 * The printing stays the row's own (`previous.variantKey`, else the matrix's
 * first) unless it has no price for a picked condition (see printingPricing)
 * — the tray no longer offers a printing picker.
 */
export function applyScanRowGradingPick(
  capture: GradingCapture,
  previous: GradableSelection | null,
  variants: readonly RawPricingMatrixVariant[],
  kind: 'grader' | 'detail',
  key: string,
): GradableSelection | null {
  const scanDefault = scanDefaultGrading(capture);
  const current = effectiveScanRowGrading(capture, previous);
  const variant = variants.find((entry) => entry.variantKey === previous?.variantKey) ?? variants[0] ?? null;
  const base = previous ?? selectionForCondition(variant, 'NM', null);
  const isScanDefault = (grader: string | null, grade: string | null) => (
    grader === scanDefault.grader && (grader == null || sameGrade(grade, scanDefault.grade))
  );
  const finish = (grading: ScanRowGrading | undefined, nextBase: GradableSelection) => {
    // Untouched raw row picked back to RAW/NM: drop the entry entirely.
    if (!grading && !previous && nextBase === base) {
      return null;
    }
    return withGrading(nextBase, grading);
  };

  if (kind === 'grader') {
    const grader = key === SCAN_ROW_RAW_KEY ? null : key.toUpperCase();
    if (grader === current.grader) {
      return previous;
    }
    if (!grader) {
      return finish(isScanDefault(null, null) ? undefined : { grader: null, grade: null }, base);
    }
    const grade = (grader === scanDefault.grader ? scanDefault.grade : null)
      ?? (current.grader ? current.grade : null)
      ?? SCAN_ROW_DEFAULT_GRADE;
    return finish(isScanDefault(grader, grade) ? undefined : { grader, grade }, base);
  }

  if (current.grader) {
    if (sameGrade(key, current.grade)) {
      return previous;
    }
    return finish(isScanDefault(current.grader, key) ? undefined : { grader: current.grader, grade: key }, base);
  }

  if (previous && conditionMatrixCode(previous.conditionCode) === key) {
    return previous;
  }
  return finish(previous?.grading, selectionForCondition(printingPricing(variants, variant, key), key, previous));
}

function conditionMarket(variant: RawPricingMatrixVariant, matrixCode: string): number | null {
  const market = variant.conditions.find((entry) => entry.code === matrixCode)?.market;
  return typeof market === 'number' && Number.isFinite(market) && market > 0 ? market : null;
}

/**
 * The printing a condition pick prices from: the row's own when it has that
 * condition, else the highest-priority printing that does (the matrix comes
 * ordered best-first). Base Set Charizard listed an NM-only "Holofoil" ahead
 * of "Unlimited Holofoil"'s full ladder, so LP on the first found nothing and
 * the row kept the NM price under an LP label. No printing has it: the row's
 * own, and the price shows "—".
 */
function printingPricing(
  variants: readonly RawPricingMatrixVariant[],
  current: RawPricingMatrixVariant | null,
  matrixCode: string,
): RawPricingMatrixVariant | null {
  if (!current || conditionMarket(current, matrixCode) != null) {
    return current;
  }
  return variants.find((entry) => conditionMarket(entry, matrixCode) != null) ?? current;
}

export type ScanRowInventoryTarget = {
  mode: ScannerMode;
  slabContext: SlabContext | null;
  /** Null for graded adds — a slab has a grade, not a condition. */
  conditionCode: DeckConditionCode | null;
};

/**
 * What an ADD files the row as. A grader pick on a raw scan becomes a graded
 * holding (slabContext + no condition), the same payload the card page sends;
 * a slab scan left on its own grade keeps its detected slab (cert included).
 */
export function scanRowInventoryTarget(
  capture: GradingCapture,
  selection: { conditionCode?: DeckConditionCode; grading?: ScanRowGrading | null } | null | undefined,
): ScanRowInventoryTarget {
  const conditionCode = selection?.conditionCode ?? 'near_mint';
  const grading = selection?.grading;
  if (!grading) {
    return capture.mode === 'slabs'
      ? { mode: 'slabs', slabContext: capture.slabContext, conditionCode: null }
      : { mode: 'raw', slabContext: capture.slabContext, conditionCode };
  }
  if (!grading.grader) {
    return { mode: 'raw', slabContext: null, conditionCode };
  }
  const grade = grading.grade ?? SCAN_ROW_DEFAULT_GRADE;
  return {
    mode: 'slabs',
    slabContext: {
      grader: grading.grader,
      grade,
      certNumber: null,
      // Same as the card page's graded add; the backend drops a grade-label
      // variant name and files the base printing's graded entry.
      variantName: `${grading.grader} ${grade}`,
    },
    conditionCode: null,
  };
}

/** Persisted `grading` check: older rows have none, which is valid. */
export function isPersistedScanRowGrading(value: unknown): value is ScanRowGrading {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const grading = value as ScanRowGrading;
  return (
    (grading.grader === null || typeof grading.grader === 'string')
    && (grading.grade === null || typeof grading.grade === 'string')
    && (grading.marketPrice === undefined || grading.marketPrice === null || typeof grading.marketPrice === 'number')
  );
}
