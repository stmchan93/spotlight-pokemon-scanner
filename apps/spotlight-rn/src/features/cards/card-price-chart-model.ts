import {
  deckConditionOptions,
  type CardConditionHistory,
  type CardConditionHistorySeries,
  type CardPriceTrendMode,
  type CardPriceTrendRow,
  type CardRecentSalesRecord,
} from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/**
 * Pure helpers behind the PDP price chart section: series selection, range
 * slicing, the resting/scrub readouts, and the theme decision. No React here.
 */

export type ChartPoint = { t: number; v: number };

// No ALL: the condition-history endpoint caps its lookback at 365 days.
export const priceChartRanges = ['1W', '1M', '3M', '1Y'] as const;
export type PriceChartRange = (typeof priceChartRanges)[number];
export const defaultPriceChartRange: PriceChartRange = '1M';

const DAY_MS = 86_400_000;
const rangeDays: Record<PriceChartRange, number> = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365 };
const rangeCaption: Record<PriceChartRange, string> = {
  '1W': 'Past week',
  '1M': 'Past month',
  '3M': 'Past 3 months',
  '1Y': 'Past year',
};

/** A price line whose newest point is older than this reads "No recent prices" on every range. */
export const staleLineAfterDays = 14;

/** Below this many sales in the window a graded chart is grey and shows no trend. */
export const minGradedSalesForTrend = 3;

export type ChartTone = 'up' | 'down' | 'neutral';
export type ChartDirection = 'up' | 'down' | 'flat';

/**
 * "2026-10-12", "2026/10/12" or a full ISO timestamp → that calendar day at
 * local noon. Day-level on purpose: history cells are dated by day, and a sale's
 * label should read the day it sold whatever the device's timezone.
 */
export function parseCalendarDayMs(value?: string | null): number | null {
  const match = (value ?? '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) {
    return null;
  }
  const time = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime();
  return Number.isNaN(time) ? null : time;
}

/** "Oct 12"; the year is added when it isn't the current one ("Oct 12, 2024"). */
export function formatChartDate(ms: number, nowMs: number = Date.now()): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Reduces a printing label ("1st Edition Holofoil") or a stored variant key
 * ("firstEditionHolofoil") to one comparable key — the client twin of the
 * backend's `_variant_match_key` plus its edition spelling fix. Normal/blank
 * collapse to "" (the default printing).
 */
export function variantMatchKey(value?: string | null): string {
  const key = (value ?? '').replace(/\b1st\b/gi, 'first').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key === 'raw' || key === 'normal' || key === 'standard' ? '' : key;
}

/** "NM", "near_mint" and "Near Mint" all → "NM". */
export function conditionMatchKey(value?: string | null): string {
  const trimmed = (value ?? '').trim();
  const lower = trimmed.toLowerCase();
  const option = deckConditionOptions.find((candidate) => (
    candidate.code === lower
    || candidate.shortLabel.toLowerCase() === lower
    || candidate.label.toLowerCase() === lower
  ));
  return option?.shortLabel ?? trimmed.toUpperCase();
}

export type PriceChartRowIdentity =
  | { mode: 'raw'; condition: string }
  | { mode: 'graded'; grader: string; grade: string; variantName: string | null };

/**
 * Parses a Price Trend row key. Raw: "NM" or "<variantKey>|NM". Graded:
 * "PSA 10" (older backends) or "PSA|10|<variantKey>"; a key without the
 * printing segment falls back to the page's selected printing — the same rule
 * the screen's expanded-row comps fetch uses.
 */
export function rowIdentity(
  mode: CardPriceTrendMode,
  rowKey: string,
  fallbackVariant: string | null,
): PriceChartRowIdentity | null {
  if (mode === 'raw') {
    const condition = rowKey.split('|').filter(Boolean).pop();
    return condition ? { mode, condition: conditionMatchKey(condition) } : null;
  }
  const [grader, grade] = rowKey.replace(/\|/g, ' ').trim().split(/\s+/);
  if (!grader || !grade) {
    return null;
  }
  const keyVariant = rowKey.split('|')[2]?.trim();
  return { mode, grader, grade, variantName: keyVariant || fallbackVariant || null };
}

