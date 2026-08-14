export const historyRanges = ['1W', '1M', '3M', 'YTD', '1Y', 'ALL'] as const;

export type PortfolioHistoryRange = (typeof historyRanges)[number];

// Backend accepts the legacy `7D` token as an alias for `1W` for at least one
// release cycle. The mobile app emits `1W`; older clients can keep sending `7D`
// and the backend will treat it the same.
export const legacyPortfolioHistoryRangeAliases: Record<string, PortfolioHistoryRange> = {
  '7D': '1W',
};

export type ChartMode = 'portfolio' | 'sales';
export type ScannerMode = 'raw' | 'slabs';
export type ScannerCardLanguage = 'english' | 'japanese';

export type ScannerImagePayload = {
  /**
   * Inline base64 JPEG bytes. Optional: the default scan transport is
   * multipart/form-data where the image travels as a native file part
   * (`fileUri`), so base64 is only materialized for the JSON fallback.
   */
  jpegBase64?: string | null;
  /**
   * Local file URI (file:// or content://) for the JPEG. When present, the
   * repository streams it as a multipart file part so the bytes never cross
   * the JS thread as a base64 string.
   */
  fileUri?: string | null;
  width: number;
  height: number;
};

export type ScannerSlabRecommendedLookupPath = 'psa_cert' | 'label_text_search' | 'needs_review';

export type ScannerSlabAnalysisPayload = {
  slabGrader: string | null;
  slabGrade: string | null;
  slabCertNumber: string | null;
  slabBarcodePayloads: string[];
  slabParsedLabelText: string[];
  slabCardNumberRaw: string | null;
  slabGraderConfidence: number | null;
  slabGradeConfidence: number | null;
  slabCertConfidence: number | null;
  slabClassifierReasons: string[];
  slabRecommendedLookupPath: ScannerSlabRecommendedLookupPath | null;
  ocrAnalysis: Record<string, unknown> | null;
};

export type ScannerCapturePayload = ScannerImagePayload & {
  mode: ScannerMode;
  /**
   * Explicit card language chosen by the user via the scanner's "Scanning for"
   * toggle. Sent to the backend as an authoritative `preferred_language` hint so
   * it can skip OCR-based language detection. Defaults to English when omitted.
   */
  cardLanguage?: ScannerCardLanguage | null;
  captureSource?: 'camera' | 'smoke_fixture' | string | null;
  /**
   * Nominal camera zoom factor used for this capture (1, 1.5, or 2). Persisted
   * to `scan_artifacts.camera_zoom_factor` so accuracy can be compared by zoom.
   */
  cameraZoomFactor?: number | null;
  normalizedImage?: ScannerImagePayload | null;
  slabAnalysis?: ScannerSlabAnalysisPayload | null;
  sourceImage?: ScannerImagePayload | null;
  submittedAt?: string | null;
  /**
   * Phase 2 collector-number tiebreak (raw lane only). Optional on-device OCR
   * evidence forwarded as a SECONDARY verification signal. The backend reads
   * `ocrAnalysis.rawEvidence.collectorNumberExact`; it is never a primary
   * identifier and never a hard filter. Null/omitted for slab captures (those
   * carry their OCR evidence inside `slabAnalysis.ocrAnalysis`).
   */
  ocrAnalysis?: ScannerOcrAnalysisPayload | null;
  /**
   * Lazily reads a local scan file as base64. Supplied by the app shell (which
   * owns the filesystem APIs) so the repository can materialize the JSON+base64
   * fallback body ONLY when the multipart transport is unavailable. Resolves to
   * null when the read fails; never throws into the scan flow.
   */
  readFileAsBase64?: ((fileUri: string) => Promise<string | null>) | null;
};

export type ScannerOcrAnalysisPayload = {
  rawEvidence?: {
    collectorNumberExact?: string | null;
  } | null;
};

export type ScannerArtifactUploadResult = {
  status: 'uploaded' | 'skipped' | 'failed';
  reason?: string | null;
  storage?: string | null;
  uploadedAt?: string | null;
  sourceObjectPath?: string | null;
  normalizedObjectPath?: string | null;
  requestAttemptCount?: number | null;
  requestUrl?: string | null;
  roundTripMs?: number | null;
  errorKind?: string | null;
  errorMessage?: string | null;
};

export type ScanFeedbackPayload = {
  scanID: string;
  selectedCardID?: string | null;
  correctionType: string;
  submittedAt: string;
  selectionSource?: 'top' | 'alternate' | 'manual_search' | 'abandoned' | 'unknown' | null;
  selectedRank?: number | null;
  wasTopPrediction?: boolean | null;
};

/**
 * Set when the backend's visual language probe is confident the scanned card is
 * a different language than the user's selected toggle (e.g. a Japanese card
 * scanned with English selected). Drives the "wrong toggle" warning.
 */
export type ScannerTargetLanguageMismatch = {
  selected: ScannerCardLanguage;
  detected: ScannerCardLanguage;
  confidence: number;
};

export type ScannerMatchResult = {
  scanID: string | null;
  candidates: CatalogSearchResult[];
  /** Total candidates available for this scan on the backend (≤30). Drives "load more". */
  candidatePoolSize?: number;
  endpointPath?: string;
  resolverMode?: string | null;
  reviewDisposition?: string | null;
  reviewReason?: string | null;
  roundTripMs?: number | null;
  serverProcessingMs?: number | null;
  requestUrl?: string | null;
  requestAttemptCount?: number | null;
  slabContext?: SlabContext | null;
  targetLanguageMismatch?: ScannerTargetLanguageMismatch | null;
};

export type ScannerMatchOptions = {
  onArtifactUploadComplete?: (result: ScannerArtifactUploadResult | null) => void;
};

/** One "Who's That Pokémon" selfie-match candidate returned by the backend. */
export type WhosThatPokemonMatch = {
  /** Display species name, e.g. "Pikachu". */
  species: string;
  /** National Pokédex number — also keys the official artwork URL. */
  pokedexId: number;
  /** Normalized match confidence in [0, 1]. */
  confidence: number;
  /** Playful one-liner explaining the match. */
  reason: string;
};

/** Axis-aligned box normalized to 0..1 against some reference image. */
export type NormalizedBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Point normalized to 0..1 against some reference image. */
export type NormalizedPoint = { x: number; y: number };

