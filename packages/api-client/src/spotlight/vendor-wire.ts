// Wire types + tolerant parsers for the vendor price-tag routes
// (backend/vendor_offers.py): buy/sell settings and the Bought log.

export type VendorTierKey = 'bulk' | 'under50' | 'over50' | 'slab';

export type VendorSettings = {
  /** Flat buy % of market, used when tiers are off. */
  buyPercent: number;
  /** Sell price as % of market (100 = at market). */
  sellPercent: number;
  tiersEnabled: boolean;
  tiers: Record<VendorTierKey, number>;
  /** Raw cards under this market are "bulk". */
  bulkMaxUsd: number;
};

export type VendorPriceMode = 'buy' | 'sell';

/** One accepted tray row for POST /api/v1/vendor/bought. */
export type VendorPurchaseLineInput = {
  cardId: string;
  quantity: number;
  marketUsd: number | null;
  /** What the vendor pays per card (the offer). */
  offerUsd: number;
  buyPercent?: number | null;
  tier?: string | null;
  variantName?: string | null;
  condition?: string | null;
  grader?: string | null;
  grade?: string | null;
  certNumber?: string | null;
};

export type VendorPurchaseInput = {
  /** Client id for one Bought tap; a retry with the same id never double-buys. */
  batchId: string;
  lines: VendorPurchaseLineInput[];
};

export type VendorPurchaseResult = {
  recordedLineIndexes: number[];
  alreadyRecordedLineIndexes: number[];
};

export type VendorBoughtEntry = {
  batchId: string;
  lineIndex: number;
  cardId: string;
  name: string;
  setName: string;
  number: string;
  imageUrl: string | null;
  variantName: string | null;
  condition: string | null;
  grader: string | null;
  grade: string | null;
  quantity: number;
  paidUsd: number;
  marketAtBuyUsd: number | null;
  currentValueUsd: number | null;
  profitUsd: number | null;
  boughtAt: string;
};

export type VendorBoughtLog = {
  entries: VendorBoughtEntry[];
  summary: { count: number; paidUsd: number; marketAtBuyUsd: number; currentValueUsd: number };
};

// Plan doc §5 #4 (owner can change). Mirrors backend/vendor_offers.py.
export const DEFAULT_VENDOR_SETTINGS: VendorSettings = {
  buyPercent: 70,
  sellPercent: 100,
  tiersEnabled: true,
  tiers: { bulk: 40, under50: 60, over50: 70, slab: 70 },
  bulkMaxUsd: 5,
};

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseVendorSettings(value: unknown): VendorSettings | null {
  const raw = asRecord(asRecord(value)?.settings ?? value);
  if (!raw) {
    return null;
  }
  const tiers = asRecord(raw.tiers) ?? {};
  const d = DEFAULT_VENDOR_SETTINGS;
  return {
    buyPercent: num(raw.buyPercent) ?? d.buyPercent,
    sellPercent: num(raw.sellPercent) ?? d.sellPercent,
    tiersEnabled: typeof raw.tiersEnabled === 'boolean' ? raw.tiersEnabled : d.tiersEnabled,
    tiers: {
      bulk: num(tiers.bulk) ?? d.tiers.bulk,
      under50: num(tiers.under50) ?? d.tiers.under50,
      over50: num(tiers.over50) ?? d.tiers.over50,
      slab: num(tiers.slab) ?? d.tiers.slab,
    },
    bulkMaxUsd: num(raw.bulkMaxUsd) ?? d.bulkMaxUsd,
  };
}

export function parseVendorPurchaseResult(value: unknown): VendorPurchaseResult | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const ints = (list: unknown) => (Array.isArray(list) ? list.filter((n): n is number => typeof n === 'number') : []);
  return {
    recordedLineIndexes: ints(raw.recordedLineIndexes),
    alreadyRecordedLineIndexes: ints(raw.alreadyRecordedLineIndexes),
  };
}

export function parseVendorBoughtLog(value: unknown): VendorBoughtLog | null {
  const raw = asRecord(value);
  if (!raw || !Array.isArray(raw.entries)) {
    return null;
  }
  const entries: VendorBoughtEntry[] = [];
  raw.entries.forEach((item) => {
    const entry = asRecord(item);
    const cardId = entry ? str(entry.cardId) : null;
    const paidUsd = entry ? num(entry.paidUsd) : null;
    if (!entry || !cardId || paidUsd == null) {
      return;
    }
    entries.push({
      batchId: str(entry.batchId) ?? '',
      lineIndex: num(entry.lineIndex) ?? 0,
      cardId,
      name: str(entry.name) ?? '',
      setName: str(entry.setName) ?? '',
      number: str(entry.number) ?? '',
      imageUrl: str(entry.imageUrl),
      variantName: str(entry.variantName),
      condition: str(entry.condition),
      grader: str(entry.grader),
      grade: str(entry.grade),
      quantity: num(entry.quantity) ?? 1,
      paidUsd,
      marketAtBuyUsd: num(entry.marketAtBuyUsd),
      currentValueUsd: num(entry.currentValueUsd),
      profitUsd: num(entry.profitUsd),
      boughtAt: str(entry.boughtAt) ?? '',
    });
  });
  const summary = asRecord(raw.summary) ?? {};
  return {
    entries,
    summary: {
      count: num(summary.count) ?? entries.length,
      paidUsd: num(summary.paidUsd) ?? 0,
      marketAtBuyUsd: num(summary.marketAtBuyUsd) ?? 0,
      currentValueUsd: num(summary.currentValueUsd) ?? 0,
    },
  };
}
