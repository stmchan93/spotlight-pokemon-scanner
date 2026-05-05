import type { InventoryCardEntry } from '@spotlight/api-client';

import { resolveConditionDisplayLabel } from '@/lib/condition-display';

export const sellOrderProcessingMinimumDurationMs = 1600;
export const sellOrderSuccessDisplayDurationMs = 1100;
export const sellOrderSwipeThreshold = 92;
export const sellOrderSwipeRailHeight = 48;
export const sellSwipeCollapsedHeight = sellOrderSwipeRailHeight;

export type SingleSellStatusCopy = {
  title: string;
  headline: string;
  detail: string;
};

export type SellMetadataToken = {
  label: string;
  value: string;
};

export function scheduleSellStatusCompletion({
  onComplete,
  onSuccess,
  processingDurationMs,
  schedule = setTimeout,
  successDurationMs = sellOrderSuccessDisplayDurationMs,
}: {
  onComplete: () => void;
  onSuccess: () => void;
  processingDurationMs: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  successDurationMs?: number;
}) {
  const processingTimer = schedule(() => {
    onSuccess();
    schedule(onComplete, successDurationMs);
  }, processingDurationMs);

  return processingTimer;
}

export function sanitizeSellPriceText(value: string) {
  const trimmed = value.replace(/[^0-9.]/g, '');
  const [whole = '', ...fractionParts] = trimmed.split('.');
  const fraction = fractionParts.join('').slice(0, 2);

  if (trimmed.startsWith('.')) {
    return fraction.length > 0 ? `0.${fraction}` : '0.';
  }

  if (fractionParts.length === 0) {
    return whole;
  }

  return `${whole}.${fraction}`;
}

export function parseSellPrice(text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

export function formatEditableSellPrice(value: number) {
  const fixed = value.toFixed(2);
  return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function formatSellPercentValue(value: number) {
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(Math.round(rounded) - rounded) < 0.005) {
    return `${Math.round(rounded)}%`;
  }

  return `${rounded.toFixed(2)}%`;
}

export function buildOfferToYourPricePercentText(
  offerPrice: number | null,
  yourPrice: number | null,
) {
  if (offerPrice == null || offerPrice <= 0 || yourPrice == null || yourPrice <= 0) {
    return null;
  }

  const truncatedPercent = Math.floor(((offerPrice / yourPrice) * 100) * 100) / 100;
  if (Math.abs(Math.round(truncatedPercent) - truncatedPercent) < 0.005) {
    return `${Math.round(truncatedPercent)}% YP`;
  }

  return `${truncatedPercent.toFixed(2)}% YP`;
}

export function evaluateSellCalculatorExpression(expression: string) {
  const sanitized = expression.replace(/\s+/g, '');
  if (sanitized.length === 0) {
    return null;
  }

  const tokens = sanitized.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join('') !== sanitized) {
    return null;
  }

  let index = 0;

  const parseExpression = (): number | null => {
    let value = parseTerm();
    if (value == null) {
      return null;
    }

    while (index < tokens.length) {
      const operator = tokens[index];
      if (operator !== '+' && operator !== '-') {
        break;
      }

      index += 1;
      const nextValue = parseTerm();
      if (nextValue == null) {
        return null;
      }

      value = operator === '+' ? value + nextValue : value - nextValue;
    }

    return value;
  };

  const parseTerm = (): number | null => {
    let value = parseFactor();
    if (value == null) {
      return null;
    }

    while (index < tokens.length) {
      const operator = tokens[index];
      if (operator !== '*' && operator !== '/') {
        break;
      }

      index += 1;
      const nextValue = parseFactor();
      if (nextValue == null) {
        return null;
      }

      if (operator === '*') {
        value *= nextValue;
      } else {
        if (nextValue === 0) {
          return null;
        }
        value /= nextValue;
      }
    }

    return value;
  };

  const parseFactor = (): number | null => {
    const token = tokens[index];
    if (!token) {
      return null;
    }

    if (token === '+') {
      index += 1;
      return parseFactor();
    }

    if (token === '-') {
      index += 1;
      const nextValue = parseFactor();
      return nextValue == null ? null : -nextValue;
    }

    if (token === '(') {
      index += 1;
      const innerValue = parseExpression();
      if (innerValue == null || tokens[index] !== ')') {
        return null;
      }
      index += 1;
      return innerValue;
    }

    index += 1;
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return parsed;
  };

  const result = parseExpression();
  if (result == null || index !== tokens.length || !Number.isFinite(result)) {
    return null;
  }

  return Math.round(result * 100) / 100;
}