export type WhosThatPokemonResult = {
  /** Top matches, best first (the backend returns exactly 3). */
  matches: WhosThatPokemonMatch[];
  /**
   * Data URI (image/png) of the person cutout — the selfie with the
   * background removed, so the morph can grab the user's actual outline.
   * Null when server-side segmentation was unavailable (morph falls back to
   * the plain crossfade).
   */
  personCutoutUri: string | null;
  /**
   * Person bounding box, normalized 0..1 against the ORIGINAL SELFIE.
   * Absent/null whenever segmentation was unavailable.
   */
  personBounds?: NormalizedBox | null;
  /**
   * Head bounding box, normalized 0..1 against the ORIGINAL SELFIE. Drives the
   * reveal's face-analysis overlay; absent/null → the overlay falls back to a
   * proportional head box.
   */
  headBox?: NormalizedBox | null;
  /**
   * Ordered outline of the top match's official artwork (~48 points), each
   * normalized 0..1 against the ARTWORK IMAGE — a different space from the
   * boxes above. Absent/null → the lock-on points scatter instead of settling
   * into the species shape.
   */
  speciesOutline?: NormalizedPoint[] | null;
  /**
   * Ordered outline of YOUR silhouette (~48 points), each normalized 0..1
   * against the PERSON CUTOUT PNG — a third space again. Produced by the same
   * tracer, point count and angular order (clockwise from 3 o'clock) as
   * `speciesOutline`, so index i is the same bearing on both shapes and the
   * client can interpolate them point-for-point instead of crossfading.
   * Absent/null whenever segmentation was unavailable → the reveal falls back
   * to the species silhouette rising on its own.
   */
  personOutline?: NormalizedPoint[] | null;
};

export type WhosThatPokemonPayload = {
  /** Inline base64 JPEG bytes of the selfie. Never persisted server-side. */
  jpegBase64: string;
  width: number;
  height: number;
  /** Optional dominant-color hexes extracted on-device from the selfie. */
  palette?: string[] | null;
};

export type WhosThatShareCardPayload = {
  /** Inline base64 JPEG bytes of the selfie used for the match. */
  jpegBase64: string;
  species: string;
  pokedexId: number;
  reason: string;
  /** Normalized match confidence in [0, 1]. */
  confidence: number;
};

export type WhosThatShareCardResult = {
  /** Server-composed share card as base64 PNG bytes. */
  pngBase64: string;
};

export const spotlightRepositoryLoadStates = ['success', 'empty', 'not_found', 'error'] as const;

export type SpotlightRepositoryLoadState = (typeof spotlightRepositoryLoadStates)[number];

export type SpotlightRepositoryLoadResult<T> = {
  state: SpotlightRepositoryLoadState;
  data: T | null;
  errorMessage: string | null;
};

export const labelingSessionAngleLabels = [
  'front',
  'tilt_left',
  'tilt_right',
  'tilt_forward',
] as const;

export type LabelingSessionAngleLabel = (typeof labelingSessionAngleLabels)[number];

export type LabelingSessionCreatePayload = {
  sessionID?: string | null;
  cardID: string;
  cardName?: string | null;
  cardNumber?: string | null;
  setName?: string | null;
  isPromo?: boolean | null;
  createdAt?: string | null;
};

export type LabelingSessionRecord = {
  sessionID: string;
  cardID: string;
  status: 'capturing' | 'completed' | 'aborted';
  createdAt: string;
  completedAt?: string | null;
  abortedAt?: string | null;
  artifactCount?: number;
};

export type LabelingSessionArtifactUploadPayload = {
  sessionID: string;
  angleIndex: number;
  angleLabel: LabelingSessionAngleLabel;
  submittedAt: string;
  sourceImage: {
    jpegBase64: string;
    width: number;
    height: number;
  };
  normalizedImage: {
    jpegBase64: string;
    width: number;
    height: number;
  };
  nativeSourceWidth: number;
  nativeSourceHeight: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  normalizationRotationDegrees: number;
  normalizationReason: string;
  scannerFrontHalfVersion: string;
  sourceBranch?: string | null;
  pixelsPerCardHeight?: number | null;
  processingMs?: number | null;
};

export type LabelingSessionArtifactRecord = {
  artifactID: string;
  sessionID: string;
  angleIndex: number;
  angleLabel: LabelingSessionAngleLabel;
  sourceObjectPath?: string | null;
  normalizedObjectPath?: string | null;
  uploadedAt?: string | null;
};

export type InventorySortOption = 'recent' | 'value' | 'a-z';
export type InventoryFilterOption = 'all' | 'raw' | 'graded' | 'favorite';

export type SlabContext = {
  grader: string;
  grade?: string | null;
  certNumber?: string | null;
  variantName?: string | null;
};

export type DeckConditionCode =
  | 'near_mint'
  | 'lightly_played'
  | 'moderately_played'
  | 'heavily_played'
  | 'damaged';

export type DeckConditionOption = {
  code: DeckConditionCode;
  label: string;
  shortLabel: string;
};

export const deckConditionOptions: readonly DeckConditionOption[] = [
  { code: 'near_mint', label: 'Near Mint', shortLabel: 'NM' },
  { code: 'lightly_played', label: 'Lightly Played', shortLabel: 'LP' },
  { code: 'moderately_played', label: 'Moderately Played', shortLabel: 'MP' },
  { code: 'heavily_played', label: 'Heavily Played', shortLabel: 'HP' },
  { code: 'damaged', label: 'Damaged', shortLabel: 'DMG' },
] as const;

export type PortfolioSummary = {
  currentValue: number;
  changeAmount: number;
  changePercent: number;
  asOfLabel: string;
};

export type PortfolioChartPoint = {
  isoDate: string;
  shortLabel: string;
  value: number;
  salesCount?: number;
  /** Cards added (add/buy events) on this point's day — drives the chart's buy markers. */
  addedCount?: number;
  /** Total market value (dollars) of the cards added on this point's day. */
  addedValue?: number;
  axisLabel?: string;
  rangeEndISO?: string;
};

export type RangeChartData = {
  portfolio: PortfolioChartPoint[];
  sales: PortfolioChartPoint[];
};

