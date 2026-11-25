import type {
  CardGradingAnalysis,
  CardGradingOutcome,
  CardGradingVerdict,
} from './types';

/*
  Defensive wire mapping for "Worth grading?". A payload without a raw price,
  a tier fee or any usable outcome is unavailable (null); so is any non-USD
  payload — we never show another currency. Malformed outcomes are dropped.
*/

type Raw = Record<string, unknown>;

const VERDICTS: readonly CardGradingVerdict[] = ['worth_it', 'only_at_10', 'not_worth_it'];

function asRecord(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function outcome(value: unknown): CardGradingOutcome | null {
  const raw = asRecord(value);
  const grade = raw.grade == null ? null : str(String(raw.grade));
  const priceUsd = numOrNull(raw.priceUsd);
  const netUsd = numOrNull(raw.netUsd);
  const gainVsRawUsd = numOrNull(raw.gainVsRawUsd);
  if (!grade || priceUsd == null || netUsd == null || gainVsRawUsd == null) {
    return null;
  }
  return {
    grade,
    priceUsd,
    netUsd,
    gainVsRawUsd,
    worthIt: typeof raw.worthIt === 'boolean' ? raw.worthIt : gainVsRawUsd > 0,
  };
}

export function parseCardGradingAnalysisPayload(value: unknown): CardGradingAnalysis | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = asRecord(value);
  const currency = str(raw.currencyCode)?.toUpperCase() ?? 'USD';
  if (currency !== 'USD') {
    return null;
  }
  const rawPriceUsd = numOrNull(raw.rawPriceUsd);
  const tierRaw = asRecord(raw.tier);
  const feeUsd = numOrNull(tierRaw.feeUsd);
  const outcomes = (Array.isArray(raw.outcomes) ? raw.outcomes : [])
    .map(outcome)
    .filter((item): item is CardGradingOutcome => item != null);
  const verdict = VERDICTS.find((candidate) => candidate === raw.verdict);
  if (rawPriceUsd == null || feeUsd == null || outcomes.length === 0 || !verdict) {
    return null;
  }
  const shippingUsd = numOrNull(raw.shippingUsd) ?? 0;
  return {
    cardId: str(raw.cardId) ?? '',
    grader: 'PSA',
    variant: str(raw.variant),
    currencyCode: 'USD',
    rawPriceUsd,
    tier: {
      name: str(tierRaw.name) ?? 'PSA',
      feeUsd,
      valueCapUsd: numOrNull(tierRaw.valueCapUsd),
      turnaroundText: str(tierRaw.turnaroundText),
    },
    shippingUsd,
    totalCostUsd: numOrNull(raw.totalCostUsd) ?? feeUsd + shippingUsd,
    outcomes,
    breakEvenGrade: raw.breakEvenGrade == null ? null : str(String(raw.breakEvenGrade)),
    verdict,
    summary: str(raw.summary) ?? '',
    summarySource: raw.summarySource === 'ai' ? 'ai' : 'rules',
    pricesAsOf: str(raw.pricesAsOf),
    feesAsOf: str(raw.feesAsOf),
    feesSourceUrl: str(raw.feesSourceUrl),
  };
}