export function getSellSwipeConfirmThreshold(containerHeight: number) {
  return Math.max(sellOrderSwipeThreshold, containerHeight * 0.5);
}

export function canStartSellSheetDismissGesture(dx: number, dy: number) {
  return dy > 8 && Math.abs(dy) > Math.abs(dx);
}

export function canStartSellSwipeGesture(dx: number, dy: number) {
  return dy < -6 && Math.abs(dy) > Math.abs(dx);
}

export function getSellSwipeArmThresholdRatio(containerHeight: number, closedSheetOffset: number) {
  if (closedSheetOffset <= 0) {
    return 1;
  }

  return Math.min(1, getSellSwipeConfirmThreshold(containerHeight) / closedSheetOffset);
}

export function isSellSwipeReleaseArmed(
  nextOffset: number,
  closedSheetOffset: number,
  armThresholdRatio: number,
) {
  return closedSheetOffset > 0
    && (1 - (nextOffset / closedSheetOffset)) >= armThresholdRatio;
}

export function getResistedSellSwipeTranslation(translation: number) {
  if (translation < 0) {
    return translation * 0.88;
  }

  return translation * 0.35;
}

export function formatSellOrderBoughtPriceLabel(
  value: number | null | undefined,
  currencyText: string,
  revealsValue: boolean,
) {
  if (value == null) {
    return '--';
  }

  return revealsValue ? currencyText : '*****';
}

export function buildSellMetadataTokens(entry: InventoryCardEntry): SellMetadataToken[] {
  const tokens: SellMetadataToken[] = [];

  if (entry.kind === 'graded') {
    const grader = entry.slabContext?.grader?.trim();
    const grade = entry.slabContext?.grade?.trim();

    if (grader) {
      tokens.push({
        label: 'Grader',
        value: grader,
      });
    }

    if (grade) {
      tokens.push({
        label: 'Grade',
        value: grade,
      });
    }
  } else {
    const condition = resolveConditionDisplayLabel({
      conditionCode: entry.conditionCode,
      conditionLabel: entry.conditionLabel,
      conditionShortLabel: entry.conditionShortLabel,
    });

    if (condition) {
      tokens.push({
        label: 'Condition',
        value: condition,
      });
    }
  }

  const variantName = (
    entry.variantName
    ?? entry.slabContext?.variantName
    ?? null
  )?.trim();

  if (variantName) {
    tokens.push({
      label: 'Variant',
      value: variantName,
    });
  }

  return tokens;
}

export function buildSingleSellStatusCopy({
  currencyCode,
  entryName,
  quantity,
  soldTotal,
  submitState,
}: {
  currencyCode: string;
  entryName: string;
  quantity: number;
  soldTotal: number;
  submitState: 'processing' | 'success';
}): SingleSellStatusCopy {
  const totalLabel = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(soldTotal);

  if (submitState === 'success') {
    return {
      title: 'Congrats!',
      headline: 'Sale confirmed',
      detail: `${entryName} sold for ${totalLabel}.`,
    };
  }

  return {
    title: 'Processing sale',
    headline: `Selling ${totalLabel}`,
    detail: quantity === 1 ? 'Locking in the sale.' : `Locking in ${quantity} cards.`,
  };
}

export function collectionSummaryLine(entry: InventoryCardEntry) {
  if (entry.kind === 'graded') {
    const parts = [
      `${entry.slabContext?.grader ?? 'Graded'} ${entry.slabContext?.grade ?? ''}`.trim(),
      entry.slabContext?.variantName?.trim(),
    ].filter(Boolean);
    return parts.join(' • ');
  }

  const parts = [
    resolveConditionDisplayLabel({
      conditionCode: entry.conditionCode,
      conditionLabel: entry.conditionLabel,
      conditionShortLabel: entry.conditionShortLabel,
    }),
    entry.slabContext?.variantName?.trim(),
  ].filter(Boolean);
  return parts.join(' • ');
}

export function slabGradeSummary(slabContext?: InventoryCardEntry['slabContext'] | null) {
  const grader = slabContext?.grader?.trim();
  const grade = slabContext?.grade?.trim();
  if (grader && grade) {
    return `${grader} • ${grade}`;
  }

  return grader || slabContext?.variantName?.trim() || null;
}