export type InventoryCardEntry = {
  id: string;
  cardId: string;
  name: string;
  cardNumber: string;
  setName: string;
  imageUrl: string;
  smallImageUrl?: string | null;
  largeImageUrl?: string | null;
  marketPrice: number;
  hasMarketPrice: boolean;
  currencyCode: string;
  quantity: number;
  addedAt: string;
  kind: 'raw' | 'graded';
  variantName?: string | null;
  conditionCode?: DeckConditionCode | null;
  conditionLabel?: string | null;
  conditionShortLabel?: string | null;
  slabContext?: SlabContext | null;
  /** Server-computed rarity bucket; undefined on older cached payloads. */
  rarityBucket?: RarityBucket;
  costBasisPerUnit?: number | null;
  costBasisTotal?: number | null;
  isFavorite?: boolean;
  /** ISO timestamp the card was favorited; drives the Favorites recency sort. */
  favoritedAt?: string | null;
  // Day-over-day change in marketPrice computed from the previous day's price
  // history snapshot. Both fields are null when no yesterday snapshot exists,
  // and dayChangePercent is also null when yesterday's price was 0.
  dayChangeAmount?: number | null;
  dayChangePercent?: number | null;
  // "Since you added it" — change in marketPrice versus the market price
  // snapshotted when the entry was added (`added_market_price`). All null when
  // no baseline could be resolved. `sinceAddedBaselineDate` is the date the
  // baseline price actually comes from; it can be LATER than `addedAt` for
  // entries added before price tracking began (earliest-tracked fallback), so
  // the UI can label the span truthfully.
  sinceAddedChangeAmount?: number | null;
  sinceAddedChangePercent?: number | null;
  sinceAddedBaselineDate?: string | null;
  // Row sparkline — last-30-days market series (oldest → newest, downsampled
  // server-side) + its own 30d percent direction for tinting. Null when the
  // backend omits or truncates sparklines for the page.
  sparkPoints?: number[] | null;
  sparkTrendPct?: number | null;
  // Listing fields — populated when the user has marked the entry as listed
  // on an external marketplace (eBay). Drives the "Live on eBay" tile footer.
  listingUrl?: string | null;
  listingPriceCents?: number | null;
  listedAt?: string | null;
};

export type PortfolioInventoryItem = InventoryCardEntry;

// One row of the "2026 Performance Tracker" (Insights page): per-card current
// value, cost basis, a year-start (Jan 1) baseline, YTD gain/loss, and a
// downsampled yearly price sparkline. Backed by GET /api/v1/portfolio/performance.
export type PortfolioPerformanceRow = {
  entryId: string;
  cardId: string;
  name: string;
  cardNumber: string;
  setName: string;
  imageUrl: string | null;
  /** Small image variant for list thumbnails (imageUrl is the full-size scan). */
  smallImageUrl: string | null;
  quantity: number;
  kind: 'raw' | 'graded';
  grade: string | null;
  variantName: string | null; // printing/variant (e.g. "Reverse Holofoil"); null when raw/Normal
  condition: string | null; // condition label (e.g. "Near Mint") for raw; null for graded
  currentPrice: number | null;
  currentValue: number | null;
  costBasisTotal: number | null; // null when the user hasn't entered cost basis
  jan1Price: number | null;
  yearStartValue: number | null;
  ytdGainDollar: number | null;
  ytdGainPercent: number | null;
  todayGainDollar: number | null; // vs the latest daily point strictly before today
  todayGainPercent: number | null;
  monthGainDollar: number | null; // vs the latest daily point ~30 days before today (× quantity)
  monthGainPercent: number | null; // per-unit % change over ~30 days
  isFavorite: boolean; // wishlist heart — drives the Insights "Likes" chip
  sparkline: number[]; // oldest → newest; [] when no history
};

export type PortfolioPerformance = {
  itemCount: number;
  currencyCode: string;
  refreshedAt: string;
  rows: PortfolioPerformanceRow[];
};


export type RecentTransactionKind = 'sold' | 'traded';

export type RecentSaleRecord = {
  id: string;
  cardId: string;
  kind: RecentTransactionKind;
  name: string;
  cardNumber: string;
  setName: string;
  soldPrice: number;
  currencyCode: string;
  soldAtLabel: string;
  soldAtISO: string;
  imageUrl: string;
  smallImageUrl?: string | null;
  largeImageUrl?: string | null;
  /**
   * Pre-formatted quality label for display on Recent Sales cards.
   * Raw: condition like "Near Mint". Slab: "<Grader> <Grade>"
   * such as "PSA 10". Null when the backend hasn't surfaced it.
   */
  qualityLabel?: string | null;
  /** Quantity sold or traded in this transaction. Null when not surfaced. */
  quantity?: number | null;
  /** Payment method used for this sale (e.g. "cash", "venmo"). Null when not surfaced. */
  paymentMethod?: string | null;
  /** ISO timestamp when the sale was marked paid. Null when pending or not surfaced. */
  paidAt?: string | null;
  /** Payment status: paid, pending, or voided. Null when not surfaced. */
  status?: SaleStatus | null;
  /**
   * Cost-basis snapshot per unit captured at sell-time. Null when the
   * inventory row had no cost basis at the moment of sale. Stays stable
   * even if the original inventory entry is later deleted or edited.
   */
  costBasisPerUnit?: number | null;
  /**
   * Derived profit for this sale ((soldPrice − costBasisPerUnit) × quantity)
   * computed and snapshotted server-side. Null when costBasisPerUnit is null.
   */
  profit?: number | null;
};

/**
 * Aggregated portfolio + sales metrics used by the Insights screen
 * (Collections tab redesign, Frame 5). All money values are dollars (floats).
 * Optional/nullable to keep older clients backwards-compatible.
 */
export type PortfolioInsights = {
  // Inventory / collection-health aggregates
  totalCostBasis: number;
  unrealizedGain: number;
  trackedInventoryCount: number;
  inventoryAddedThisMonth: number;
  activeListings: number;
  unlistedInventory: number;
  listingRate: number;
  avgListingValue?: number | null;
  // Monthly sales aggregates (current calendar month)
  monthlyRevenue: number;
  monthlyProfit: number;
  monthlyExpense: number;
  monthlyMargin?: number | null;
  /** MoM change as a fraction (0.12 = +12%); null when prior month had no activity. */
  monthlyRevenueChangePercent?: number | null;
  monthlyProfitChangePercent?: number | null;
  numSales: number;
  avgSalesPrice?: number | null;
  avgDaysToSell?: number | null;
  unsoldListings: number;
  // All-time sales aggregates
  totalSales: number;
  totalRevenue: number;
  totalExpense: number;
  totalProfit: number;
  overallROI?: number | null;
  // Featured sales
  bestReturnOfAllTime?: RecentSaleRecord | null;
  topSellersThisMonth: RecentSaleRecord[];
  refreshedAt?: string | null;
};

/** Per-kind tally for the simplified, transaction-log-only Insights page. */
export type TransactionKindStat = {
  /** Number of cards (sum of itemCount). */
  count: number;
  /** Total dollars in cents. */
  amountCents: number;
};

export type TransactionKindStats = {
  sold: TransactionKindStat;
  bought: TransactionKindStat;
  traded: TransactionKindStat;
};

/**
 * Simple vendor-facing analytics derived purely from the transaction memory log
 * (no cost basis / profit / inventory state): per-kind counts + dollar totals
 * for this month and all time, the top sales this month, and the biggest sale.
 */
export type InsightGrowthCard = {
  cardId: string;
  name: string;
  setName: string | null;
  cardNumber: string | null;
  imageUrl: string | null;
  currencyCode: string;
  changeAmountCents: number;
  changePct: number;
};