/**
 * Of several series that match the same printing, the one with the newest
 * point, then the most points. Keys that differ only in spelling ("Unlimited"
 * vs "unlimited") match alike, and a stray one-day duplicate sorted first used
 * to win: Computer Search's NM chart showed a single June point instead of its
 * 209-day history (2026-11-16).
 */
function freshest(series: CardConditionHistorySeries[]): CardConditionHistorySeries | null {
  let best: CardConditionHistorySeries | null = null;
  let bestLast = '';
  for (const candidate of series) {
    const last = candidate.points.reduce((max, point) => (point.date > max ? point.date : max), '');
    if (
      best == null
      || last > bestLast
      || (last === bestLast && candidate.points.length > best.points.length)
    ) {
      best = candidate;
      bestLast = last;
    }
  }
  return best;
}

/** Picks the printing's series among same-condition (or same-grade) candidates. */
function pickVariant(
  candidates: CardConditionHistorySeries[],
  allSeries: readonly CardConditionHistorySeries[],
  variantLabel: string | null,
  allowBlankFallback: boolean,
): CardConditionHistorySeries | null {
  const wanted = variantMatchKey(variantLabel);
  const matching = candidates.filter((series) => variantMatchKey(series.variantKey) === wanted);
  // A TCGplayer (TCGCSV) line is the headline's own source, so it beats a
  // Scrydex line for the same printing even when the Scrydex one is fresher.
  const tcgplayer = matching.filter((series) => series.source === 'tcgcsv');
  const exact = freshest(tcgplayer.length > 0 ? tcgplayer : matching);
  if (exact) {
    return exact;
  }
  // The card has one printing only: its key spelling differs from the label, but it IS the card.
  const printings = new Set(allSeries.map((series) => variantMatchKey(series.variantKey)));
  if (candidates.length === 1 && printings.size === 1) {
    return candidates[0];
  }
  if (allowBlankFallback) {
    return candidates.find((series) => variantMatchKey(series.variantKey) === '') ?? null;
  }
  // Several printings and none match: showing another printing's price is worse than nothing.
  return null;
}

export function selectHistorySeries(
  history: CardConditionHistory | null | undefined,
  identity: PriceChartRowIdentity,
  variantLabel: string | null,
): CardConditionHistorySeries | null {
  if (!history) {
    return null;
  }
  if (identity.mode === 'raw') {
    const candidates = history.series.filter(
      (series) => conditionMatchKey(series.condition) === identity.condition,
    );
    return pickVariant(candidates, history.series, variantLabel, false);
  }
  const candidates = history.series.filter((series) => (
    (series.grader ?? '').toLowerCase() === identity.grader.toLowerCase()
    && (series.grade ?? '') === identity.grade
  ));
  // Graded cells are often stored variant-less, so a blank series stands in.
  return pickVariant(candidates, history.series, identity.variantName, true);
}

export function historySeriesPoints(series: CardConditionHistorySeries | null | undefined): ChartPoint[] {
  if (!series) {
    return [];
  }
  const points: ChartPoint[] = [];
  for (const point of series.points) {
    const t = parseCalendarDayMs(point.date);
    if (t != null && point.market != null && Number.isFinite(point.market)) {
      points.push({ t, v: point.market });
    }
  }
  return points.sort((a, b) => a.t - b.t);
}

/** Dated USD sales, oldest → newest. Non-USD and unpriced rows are skipped. */
export function salesPoints(record: CardRecentSalesRecord | null | undefined): ChartPoint[] {
  if (!record || record.status !== 'available') {
    return [];
  }
  const points: ChartPoint[] = [];
  for (const sale of record.sales) {
    const t = parseCalendarDayMs(sale.soldAt);
    const amount = sale.priceAmount;
    if (
      t != null
      && amount != null
      && Number.isFinite(amount)
      && amount > 0
      && sale.currencyCode.toUpperCase() === 'USD'
    ) {
      points.push({ t, v: amount });
    }
  }
  return points.sort((a, b) => a.t - b.t);
}

