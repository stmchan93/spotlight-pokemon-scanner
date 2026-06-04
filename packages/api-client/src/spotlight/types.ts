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
  jpegBase64: string;
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
  costBasisPerUnit?: number | null;
  costBasisTotal?: number | null;
  isFavorite?: boolean;
  // Day-over-day change in marketPrice computed from the previous day's price
  // history snapshot. Both fields are null when no yesterday snapshot exists,
  // and dayChangePercent is also null when yesterday's price was 0.
  dayChangeAmount?: number | null;
  dayChangePercent?: number | null;
  // Listing fields — populated when the user has marked the entry as listed
  // on an external marketplace (eBay). Drives the "Live on eBay" tile footer.
  listingUrl?: string | null;
  listingPriceCents?: number | null;
  listedAt?: string | null;
};

export type PortfolioInventoryItem = InventoryCardEntry;


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

export type CatalogSearchResult = {
  id: string;
  cardId: string;
  name: string;
  cardNumber: string;
  setName: string;
  subtitle?: string | null;
  imageUrl: string;
  marketPrice?: number | null;
  currencyCode?: string | null;
  ownedQuantity?: number;
  isFavorite?: boolean;
  /** Normalized match confidence in [0, 1] for scanner candidates; null/undefined for catalog search. */
  matchScore?: number | null;
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
   * Scrydex percent-change trends for the active pricing context's resolved
   * condition. Values are nullable when the upstream provider omits a bucket.
   * Null at the top level when the snapshot has no trend data at all.
   */
  trendsPct?: CardPricingTrendsPct | null;
};

export type InventoryEntriesQuery = {
  favoritesOnly?: boolean;
  includeInactive?: boolean;
};

export type CardFavoriteRecord = {
  cardId: string;
  isFavorite: boolean;
  favoritedAt?: string | null;
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
  /** Short condition label for owned raw copies (e.g. 'NM'). */
  conditionShortLabel?: string | null;
  /** Grader/grade for owned graded copies; null for raw or unowned favorites. */
  slabContext?: SlabContext | null;
  /** Day-over-day market price change for the owned/raw lane, in `currencyCode`. */
  dayChangeAmount?: number | null;
  dayChangePercent?: number | null;
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
};

export type PortfolioEntryDeleteRequestPayload = {
  deckEntryID: string;
};

export type PortfolioEntryDeleteResponsePayload = {
  deckEntryID: string;
  cardID: string;
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
  createdAt?: string | null;
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

export type CardRecentSalesQuery = CardDetailQuery & {
  source?: CardRecentSaleSource;
  limit?: number;
  refresh?: boolean;
};

export function deckConditionFromCode(code?: DeckConditionCode | null) {
  return deckConditionOptions.find((option) => option.code === code) ?? null;
}