export type TransactionInsights = {
  currencyCode: string;
  thisMonth: TransactionKindStats;
  allTime: TransactionKindStats;
  biggestSale: CardTransactionRecord | null;
  topSalesThisMonth: CardTransactionRecord[];
  totalPortfolioValueCents: number;
  scannedCount: number;
  wishlistedCount: number;
  biggestPurchase: CardTransactionRecord | null;
  topGrowth: InsightGrowthCard[];
  refreshedAt?: string | null;
};

/**
 * A named collection holdings can belong to. Every owner has at least one
 * ("Main Collection"); it is created on demand the first time they read their
 * collections, which is also when pre-multi-collection holdings are adopted.
 */
export type Collection = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  cardCount: number;
  totalValue: number;
  /** The collection that receives adds when no specific one is active. */
  isDefault: boolean;
  /**
   * Excluded from every un-scoped holdings read — the "All Collections" total,
   * the ledger's inventory value, exports. The collection itself stays readable,
   * so hiding is reversible; it means "don't count this", not "hide it away".
   */
  hidden: boolean;
};

export type CollectionsSnapshot = {
  collections: Collection[];
  defaultCollectionID: string;
  /**
   * The "All Collections" row — the un-scoped totals. Deliberately read from the
   * server rather than summed on the client, so it stays right even if a holding
   * is briefly missing a collection.
   */
  all: { cardCount: number; totalValue: number };
};

/**
 * The pseudo-id for "All Collections". Not a real collection row — it means "do
 * not scope this read", which is also what the backend does with no id at all.
 */
export const ALL_COLLECTIONS_ID = 'all';

export type PortfolioDashboard = {
  summary: PortfolioSummary;
  inventoryCount: number;
  inventoryItems: InventoryCardEntry[];
  recentSales: RecentSaleRecord[];
  ranges: Record<PortfolioHistoryRange, RangeChartData>;
  /**
   * Insights aggregates surfaced by the backend `/api/v1/portfolio/insights`
   * endpoint. Optional so older clients can continue to consume the dashboard
   * without breakage.
   */
  insights?: PortfolioInsights | null;
};

/**
 * Server-computed rarity bucket served on every card payload. The backend owns
 * the rarity→bucket mapping; clients only read the field. Older cached
 * payloads may omit it — such cards simply match no rarity filter chip.
 */
export type RarityBucket =
  | 'sir'
  | 'illustration'
  | 'ultra'
  | 'secret'
  | 'shiny'
  | 'promo'
  | 'standard'
  | 'other';

/** Every valid `rarityBucket` value — used to validate served payloads. */
export const RARITY_BUCKET_VALUES: readonly RarityBucket[] = [
  'sir',
  'illustration',
  'ultra',
  'secret',
  'shiny',
  'promo',
  'standard',
  'other',
];

/** The buckets that surface as filter chips (promo/standard/other get none). */
export type RarityFilterBucket = 'sir' | 'illustration' | 'ultra' | 'secret' | 'shiny';

/** Chip order shared by the Collection/Wishlist/Catalog rarity chip rows. */
export const RARITY_FILTER_BUCKETS: readonly RarityFilterBucket[] = [
  'sir',
  'illustration',
  'ultra',
  'secret',
  'shiny',
];

/**
 * User-facing chip labels for the filterable buckets. This map is the ONLY
 * client home for these labels — never restate them in screens.
 */
export const RARITY_BUCKET_LABELS: Record<RarityFilterBucket, string> = {
  sir: 'SIR',
  illustration: 'Illus. Rare',
  ultra: 'Full Art',
  secret: 'Secret',
  shiny: 'Shiny',
};

export type CatalogSearchResult = {
  id: string;
  cardId: string;
  name: string;
  cardNumber: string;
  setName: string;
  subtitle?: string | null;
  imageUrl: string;
  /** Small/thumbnail-resolution image URL when the source provides one; null otherwise. */
  smallImageUrl?: string | null;
  /** Large/full-resolution image URL when the source provides one; null otherwise. */
  largeImageUrl?: string | null;
  marketPrice?: number | null;
  currencyCode?: string | null;
  ownedQuantity?: number;
  isFavorite?: boolean;
  /** Normalized match confidence in [0, 1] for scanner candidates; null/undefined for catalog search. */
  matchScore?: number | null;
  /** Server-computed rarity bucket; undefined on older cached payloads. */
  rarityBucket?: RarityBucket;
  /**
   * True when `marketPrice` is a GRADED reference (a slab comp) rather than the
   * raw/ungraded price — set for cards that have no raw price of their own. The
   * UI must tag the price so it isn't read as the ungraded value.
   */
  priceIsGradedReference?: boolean;
  /** Grade tag to show next to a graded-reference price, e.g. "PSA 10"; null otherwise. */
  gradedReferenceLabel?: string | null;
};

export type ExpansionRecord = {
  id: string;
  name: string;
  series: string | null;
  code: string | null;
  releaseDate: string | null;
  imageUrl: string | null;
};

export type MarketHistoryOption = {
  id: string;
  label: string;
  currentPrice?: number | null;
};

export type CardMarketInsight = {
  id: 'week' | 'twoWeeks' | 'month';
  label: string;
  deltaAmount?: number | null;
  deltaPercent?: number | null;
};

export type RawPricingMatrixConditionRow = {
  code: string;
  label: string;
  low?: number | null;
  mid?: number | null;
  market?: number | null;
  high?: number | null;
};

export type RawPricingMatrixVariant = {
  variant: string;
  variantKey: string;
  conditions: RawPricingMatrixConditionRow[];
};

export type RawPricingMatrix = {
  cardID: string;
  currencyCode: string;
  variants: RawPricingMatrixVariant[];
};

export type CardMarketHistoryRecord = {
  currencyCode: string;
  currentPrice?: number | null;
  points: PortfolioChartPoint[];
  availableVariants: MarketHistoryOption[];
  availableConditions: MarketHistoryOption[];
  selectedVariant?: string | null;
  selectedCondition?: string | null;
  insights: CardMarketInsight[];
  volumeLevel?: 'low' | 'normal' | 'unknown';
  refreshedAt?: string | null;
};

export type CardEbayListingRecord = {
  id: string;
  title: string;
  saleType?: string | null;
  listingDate?: string | null;
  priceAmount?: number | null;
  currencyCode: string;
  listingUrl?: string | null;
};

export type CardEbayListingsRecord = {
  status: 'available' | 'unavailable';
  statusReason?: string | null;
  unavailableReason?: string | null;
  searchUrl?: string | null;
  listingCount: number;
  listings: CardEbayListingRecord[];
};

export type CardRecentSaleSource = 'ebay';

export type CardRecentSaleRecord = {
  id: string;
  title: string;
  soldAt?: string | null;
  priceAmount?: number | null;
  currencyCode: string;
  saleUrl?: string | null;
};