export function chartWindow(
  points: readonly ChartPoint[],
  range: PriceChartRange,
  nowMs: number,
  /**
   * Line charts: start the line AT the window's left edge with the last price
   * before it. Stored history has gaps (a card unpriced for weeks), and a line
   * that began at the first in-window point covered only part of 1W/1M while
   * 3M, reaching back past the gap, filled the width. The carried segment
   * crosses the gap like any in-window gap does. Sales dots are never carried.
   */
  carryIn = false,
): { startMs: number; endMs: number; points: ChartPoint[] } {
  // The window ends at the newest point, not "now": prices land once a day
  // (sales less often), so ending at now left the line short of the right edge
  // by the sync lag — a big gap on 1W, invisible on 3M. The as-of caption
  // carries the date.
  const endMs = points[points.length - 1]?.t ?? nowMs;
  const startMs = endMs - rangeDays[range] * DAY_MS;
  const inWindow = points.filter((point) => point.t >= startMs && point.t <= endMs);
  if (!carryIn) {
    return { startMs, endMs, points: inWindow };
  }
  const before = findLastBefore(points, startMs);
  if (before && (inWindow.length === 0 || inWindow[0].t > startMs)) {
    inWindow.unshift({ t: startMs, v: before.v });
  }
  // History younger than the range (1Y with months of data, a new card on 1M):
  // the line still spans the width, starting at its first real price (owner:
  // the range caption stays as-is).
  if (!before && inWindow.length > 0) {
    return { startMs: inWindow[0].t, endMs, points: inWindow };
  }
  return { startMs, endMs, points: inWindow };
}

function findLastBefore(points: readonly ChartPoint[], t: number): ChartPoint | undefined {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].t < t) {
      return points[index];
    }
  }
  return undefined;
}

export function deltaDirection(amount: number): ChartDirection {
  return amount > 0 ? 'up' : amount < 0 ? 'down' : 'flat';
}

export type PriceChartDelta = {
  /** "$48.16 (1.43%)" — the whole line, for accessibility and logs. */
  label: string;
  /** "$48.16" — unsigned; the triangle and color carry the direction. */
  amount: string;
  /** "(1.43%)", or null with no positive baseline to divide by. */
  percent: string | null;
  direction: ChartDirection;
};

/** "$48.16 (1.43%)" — unsigned; the triangle and color carry the direction. */
export function formatDeltaLabel(amount: number, baseline: number, currencyCode: string): string {
  const parts = deltaParts(amount, baseline, currencyCode);
  return parts.percent ? `${parts.amount} ${parts.percent}` : parts.amount;
}

function deltaParts(amount: number, baseline: number, currencyCode: string) {
  return {
    amount: formatCurrency(Math.abs(amount), currencyCode),
    percent: baseline > 0 ? `(${Math.abs((amount / baseline) * 100).toFixed(2)}%)` : null,
  };
}

