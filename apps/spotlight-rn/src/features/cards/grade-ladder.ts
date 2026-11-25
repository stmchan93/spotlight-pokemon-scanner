import type { CardPriceTrendRow } from '@spotlight/api-client';

export type GradeLadderRung = {
  /** The graded Price Trend row key ("PSA|10|Holofoil" or legacy "PSA 10"). */
  key: string;
  grade: string;
  label: string;
  price: number;
  /** Price minus the raw NM baseline; null without a USD baseline. */
  deltaUsd: number | null;
  /** Price / baseline; null without a USD baseline. */
  multiple: number | null;
  /** 0..1 bar length relative to the ladder's highest price. */
  barRatio: number;
};

export type GradeLadder = {
  baseline: { label: string; price: number } | null;
  rungs: GradeLadderRung[];
};

/** Grade out of a graded row key: pipe keys carry it as the 2nd segment. */
export function gradeFromRowKey(key: string): string | null {
  if (key.includes('|')) {
    return key.split('|')[1]?.trim() || null;
  }
  const [, ...rest] = key.trim().split(/\s+/);
  return rest.join(' ') || null;
}

/** Raw lane's Near Mint row (the ladder's baseline), else its first row. */
export function rawBaselineRow(rows: readonly CardPriceTrendRow[]): CardPriceTrendRow | null {
  const nearMint = rows.find((row) => row.key.split('|').filter(Boolean).pop() === 'NM');
  return nearMint ?? rows[0] ?? null;
}

const isUsdPrice = (row: CardPriceTrendRow | null): row is CardPriceTrendRow & { currentPrice: number } =>
  row != null && row.currencyCode === 'USD' && row.currentPrice != null && row.currentPrice > 0;

/**
 * Raw NM as the baseline, then every priced grade high → low. USD only: a non-USD row
 * is dropped, never shown (no yen anywhere).
 */
export function buildGradeLadder(
  rawRow: CardPriceTrendRow | null,
  gradedRows: readonly CardPriceTrendRow[],
): GradeLadder {
  const baseline = isUsdPrice(rawRow) ? { label: 'Raw · NM', price: rawRow.currentPrice } : null;
  const priced = gradedRows
    .filter(isUsdPrice)
    .map((row) => ({ row, grade: gradeFromRowKey(row.key) ?? row.label }))
    .sort((a, b) => {
      // Best grade first: PSA 10 matters more than 9, then 8.
      const diff = (Number.parseFloat(b.grade) || 0) - (Number.parseFloat(a.grade) || 0);
      return diff !== 0 ? diff : a.grade.localeCompare(b.grade);
    });
  const max = Math.max(baseline?.price ?? 0, ...priced.map(({ row }) => row.currentPrice));
  return {
    baseline,
    rungs: priced.map(({ row, grade }) => ({
      key: row.key,
      grade,
      label: row.label,
      price: row.currentPrice,
      deltaUsd: baseline ? row.currentPrice - baseline.price : null,
      multiple: baseline ? row.currentPrice / baseline.price : null,
      barRatio: max > 0 ? row.currentPrice / max : 0,
    })),
  };
}

/** Condition code of a raw row key: "NM" or "<variant>|NM" → "NM". */
export function rawConditionKey(key: string): string {
  return key.split('|').filter(Boolean).pop() ?? key;
}

export type RawPriceRow = {
  row: CardPriceTrendRow;
  conditionKey: string;
  /** USD price, null when missing or non-USD (never shown). */
  price: number | null;
  isBase: boolean;
  /** Price minus the NM baseline; null on the base row or without USD prices. */
  deltaUsd: number | null;
};

/** The raw conditions in lane order, each with its delta vs Near Mint. */
export function buildRawPriceRows(rows: readonly CardPriceTrendRow[]): RawPriceRow[] {
  const baseline = rawBaselineRow(rows);
  const basePrice = isUsdPrice(baseline) ? baseline.currentPrice : null;
  return rows.map((row) => {
    const isBase = row === baseline;
    const price = isUsdPrice(row) ? row.currentPrice : null;
    return {
      row,
      conditionKey: rawConditionKey(row.key),
      price,
      isBase,
      deltaUsd: !isBase && price != null && basePrice != null ? price - basePrice : null,
    };
  });
}

/** A grader's highest numeric USD-priced grade, e.g. PSA 10 · $310. */
export function topGradeQuote(rows: readonly CardPriceTrendRow[]): { grade: string; price: number } | null {
  let best: { grade: string; price: number; value: number } | null = null;
  for (const row of rows) {
    if (!isUsdPrice(row)) {
      continue;
    }
    const grade = gradeFromRowKey(row.key) ?? row.label;
    const value = Number.parseFloat(grade);
    if (Number.isNaN(value)) {
      continue;
    }
    if (best == null || value > best.value) {
      best = { grade, price: row.currentPrice, value };
    }
  }
  return best ? { grade: best.grade, price: best.price } : null;
}

export function hasUsdPrice(rows: readonly CardPriceTrendRow[]): boolean {
  return rows.some(isUsdPrice);
}

export function formatLadderDelta(deltaUsd: number): string {
  const sign = deltaUsd > 0 ? '+' : deltaUsd < 0 ? '−' : '';
  const abs = Math.abs(deltaUsd);
  return `${sign}$${abs >= 100 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2)}`;
}

export function formatLadderMultiple(multiple: number): string {
  return `${multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}×`;
}