export type CardRecentSalesRecord = {
  source: CardRecentSaleSource;
  status: 'available' | 'unavailable';
  statusReason?: string | null;
  unavailableReason?: string | null;
  fetchedAt?: string | null;
  canRefresh: boolean;
  saleCount: number;
  sales: CardRecentSaleRecord[];
};

export type CardPricingTrendsPct = {
  days7: number | null;
  days30: number | null;
  days90: number | null;
};

/**
 * The requesting user's wishlist baseline for a card on the PDP. Mirrors the
 * inventory-entry `sinceAdded*` fields but keyed off the favorite ("wishlist")
 * row instead of an owned entry: `sinceAdded*` arithmetic is null when the
 * backend captured no baseline price on the favorite day, and
 * `sinceAddedBaselineDate` may postdate `favoritedAt` when the card predates
 * price tracking (earliest-tracked fallback).
 */
export type CardFavoriteContext = {
  favoritedAt: string | null;
  sinceAddedChangeAmount: number | null;
  sinceAddedChangePercent: number | null;
  sinceAddedBaselineDate: string | null;
};

/**
 * The headline graded lane for a graded-only card (no raw price). Names the
 * grader/grade the PDP should open on plus its market price, so the page shows a
 * chart instead of a blank raw lane.
 */
export type CardDetailGradedReference = {
  grader: string;
  grade: string | null;
  market: number | null;
  currencyCode: string | null;
  label: string;
};

export type CardDetailRecord = {
  cardId: string;
  name: string;
  cardNumber: string;
  setName: string;
  imageUrl: string;
  largeImageUrl?: string | null;
  marketPrice: number | null;
  currencyCode: string;
  marketplaceLabel: string;
  marketplaceUrl?: string | null;
  marketHistory: CardMarketHistoryRecord;
  ebayListings?: CardEbayListingsRecord | null;
  ownedEntries: InventoryCardEntry[];
  variantOptions: MarketHistoryOption[];
  isFavorite?: boolean;
  favoritedAt?: string | null;
  /**
   * The requester's wishlist baseline for this card, or null when they have
   * not wishlisted it. Drives the PDP "since wishlisted" position line for
   * cards the user does not own (an OWNED entry's since-added fields always
   * take precedence).
   */
  favoriteContext?: CardFavoriteContext | null;
  /** Whether THIS user has liked the card (the PDP heart). Distinct from the
   *  wishlist (isFavorite). Absent on list/preview payloads. */
  isLiked?: boolean;
  likedAt?: string | null;
  /**
   * Public like count == number of users who LIKED this card (the PDP heart),
   * distinct from the wishlist. Surfaced as social proof next to the heart.
   * Absent on list/preview payloads.
   */
  likeCount?: number;
  /**
   * eBay-style "people watching" count == distinct viewers of this card within
   * the backend's rolling watcher window. Absent on list/preview payloads.
   */
  watcherCount?: number;
  /** This card's language ('english' | 'japanese'), used to orient the PDP EN/JP toggle. */
  language?: ScannerCardLanguage | null;
  /**
   * The other-language counterpart card id (same illustration), or null when no
   * confident EN↔JP link exists. When null the PDP hides the language toggle.
   */
  counterpartCardId?: string | null;
  /** Language of {@link counterpartCardId} ('english' | 'japanese'), or null. */
  counterpartLanguage?: ScannerCardLanguage | null;
  /**
   * Scrydex percent-change trends for the active pricing context's resolved
   * condition. Values are nullable when the upstream provider omits a bucket.
   * Null at the top level when the snapshot has no trend data at all.
   */
  trendsPct?: CardPricingTrendsPct | null;
  /**
   * Card rules text for the "Product Details" block, extracted from the catalog
   * payload. Null for non-Pokémon or when the source payload lacks it.
   */
  cardText?: CardText | null;
  /**
   * Per-variant TCGplayer product ids sourced from the Scrydex `sourcePayload`
   * (`variants[].marketplaces[name=='tcgplayer'].product_id`). Used to deep-link
   * "View on TCGplayer" to the exact product page for the selected printing.
   * Empty/absent when the upstream payload carries no variant marketplace ids.
   */
  tcgPlayerVariants?: TcgPlayerVariantMarketplace[] | null;
  /**
   * GemRate population (from PPT), keyed by grading company (PSA/BGS/CGC/SGC).
   * Drives the PDP's dynamic-by-grader population report. Absent/empty when the
   * card has no synced population data.
   */
  population?: CardPopulation | null;
  /**
   * Set ONLY for graded-only cards (no raw/ungraded price but graded pricing):
   * the headline graded lane the PDP should default to so a chart shows instead
   * of a blank raw lane. Null for normal (raw-priced) cards.
   */
  gradedReference?: CardDetailGradedReference | null;
  /** Illustrator/artist credit (e.g. "Yuka Morii"). */
  artist?: string | null;
  /** Catalog set release date string (e.g. "2000/06/10"); formatted for display. */
  releaseDate?: string | null;
};

/**
 * GemRate population for one grading company: the per-grade slab counts plus the
 * grader's total population and gem rate. `grades` is keyed by grade label
 * ("10", "9.5", "9", …) → count.
 */
export type CardPopulationGrader = {
  totalPopulation: number;
  gemRate: number | null;
  grades: Record<string, number>;
};

/** Population keyed by grading company (e.g. "PSA", "BGS", "CGC", "SGC"). */
export type CardPopulation = Record<string, CardPopulationGrader>;

/**
 * Minimal client-facing view of a Scrydex `sourcePayload` variant, carrying only
 * the printing name and its marketplace ids. Defensive/untyped upstream JSON, so
 * every field is optional.
 */
export type TcgPlayerVariantMarketplace = {
  name?: string | null;
  marketplaces?: Array<{
    name?: string | null;
    product_id?: string | number | null;
  } | null> | null;
};

// --- Product Details (card rules text) — sourced from the catalog payload ---
export type CardTextAttack = {
  name: string;
  /** Energy types making up the attack cost, e.g. ["Grass","Colorless"]. */
  cost: string[];
  /** Printed damage, e.g. "120" / "120+". Null for no-damage attacks. */
  damage?: string | null;
  text?: string | null;
};

export type CardTextAbility = {
  name: string;
  /** Ability kind label, e.g. "Ability" / "Poké-Power". */
  type?: string | null;
  text?: string | null;
};

export type CardTextTypeValue = {
  /** Energy type, e.g. "Fire". */
  type: string;
  /** Multiplier/modifier, e.g. "×2" / "-20". */
  value: string;
};

export type CardText = {
  number?: string | null;
  rarity?: string | null;
  /** Pokémon energy types, e.g. ["Grass"]. */
  types: string[];
  hp?: string | null;
  /** Evolution stage from subtypes, e.g. "Basic" / "Stage 2". Null when n/a. */
  stage?: string | null;
  abilities: CardTextAbility[];
  attacks: CardTextAttack[];
  weaknesses: CardTextTypeValue[];
  resistances: CardTextTypeValue[];
  /** Energy types in the retreat cost, e.g. ["Colorless"]. */
  retreatCost: string[];
};