export function buildPriceChartDelta(amount: number, baseline: number, currencyCode: string): PriceChartDelta {
  return {
    ...deltaParts(amount, baseline, currencyCode),
    label: formatDeltaLabel(amount, baseline, currencyCode),
    direction: deltaDirection(amount),
  };
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export type PriceChartModel = {
  variant: 'line' | 'sales';
  /** Points inside the window, oldest → newest. */
  points: ChartPoint[];
  windowStartMs: number;
  windowEndMs: number;
  currencyCode: string;
  tone: ChartTone;
  /** Too little data in the window: show `emptyMessage` instead of the chart. */
  insufficient: boolean;
  emptyMessage: string | null;
  restValue: number;
  /** Null when there's no trend to state (insufficient data). */
  restDelta: PriceChartDelta | null;
  restSuffix: string;
  asOfText: string;
};

export function buildPriceChartModel({
  allPoints,
  variant,
  range,
  nowMs,
  currencyCode,
}: {
  allPoints: readonly ChartPoint[];
  variant: 'line' | 'sales';
  range: PriceChartRange;
  nowMs: number;
  currencyCode: string;
}): PriceChartModel | null {
  const latest = allPoints[allPoints.length - 1];
  // USD only, never yen: a card with no USD history has no chart.
  if (!latest || currencyCode.toUpperCase() !== 'USD') {
    return null;
  }
  const isSales = variant === 'sales';
  const span = chartWindow(allPoints, range, nowMs, !isSales);
  const inWindow = span.points;
  const latestDate = formatChartDate(latest.t, nowMs);
  const asOfText = isSales
    ? `Last sale ${latestDate} · eBay · each dot is one sale`
    : `Prices as of ${latestDate} · TCGplayer market`;
  const longerHint = range === '1Y' ? '' : ' · try a longer range';
  const base = {
    variant,
    points: inWindow,
    windowStartMs: span.startMs,
    windowEndMs: span.endMs,
    currencyCode,
    asOfText,
  };

  // A line that stopped updating (e.g. a condition the source no longer prices)
  // must not pass for current on the long ranges.
  if (!isSales && nowMs - latest.t > staleLineAfterDays * DAY_MS) {
    return {
      ...base,
      points: [],
      tone: 'neutral',
      insufficient: true,
      emptyMessage: 'No recent prices for this condition.',
      restValue: latest.v,
      restDelta: null,
      restSuffix: `Last updated ${latestDate}`,
    };
  }

  const insufficient = isSales ? inWindow.length < minGradedSalesForTrend : inWindow.length < 2;
  if (insufficient) {
    return {
      ...base,
      tone: 'neutral',
      insufficient: true,
      emptyMessage: isSales
        ? `${inWindow.length === 0 ? 'No sales' : countLabel(inWindow.length, 'sale')} in this range. Not enough to call a trend.`
        : 'Not enough price history in this range.',
      // Most recent value ever, so the headline is never blank.
      restValue: latest.v,
      restDelta: null,
      restSuffix: `${isSales ? 'Last sold' : 'Last updated'} ${latestDate}${longerHint}`,
    };
  }

  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const amount = last.v - first.v;
  const direction = deltaDirection(amount);
  return {
    ...base,
    tone: direction === 'flat' ? 'neutral' : direction,
    insufficient: false,
    emptyMessage: null,
    restValue: last.v,
    restDelta: buildPriceChartDelta(amount, first.v, currencyCode),
    restSuffix: isSales
      ? `${rangeCaption[range]} · ${countLabel(inWindow.length, 'sale')}`
      : rangeCaption[range],
  };
}

export type PriceChartReadout = {
  value: number;
  delta: PriceChartDelta | null;
  suffix: string;
};

/** Headline + delta line: the resting summary, or the scrubbed point's. */
export function priceChartReadout(
  model: PriceChartModel,
  scrubIndex: number | null,
  nowMs: number = Date.now(),
): PriceChartReadout {
  const point = scrubIndex == null ? undefined : model.points[scrubIndex];
  const first = model.points[0];
  if (!point || !first || model.insufficient) {
    return { value: model.restValue, delta: model.restDelta, suffix: model.restSuffix };
  }
  const amount = point.v - first.v;
  const date = formatChartDate(point.t, nowMs);
  return {
    value: point.v,
    delta: buildPriceChartDelta(amount, first.v, model.currencyCode),
    suffix: model.variant === 'sales' ? `Sold ${date}` : date,
  };
}

/**
 * The chip's starting row: the owned/seeded condition (raw) or grade (graded),
 * else Near Mint / the first (top) grade.
 */
export function resolveDefaultRowKey(
  rows: readonly CardPriceTrendRow[],
  mode: CardPriceTrendMode,
  preferred: { condition?: string | null; grade?: string | null },
): string | null {
  const find = (predicate: (identity: PriceChartRowIdentity) => boolean) => rows.find((row) => {
    const identity = rowIdentity(mode, row.key, null);
    return identity != null && predicate(identity);
  });
  if (mode === 'raw') {
    const wanted = conditionMatchKey(preferred.condition ?? 'NM');
    const match = find((identity) => identity.mode === 'raw' && identity.condition === wanted)
      ?? find((identity) => identity.mode === 'raw' && identity.condition === 'NM');
    return (match ?? rows[0])?.key ?? null;
  }
  const match = preferred.grade
    ? find((identity) => identity.mode === 'graded' && identity.grade === preferred.grade)
    : undefined;
  return (match ?? rows[0])?.key ?? null;
}
