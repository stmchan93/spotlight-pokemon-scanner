import type { CatalogSearchResult } from '@spotlight/api-client';

type CollectorNumberParts = {
  denominator: number | null;
  prefix: string;
  raw: string;
  suffix: string;
  value: number | null;
};

export type CatalogSetGroup = {
  anchorResultID: string;
  cardCount: number;
  cards: CatalogSearchResult[];
  collectorRangeLabel: string;
  key: string;
  ownedQuantity: number;
  previewImageUrl: string;
  setName: string;
};

function normalizeText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function parseCollectorNumber(value: string): CollectorNumberParts {
  const raw = value.replace(/^#/, '').trim().toUpperCase();
  const [mainPart = '', denominatorPart = ''] = raw.split('/', 2);
  const mainMatch = mainPart.match(/^([A-Z-]*)(\d+)([A-Z-]*)$/);
  const denominatorMatch = denominatorPart.match(/(\d+)/);

  if (!mainMatch) {
    return {
      denominator: denominatorMatch ? Number(denominatorMatch[1]) : null,
      prefix: mainPart,
      raw,
      suffix: '',
      value: null,
    };
  }

  return {
    denominator: denominatorMatch ? Number(denominatorMatch[1]) : null,
    prefix: mainMatch[1] ?? '',
    raw,
    suffix: mainMatch[3] ?? '',
    value: Number(mainMatch[2]),
  };
}

function compareNullableNumbers(left: number | null, right: number | null) {
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return 1;
  }
  if (right == null) {
    return -1;
  }

  return left - right;
}

export function compareCatalogResultsByCollectorNumber(left: CatalogSearchResult, right: CatalogSearchResult) {
  const leftParts = parseCollectorNumber(left.cardNumber);
  const rightParts = parseCollectorNumber(right.cardNumber);

  const prefixCompare = leftParts.prefix.localeCompare(rightParts.prefix, undefined, { numeric: true });
  if (prefixCompare !== 0) {
    return prefixCompare;
  }

  const numberCompare = compareNullableNumbers(leftParts.value, rightParts.value);
  if (numberCompare !== 0) {
    return numberCompare;
  }

  const suffixCompare = leftParts.suffix.localeCompare(rightParts.suffix, undefined, { numeric: true });
  if (suffixCompare !== 0) {
    return suffixCompare;
  }

  const denominatorCompare = compareNullableNumbers(leftParts.denominator, rightParts.denominator);
  if (denominatorCompare !== 0) {
    return denominatorCompare;
  }

  return leftParts.raw.localeCompare(rightParts.raw, undefined, { numeric: true });
}

function buildCollectorRangeLabel(cards: readonly CatalogSearchResult[]) {
  const firstCard = cards[0];
  const lastCard = cards[cards.length - 1];

  if (!firstCard || !lastCard) {
    return '';
  }

  if (cards.length === 1 || firstCard.cardNumber === lastCard.cardNumber) {
    return firstCard.cardNumber;
  }

  return `${firstCard.cardNumber} - ${lastCard.cardNumber}`;
}

export function buildCatalogSetGroups(results: readonly CatalogSearchResult[]) {
  const grouped = new Map<string, { cards: CatalogSearchResult[]; firstIndex: number; setName: string }>();

  results.forEach((result, index) => {
    const key = normalizeText(result.setName);
    const existing = grouped.get(key);

    if (existing) {
      existing.cards.push(result);
      return;
    }

    grouped.set(key, {
      cards: [result],
      firstIndex: index,
      setName: result.setName,
    });
  });

  return [...grouped.entries()]
    .sort(([, left], [, right]) => left.firstIndex - right.firstIndex)
    .map(([key, group]) => {
      const cards = group.cards.slice().sort(compareCatalogResultsByCollectorNumber);
      const anchorResult = group.cards[0];

      return {
        anchorResultID: anchorResult?.id ?? key,
        cardCount: cards.length,
        cards,
        collectorRangeLabel: buildCollectorRangeLabel(cards),
        key,
        ownedQuantity: cards.reduce((sum, card) => sum + (card.ownedQuantity ?? 0), 0),
        previewImageUrl: cards[0]?.imageUrl ?? anchorResult?.imageUrl ?? '',
        setName: group.setName,
      } satisfies CatalogSetGroup;
    });
}

export function pickDefaultCatalogSetKey(groups: readonly CatalogSetGroup[], query: string) {
  if (groups.length === 1) {
    return groups[0]?.key ?? null;
  }

  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return null;
  }

  const exactMatch = groups.find((group) => normalizeText(group.setName) === normalizedQuery);
  return exactMatch?.key ?? null;
}