// --- Price Trend list (per-condition for raw, per-grade for graded) ---
export type CardPriceTrendMode = 'raw' | 'graded';

export type CardPriceTrendRow = {
  /** Display label: condition ("Near Mint") for raw, grade ("PSA 10") for graded. */
  label: string;
  /** Stable key: condition code (raw) or "<grader> <grade>" (graded). */
  key: string;
  currentPrice: number | null;
  currencyCode: string;
  /** Market-price series, oldest → newest, for the sparkline. */
  points: number[];
  /** Percent change across the series; drives the up/down tint. */
  trendPct?: number | null;
  /**
   * Graded only: PPT smartMarketPrice confidence ("high" | "medium" | "low") and
   * the number of eBay sales behind it. Drives the "· high · 37 sales" trust line.
   * Null for providers/rows that don't carry them (e.g. raw, Scrydex graded).
   */
  confidence?: 'high' | 'medium' | 'low' | null;
  saleCount?: number | null;
};

export type CardPriceTrendList = {
  mode: CardPriceTrendMode;
  /** Branding shown next to the list: TCGplayer for raw, eBay for graded. */
  provider: 'tcgplayer' | 'ebay';
  rows: CardPriceTrendRow[];
};

export type CardPriceTrendsQuery = {
  cardId: string;
  mode: CardPriceTrendMode;
  /** Optional variant filter (raw mode), e.g. "Holofoil". */
  variant?: string | null;
  /** Optional grader filter (graded mode), e.g. "PSA". */
  grader?: string | null;
};

// --- Price history by condition / grade ---
// Raw lane: one series per (variant, condition), e.g. "Holofoil · NM".
// Graded lane: one series per (grader, grade, variant), e.g. "PSA 10 · Holofoil".
export type CardConditionHistoryLane = 'raw' | 'graded';

export type CardConditionHistoryPoint = {
  date: string;
  market: number | null;
  low: number | null;
  mid: number | null;
  high: number | null;
};

export type CardConditionHistorySeries = {
  /** Stable key: "<variant>|<condition>" (raw) or "<grader>|<grade>|<variant>" (graded). */
  key: string;
  /** Display label, e.g. "Holofoil · NM" (raw) or "PSA 10 · Holofoil" (graded). */
  label: string;
  /** Raw lane variant key, e.g. "holofoil"; may be set on the graded lane too. */
  variantKey: string | null;
  /** Raw lane condition code, e.g. "NM"; null on the graded lane. */
  condition: string | null;
  /** Graded lane grader, e.g. "PSA"; null on the raw lane. */
  grader: string | null;
  /** Graded lane grade, e.g. "10"; null on the raw lane. */
  grade: string | null;
  /** Market-price history, oldest → newest. */
  points: CardConditionHistoryPoint[];
};

export type CardConditionHistory = {
  cardId: string;
  /** Echoes the requested lane. */
  lane: CardConditionHistoryLane;
  currencyCode: string;
  series: CardConditionHistorySeries[];
};

export type CardConditionHistoryQuery = {
  cardId: string;
  lane: CardConditionHistoryLane;
  /** Lookback window in days; defaults to 365. */
  days?: number;
};

export type InventoryEntriesQuery = {
  favoritesOnly?: boolean;
  includeInactive?: boolean;
  /**
   * Scope the read to one collection. Omitted — or `ALL_COLLECTIONS_ID` — reads
   * every collection, which is what clients that predate multi-collection get.
   */
  collectionID?: string | null;
};

/**
 * Pagination for another user's public holdings
 * (`GET /api/v1/profiles/{userId}/deck/entries`).
 */
export type ProfileDeckEntriesQuery = {
  limit?: number;
  offset?: number;
};

/**
 * Public portfolio headline for another user
 * (`GET /api/v1/profiles/{userId}/portfolio/summary`).
 *
 * Total value + card count only — the owner-only dashboard (price history,
 * ranges, insights) is deliberately not part of the public read path.
 */
export type ProfilePortfolioSummary = {
  userId: string;
  totalValue: number;
  cardCount: number;
  currency: string;
};

/**
 * Result of uploading the caller's own profile avatar
 * (`POST /api/v1/profile/avatar`). The backend stores the JPEG in the public
 * avatar bucket and returns the public object URL. The caller adds its own
 * cache-buster to the URL before persisting it to the profile.
 */
export type ProfileAvatarUploadResult = {
  avatarUrl: string;
};

/**
 * Result of uploading the caller's own profile COVER photo
 * (`POST /api/v1/profile/cover`). Same lane as the avatar — the public profile
 * bucket, owner-scoped object path derived from the authenticated identity —
 * but a wide banner object rather than the square avatar.
 */
export type ProfileCoverUploadResult = {
  coverUrl: string;
};

/**
 * Result of uploading one image for a post (`POST /api/v1/post-media?postId=`).
 * The client has already created the `posts` row (client-direct) and passes its
 * id; the backend INSERTs the `post_media` row as the caller (Supabase RLS is
 * the authorization: only the post's author may attach media), uploads the JPEG
 * to the private post-media bucket, and returns the new media id. The image is
 * `pending` moderation and invisible to others until a worker approves it.
 */
export type PostMediaUploadResult = {
  mediaId: string;
};

export type CardFavoriteRecord = {
  cardId: string;
  isFavorite: boolean;
  favoritedAt?: string | null;
};

export type CardLikeRecord = {
  cardId: string;
  isLiked: boolean;
  likedAt?: string | null;
};

export type CardFavoriteEntry = {
  cardId: string;
  name: string;
  cardNumber: string;
  setName: string;
  imageUrl: string;
  smallImageUrl?: string | null;
  largeImageUrl?: string | null;
  marketPrice: number | null;
  currencyCode: string;
  favoritedAt: string | null;
  isOwned: boolean;
  /** Owned-copy lane: 'graded' when the user owns a slab, otherwise 'raw'. */
  kind?: 'raw' | 'graded' | null;
  /** Owned copy's print variant (e.g. 'Holofoil'); null for unowned favorites. */
  variantName?: string | null;
  /** Full condition label for owned raw copies (e.g. 'Near Mint'). */
  conditionLabel?: string | null;
  /** Short condition label for owned raw copies (e.g. 'NM'). */
  conditionShortLabel?: string | null;
  /** Grader/grade for owned graded copies; null for raw or unowned favorites. */
  slabContext?: SlabContext | null;
  /** Server-computed rarity bucket; undefined on older cached payloads. */
  rarityBucket?: RarityBucket;
  /** Day-over-day market price change for the owned/raw lane, in `currencyCode`. */
  dayChangeAmount?: number | null;
  dayChangePercent?: number | null;
  // "Since you added it" (favorited) — change in marketPrice versus the market
  // price snapshotted when the card was favorited. All null when no baseline
  // could be resolved; `sinceAddedBaselineDate` reflects the earliest-tracked
  // fallback when the favorite predates price tracking.
  sinceAddedChangeAmount?: number | null;
  sinceAddedChangePercent?: number | null;
  sinceAddedBaselineDate?: string | null;
  /** Last-30-days market series (oldest → newest) for the row sparkline. */
  sparkPoints?: number[] | null;
  /** Percent change across `sparkPoints`; drives the sparkline tint. */
  sparkTrendPct?: number | null;
};

