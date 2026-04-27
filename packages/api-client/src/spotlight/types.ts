export const historyRanges = ['7D', '1M', '3M', '1Y', 'ALL'] as const;

export type PortfolioHistoryRange = (typeof historyRanges)[number];

export type ChartMode = 'portfolio' | 'sales';
export type ScannerMode = 'raw' | 'slabs';

export type ScannerCapturePayload = {
  mode: ScannerMode;
  jpegBase64: string;
  width: number;
  height: number;
};

export type ScannerMatchResult = {
  scanID: string | null;
  candidates: CatalogSearchResult[];
};

export const spotlightRepositoryLoadStates = ['success', 'empty', 'not_found', 'error'] as const;

export type SpotlightRepositoryLoadState = (typeof spotlightRepositoryLoadStates)[number];

export type SpotlightRepositoryLoadResult<T> = {
  state: SpotlightRepositoryLoadState;
  data: T | null;
  errorMessage: string | null;
};

export type InventorySortOption = 'recent' | 'value' | 'a-z';
export type InventoryFilterOption = 'all' | 'raw' | 'graded';

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
};

export type PortfolioDashboard = {
  summary: PortfolioSummary;
  inventoryCount: number;
  inventoryItems: InventoryCardEntry[];
  recentSales: RecentSaleRecord[];
  ranges: Record<PortfolioHistoryRange, RangeChartData>;
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

export type CardMarketHistoryRecord = {
  currencyCode: string;
  currentPrice?: number | null;
  points: PortfolioChartPoint[];
  availableVariants: MarketHistoryOption[];
  availableConditions: MarketHistoryOption[];
  selectedVariant?: string | null;
  selectedCondition?: string | null;
  insights: CardMarketInsight[];
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

export type CardDetailRecord = {
  cardId: string;
  name: string;
  cardNumber: string;
  setName: string;
  imageUrl: string;
  largeImageUrl?: string | null;
  marketPrice: number;
  currencyCode: string;
  marketplaceLabel: string;
  marketplaceUrl?: string | null;
  marketHistory: CardMarketHistoryRecord;
  ebayListings?: CardEbayListingsRecord | null;
  ownedEntries: InventoryCardEntry[];
  variantOptions: MarketHistoryOption[];
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

export type PortfolioEntryReplaceRequestPayload = {
  deckEntryID: string;
  cardID: string;
  slabContext: SlabContext | null;
  variantName?: string | null;
  condition: DeckConditionCode | null;
  quantity: number;
  unitPrice: number;
  currencyCode: string;
  updatedAt: string;
};

export type PortfolioEntryReplaceResponsePayload = {
  previousDeckEntryID: string;
  deckEntryID: string;
  cardID: string;
  quantity: number;
  unitPrice: number;
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

export type PortfolioSaleResponsePayload = {
  saleID: string;
  deckEntryID: string;
  remainingQuantity: number;
  grossTotal: number;
  soldAt: string;
  showSessionID: string | null;
};

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

export function deckConditionFromCode(code?: DeckConditionCode | null) {
  return deckConditionOptions.find((option) => option.code === code) ?? null;
}