export type CardFavoritesQuery = {
  limit?: number;
  offset?: number;
};

export type CollectionVariantOption = {
  id: string;
  label: string;
};

export type GraderOption = 'Raw' | 'PSA' | 'BGS' | 'CGC';

export const graderOptions: readonly GraderOption[] = ['Raw', 'PSA', 'BGS', 'CGC'] as const;

export type AddToCollectionOptions = {
  variants: CollectionVariantOption[];
  defaultVariant?: string | null;
  defaultPrice?: number;
};

export type PortfolioBuyRequestPayload = {
  cardID: string;
  slabContext: SlabContext | null;
  variantName?: string | null;
  condition: DeckConditionCode | null;
  quantity: number;
  unitPrice: number;
  currencyCode: string;
  paymentMethod: string | null;
  boughtAt: string;
  sourceScanID: string | null;
};

export type PortfolioBuyResponsePayload = {
  deckEntryID: string;
  cardID: string;
  inserted: boolean;
  quantityAdded: number;
  totalSpend: number;
  boughtAt: string;
};

export type InventoryEntryCreateRequestPayload = {
  cardID: string;
  slabContext: SlabContext | null;
  variantName?: string | null;
  condition: DeckConditionCode | null;
  quantity?: number;
  sourceScanID: string | null;
  selectionSource?: 'top' | 'alternate' | 'manual_search' | 'unknown';
  selectedRank?: number | null;
  wasTopPrediction?: boolean | null;
  addedAt: string;
  /**
   * Optional per-unit cost basis in dollars. When set, backend stores it on
   * the inventory row's `cost_basis_cents` column for Insights aggregates.
   */
  costBasisPerUnit?: number | null;
  /**
   * Which collection the card joins. Omitted (or the "All Collections" pseudo-id)
   * files it into the owner's default collection — the backend never takes this
   * id on trust, so one belonging to another account is ignored rather than
   * honoured.
   */
  collectionID?: string | null;
};

export type InventoryEntryCreateResponsePayload = {
  deckEntryID: string;
  cardID: string;
  variantName?: string | null;
  condition?: DeckConditionCode | null;
  confirmationID?: string | null;
  sourceScanID?: string | null;
  addedAt: string;
};

export type PortfolioEntryReplaceRequestPayload = {
  deckEntryID: string;
  cardID: string;
  slabContext: SlabContext | null;
  variantName?: string | null;
  condition: DeckConditionCode | null;
  quantity: number;
  unitPrice: number | null;
  currencyCode: string;
  updatedAt: string;
};

export type PortfolioEntryReplaceResponsePayload = {
  previousDeckEntryID: string;
  deckEntryID: string;
  cardID: string;
  quantity: number;
  unitPrice: number | null;
  updatedAt: string;
  // Market price of the NEW identity, computed server-side with the same logic
  // as the inventory list, so the client's optimistic Collection row shows the
  // correct price immediately after a grade/variant/condition change instead of
  // reusing the card's base price. Optional: older backends omit these.
  marketPrice?: number | null;
  hasMarketPrice?: boolean;
  currencyCode?: string | null;
};

export type PortfolioEntryDeleteRequestPayload = {
  deckEntryID: string;
};

export type PortfolioEntryDeleteResponsePayload = {
  deckEntryID: string;
  cardID: string;
};

export type PortfolioEntryBulkDeleteRequestPayload = {
  deckEntryIDs: string[];
};

export type PortfolioEntryBulkDeleteResponsePayload = {
  deletedDeckEntryIDs: string[];
  deletedCount: number;
};

export type AccountDeleteResponsePayload = {
  deleted: boolean;
  authUserDeleted?: boolean;
};

export type SetPortfolioEntryQuantityRequestPayload = {
  deckEntryID: string;
  quantity: number;
};

export type SetPortfolioEntryQuantityResponsePayload = {
  deckEntryID: string;
  cardID: string;
  quantity: number;
  deleted: boolean;
};

export type UpdateDeckEntryCostBasisRequestPayload = {
  deckEntryID: string;
  /** Per-unit cost basis in dollars. Pass null to clear it. */
  costBasisPerUnit: number | null;
};

export type UpdateDeckEntryCostBasisResponsePayload = {
  deckEntryID: string;
  cardID: string;
  costBasisPerUnit: number | null;
  costBasisPerUnitCents: number | null;
  currencyCode: string;
  updatedAt: string;
};

export type PortfolioSaleRequestPayload = {
  deckEntryID?: string | null;
  cardID: string;
  slabContext: SlabContext | null;
  quantity: number;
  unitPrice: number;
  currencyCode: string;
  paymentMethod: string | null;
  soldAt: string;
  saleSource?: string | null;
  showSessionID: string | null;
  note: string | null;
  sourceScanID: string | null;
};

export type CardTransactionKind = 'bought' | 'sold' | 'traded';

export type CardTransactionPhotoUpload = { jpegBase64: string; width: number; height: number };

export type CreateCardTransactionPayload = {
  kind: CardTransactionKind;
  amountCents: number | null;
  currencyCode: string;
  occurredAt: string;
  note: string | null;
  itemCount: number;
  photo: CardTransactionPhotoUpload | null;
  /** Absolute card image URL carried from the source card (e.g. Sell Now). */
  imageUrl?: string | null;
  /** How the money changed hands; surfaced in the transaction row subtitle. */
  paymentMethod?: PaymentMethod | null;
};

export type CardTransactionRecord = {
  id: string;
  kind: CardTransactionKind;
  amountCents: number | null;
  currencyCode: string;
  occurredAt: string;
  occurredAtLabel?: string | null;
  note: string | null;
  itemCount: number;
  photoUrl: string | null;
  /** Absolute card image URL from the source card; falls back when no photoUrl. */
  imageUrl?: string | null;
  createdAt?: string | null;
  /** How the money changed hands (cash/venmo/…); null when unspecified. */
  paymentMethod?: PaymentMethod | null;
};

export type SaleStatus = 'paid' | 'pending' | 'voided';

export type PaymentMethod = 'cash' | 'venmo' | 'cashapp' | 'paypal' | 'zelle' | 'other';

export type PortfolioSaleResponsePayload = {
  saleID: string;
  deckEntryID: string;
  remainingQuantity: number;
  grossTotal: number;
  soldAt: string;
  paidAt: string | null;
  status: SaleStatus;
  showSessionID: string | null;
};

export type SaleLifecycleResponsePayload = {
  saleID: string;
  paidAt: string | null;
  voidedAt: string | null;
  status: SaleStatus;
  remainingQuantity?: number;
};

export type VendorWalletHandles = {
  venmoHandle: string | null;
  cashappHandle: string | null;
  paypalMeSlug: string | null;
  zelleEmailOrPhone: string | null;
  updatedAt: string | null;
};

export type VendorWalletHandlesUpdate = Partial<Omit<VendorWalletHandles, 'updatedAt'>>;

export const portfolioImportSourceTypes = ['collectr_csv_v1', 'tcgplayer_csv_v1'] as const;

export type PortfolioImportSourceType = (typeof portfolioImportSourceTypes)[number];

export const portfolioImportJobStatuses = [
  'previewing',
  'needs_review',
  'ready',
  'committing',
  'completed',
  'failed',
  'unknown',
] as const;

export type PortfolioImportJobStatus = (typeof portfolioImportJobStatuses)[number];

export const portfolioImportRowStates = [
  'matched',
  'review',
  'unresolved',
  'unsupported',
  'skipped',
  'ready',
  'committed',
  'failed',
  'unknown',
] as const;

export type PortfolioImportRowState = (typeof portfolioImportRowStates)[number];

export const portfolioImportResolveActions = ['match', 'skip'] as const;

export type PortfolioImportResolveAction = (typeof portfolioImportResolveActions)[number];

export const portfolioImportRowFilters = [
  'all',
  'ready',
  'review',
  'unresolved',
  'unsupported',
  'committed',
] as const;

export type PortfolioImportRowFilter = (typeof portfolioImportRowFilters)[number];

export type PortfolioImportPreviewRequestPayload = {
  sourceType: PortfolioImportSourceType;
  fileName: string;
  csvText: string;
};

export type PortfolioImportResolveRequestPayload = {
  rowID: string;
  action: PortfolioImportResolveAction;
  matchedCardID?: string | null;
};

export type PortfolioImportSummary = {
  totalRowCount: number;
  matchedCount: number;
  reviewCount: number;
  unresolvedCount: number;
  unsupportedCount: number;
  readyToCommitCount: number;
  committedCount: number;
  skippedCount: number;
};

export type PortfolioImportCandidateRecord = CatalogSearchResult;

export type PortfolioImportRowRecord = {
  id: string;
  rowIndex: number;
  sourceCollectionName?: string | null;
  sourceCardName: string;
  setName?: string | null;
  collectorNumber?: string | null;
  quantity: number;
  conditionLabel?: string | null;
  currencyCode?: string | null;
  acquisitionUnitPrice?: number | null;
  marketUnitPrice?: number | null;
  matchState: PortfolioImportRowState;
  matchStrategy?: string | null;
  matchedCard?: PortfolioImportCandidateRecord | null;
  candidateCards: PortfolioImportCandidateRecord[];
  warnings: string[];
  rawSummary?: string | null;
};

export type PortfolioImportJobRecord = {
  id: string;
  sourceType: PortfolioImportSourceType;
  status: PortfolioImportJobStatus;
  sourceFileName: string;
  summary: PortfolioImportSummary;
  rows: PortfolioImportRowRecord[];
  warnings: string[];
  errorText?: string | null;
};

export type PortfolioImportCommitResponsePayload = {
  jobID: string;
  status: PortfolioImportJobStatus;
  summary: PortfolioImportSummary;
  job?: PortfolioImportJobRecord | null;
  message?: string | null;
};

export type BulkSellDraftLine = {
  entryId: string;
  cardId: string;
  name: string;
  cardNumber: string;
  setName: string;
  imageUrl: string;
  quantityLimit: number;
  quantity: number;
  marketPrice: number;
  boughtPrice?: number | null;
  soldPrice?: string;
  offerPrice?: string;
  yourPrice?: string;
  currencyCode: string;
  conditionLabel?: string | null;
  slabContext?: SlabContext | null;
};

export type SearchCatalogCardsParams = {
  query: string;
  limit?: number;
};

export type CardDetailQuery = {
  cardId: string;
  slabContext?: SlabContext | null;
};

export type CardDetailLoadOptions = {
  /**
   * When `false`, skip the heavy full-collection inventory fetch on the detail
   * load critical path. `ownedEntries` is returned empty so the caller can
   * source owned context from an already-loaded inventory cache instead. The
   * product detail page (PDP) uses this so the card image + variants render as
   * soon as card + market-history resolve, without waiting on the collection.
   * Defaults to `true` (owned entries included).
   */
  includeOwnedEntries?: boolean;
};

export type CardRecentSalesQuery = CardDetailQuery & {
  source?: CardRecentSaleSource;
  limit?: number;
  refresh?: boolean;
};

export function deckConditionFromCode(code?: DeckConditionCode | null) {
  return deckConditionOptions.find((option) => option.code === code) ?? null;
}

// --- Access gate (public-launch gating) ---
// When the backend "access gate" is CLOSED, only allowed users (admin,
// whitelisted emails, or anyone who redeemed an invite code) get the full app;
// everyone else is held on the "between shows" screen.
export type AccessShowMode = {
  /** Whether card-show mode is currently active (gate open for everyone). */
  active: boolean;
  /** ISO timestamp the show window ends, or null when not time-bounded. */
  until?: string | null;
  /** Seconds remaining in the active show window; 0 when inactive. */
  remainingSeconds?: number;
};

export type AccessStatus = {
  /** Whether the access gate is open for everyone (e.g. card-show mode on). */
  accessOpen: boolean;
  /** Whether THIS user may enter the app (admin / whitelisted / redeemed / open). */
  allowed: boolean;
  /** Whether this user is the admin (drives the show-mode toggle). */
  isAdmin: boolean;
  /** Current card-show mode window. */
  showMode: AccessShowMode;
  /**
   * Whether signed-in users must claim an @handle before using the app.
   * Server-side kill switch for the blocking claim screen: absent/false (or any
   * fetch failure) means no gate, so a backend blip can never trap users.
   */
  handleClaimRequired: boolean;
};

export type AccessRedeemResult = {
  redeemed: boolean;
  allowed: boolean;
};

export type AccessWaitlistResult = {
  ok: boolean;
};

export type CardShowModeResult = {
  accessOpen: boolean;
};

export type AccessWhitelist = {
  emails: string[];
};
