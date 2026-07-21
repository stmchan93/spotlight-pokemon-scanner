import {
  appendMockBuy,
  buildMockRecentTrade,
  buildMockDashboard,
  getMockCardDetail,
  seedMockCardDetails,
  seedMockCardTransactions,
  seedMockCatalogResults,
  seedMockInventoryEntries,
  seedMockRecentSales,
  seedMockScannerCandidates,
  updateInventoryForSale,
} from './mock-data';
import { labelingSessionAngleLabels, RARITY_BUCKET_VALUES } from './types';
import type {
  AccessRedeemResult,
  AccessStatus,
  AccessWaitlistResult,
  AccessWhitelist,
  AccountDeleteResponsePayload,
  AddToCollectionOptions,
  CardShowModeResult,
  CardFavoriteEntry,
  CardFavoriteRecord,
  CardLikeRecord,
  CardFavoritesQuery,
  CardDetailLoadOptions,
  CardDetailQuery,
  CardDetailGradedReference,
  CardDetailRecord,
  CardFavoriteContext,
  CardPopulation,
  TcgPlayerVariantMarketplace,
  CardEbayListingRecord,
  CardEbayListingsRecord,
  CardConditionHistory,
  CardConditionHistoryLane,
  CardConditionHistoryPoint,
  CardConditionHistoryQuery,
  CardConditionHistorySeries,
  CardMarketInsight,
  CardPriceTrendList,
  CardPriceTrendMode,
  CardPriceTrendRow,
  CardPriceTrendsQuery,
  CardRecentSaleRecord,
  CardRecentSalesQuery,
  CardRecentSalesRecord,
  CardText,
  CardTextAbility,
  CardTextAttack,
  CardTextTypeValue,
  CardTransactionRecord,
  CatalogSearchResult,
  CreateCardTransactionPayload,
  ExpansionRecord,
  InventoryEntryCreateRequestPayload,
  InventoryEntryCreateResponsePayload,
  InventoryCardEntry,
  InventoryEntriesQuery,
  InsightGrowthCard,
  LabelingSessionArtifactRecord,
  LabelingSessionArtifactUploadPayload,
  LabelingSessionCreatePayload,
  LabelingSessionRecord,
  PortfolioEntryBulkDeleteRequestPayload,
  PortfolioEntryBulkDeleteResponsePayload,
  PortfolioEntryDeleteRequestPayload,
  PortfolioEntryDeleteResponsePayload,
  PortfolioEntryReplaceRequestPayload,
  PortfolioEntryReplaceResponsePayload,
  SetPortfolioEntryQuantityRequestPayload,
  SetPortfolioEntryQuantityResponsePayload,
  UpdateDeckEntryCostBasisRequestPayload,
  UpdateDeckEntryCostBasisResponsePayload,
  PortfolioImportCommitResponsePayload,
  PortfolioImportJobRecord,
  PortfolioImportJobStatus,
  PortfolioImportPreviewRequestPayload,
  PortfolioImportResolveRequestPayload,
  PortfolioImportRowRecord,
  PortfolioImportRowState,
  PortfolioImportSourceType,
  PortfolioImportSummary,
  PortfolioBuyRequestPayload,
  PortfolioBuyResponsePayload,
  PortfolioChartPoint,
  PortfolioDashboard,
  PortfolioInsights,
  PortfolioPerformance,
  PortfolioPerformanceRow,
  TransactionInsights,
  PortfolioSaleRequestPayload,
  PortfolioSaleResponsePayload,
  RawPricingMatrix,
  RawPricingMatrixConditionRow,
  RarityBucket,
  RecentSaleRecord,
  SaleLifecycleResponsePayload,
  SaleStatus,
  VendorWalletHandles,
  VendorWalletHandlesUpdate,
  ScannerArtifactUploadResult,
  ScannerCapturePayload,
  ScannerCardLanguage,
  ScannerImagePayload,
  ScanFeedbackPayload,
  ScannerMatchOptions,
  ScannerMatchResult,
  ScannerMode,
  ScannerTargetLanguageMismatch,
  SlabContext,
  SpotlightRepositoryLoadResult,
  WhosThatPokemonMatch,
  WhosThatPokemonPayload,
  WhosThatPokemonResult,
  WhosThatShareCardPayload,
  WhosThatShareCardResult,
} from './types';

/** Catalog search load result augmented with the pagination `hasMore` flag. */
export type CatalogSearchLoadResult = SpotlightRepositoryLoadResult<CatalogSearchResult[]> & {
  hasMore: boolean;
};

/** One page of catalog search results (for infinite scroll). */
export type CatalogSearchPage = {
  cards: CatalogSearchResult[];
  hasMore: boolean;
};

/** Optional server-side filters for catalog search. */
export type CatalogSearchOptions = {
  /** Rarity bucket filter — sent as the `rarityBucket` query-string param. */
  rarityBucket?: RarityBucket;
};

export interface SpotlightRepository {
  loadPortfolioDashboard(options?: { range?: keyof PortfolioDashboard['ranges'] }): Promise<SpotlightRepositoryLoadResult<PortfolioDashboard>>;
  getPortfolioDashboard(): Promise<PortfolioDashboard>;
  getPortfolioRange(range: keyof PortfolioDashboard['ranges']): Promise<PortfolioDashboard['ranges'][keyof PortfolioDashboard['ranges']]>;
  getPortfolioPerformance(): Promise<PortfolioPerformance>;
  loadInventoryEntries(query?: InventoryEntriesQuery): Promise<SpotlightRepositoryLoadResult<InventoryCardEntry[]>>;
  getInventoryEntries(query?: InventoryEntriesQuery): Promise<InventoryCardEntry[]>;
  loadCatalogCards(query: string, limit?: number, offset?: number, options?: CatalogSearchOptions): Promise<CatalogSearchLoadResult>;
  searchCatalogCards(query: string, limit?: number): Promise<CatalogSearchResult[]>;
  /** Paginated catalog search for infinite scroll — returns a page + hasMore. */
  searchCatalogCardsPage(query: string, limit?: number, offset?: number, options?: CatalogSearchOptions): Promise<CatalogSearchPage>;
  matchScannerCapture(
    payload: ScannerCapturePayload,
    options?: ScannerMatchOptions,
  ): Promise<ScannerMatchResult>;
  fetchScanCandidates(
    scanId: string,
    offset: number,
    limit: number,
  ): Promise<{ candidates: CatalogSearchResult[]; total: number }>;
  getScannerCandidates(mode: ScannerMode, limit?: number): Promise<CatalogSearchResult[]>;
  submitScanFeedback(payload: ScanFeedbackPayload): Promise<void>;
  /**
   * "Who's That Pokémon" selfie match. Sends the selfie inline as JSON+base64
   * (plus optional on-device palette hexes) and resolves the backend's top-3
   * species matches. The image is analyzed in the moment and never stored.
   */
  whosThatPokemon(payload: WhosThatPokemonPayload): Promise<WhosThatPokemonResult>;
  /** Server-composed "Who's That Pokémon" share card (PNG, base64). */
  whosThatShareCard(payload: WhosThatShareCardPayload): Promise<WhosThatShareCardResult>;
  createLabelingSession(payload: LabelingSessionCreatePayload): Promise<LabelingSessionRecord>;
  uploadLabelingSessionArtifact(payload: LabelingSessionArtifactUploadPayload): Promise<LabelingSessionArtifactRecord>;
  completeLabelingSession(
    sessionID: string,
    payload?: { completedAt?: string | null },
  ): Promise<LabelingSessionRecord>;
  abortLabelingSession(
    sessionID: string,
    payload?: { abortedAt?: string | null },
  ): Promise<LabelingSessionRecord>;
  loadCardDetail(query: CardDetailQuery, options?: CardDetailLoadOptions): Promise<SpotlightRepositoryLoadResult<CardDetailRecord | null>>;
  getCardDetail(query: CardDetailQuery, options?: CardDetailLoadOptions): Promise<CardDetailRecord | null>;
  getCardMarketHistory(query: CardDetailQuery & {
    condition?: string | null;
    days?: number;
    variant?: string | null;
  }): Promise<CardDetailRecord['marketHistory'] | null>;
  getCardPriceTrends(query: CardPriceTrendsQuery): Promise<CardPriceTrendList | null>;
  getCardConditionHistory(query: CardConditionHistoryQuery): Promise<CardConditionHistory | null>;
  getRawPricingMatrix(cardId: string): Promise<RawPricingMatrix>;
  getCardEbayListings(query: CardDetailQuery & {
    limit?: number;
  }): Promise<CardEbayListingsRecord | null>;
  getCardRecentSales(query: CardRecentSalesQuery): Promise<CardRecentSalesRecord | null>;
  setCardFavorite(cardId: string, isFavorite?: boolean | null): Promise<CardFavoriteRecord>;
  setCardLike(cardId: string, isLiked?: boolean | null): Promise<CardLikeRecord>;
  getCardFavorites(query?: CardFavoritesQuery): Promise<CardFavoriteEntry[]>;
  getAddToCollectionOptions(cardId: string): Promise<AddToCollectionOptions>;
  createInventoryEntry(payload: InventoryEntryCreateRequestPayload): Promise<InventoryEntryCreateResponsePayload>;
  createPortfolioBuy(payload: PortfolioBuyRequestPayload): Promise<PortfolioBuyResponsePayload>;
  replacePortfolioEntry(payload: PortfolioEntryReplaceRequestPayload): Promise<PortfolioEntryReplaceResponsePayload>;
  deletePortfolioEntry(payload: PortfolioEntryDeleteRequestPayload): Promise<PortfolioEntryDeleteResponsePayload>;
  deletePortfolioEntriesBulk(payload: PortfolioEntryBulkDeleteRequestPayload): Promise<PortfolioEntryBulkDeleteResponsePayload>;
  deleteAccount(): Promise<AccountDeleteResponsePayload>;
  /**
   * Export the requesting user's holdings (deck entries) as CSV text. Owner-scoped
   * server-side. Returns the raw CSV body (the response is text/csv, not JSON).
   */
  exportDeckEntriesCsv(): Promise<string>;
  setPortfolioEntryQuantity(payload: SetPortfolioEntryQuantityRequestPayload): Promise<SetPortfolioEntryQuantityResponsePayload>;
  updateDeckEntryCostBasis(payload: UpdateDeckEntryCostBasisRequestPayload): Promise<UpdateDeckEntryCostBasisResponsePayload>;
  createPortfolioSale(payload: PortfolioSaleRequestPayload): Promise<PortfolioSaleResponsePayload>;
  createPortfolioSalesBatch(payloads: PortfolioSaleRequestPayload[]): Promise<PortfolioSaleResponsePayload[]>;
  createCardTransaction(payload: CreateCardTransactionPayload): Promise<CardTransactionRecord>;
  listCardTransactions(): Promise<CardTransactionRecord[]>;
  loadTransactionInsights(): Promise<TransactionInsights>;
  markSalePaid(saleID: string): Promise<SaleLifecycleResponsePayload>;
  voidSale(saleID: string): Promise<SaleLifecycleResponsePayload>;
  getVendorWalletHandles(): Promise<VendorWalletHandles>;
  updateVendorWalletHandles(payload: VendorWalletHandlesUpdate): Promise<VendorWalletHandles>;
  previewPortfolioImport(payload: PortfolioImportPreviewRequestPayload): Promise<PortfolioImportJobRecord>;
  fetchPortfolioImportJob(jobID: string): Promise<PortfolioImportJobRecord>;
  resolvePortfolioImportRow(
    jobID: string,
    payload: PortfolioImportResolveRequestPayload,
  ): Promise<PortfolioImportJobRecord>;
  commitPortfolioImportJob(jobID: string): Promise<PortfolioImportCommitResponsePayload>;
  listExpansions(game?: string): Promise<ExpansionRecord[]>;
  listCardsInExpansion(expansionId: string, query?: string, limit?: number): Promise<CatalogSearchResult[]>;
  getAccessStatus(): Promise<AccessStatus>;
  redeemInviteCode(code: string): Promise<AccessRedeemResult>;
  joinAccessWaitlist(email: string): Promise<AccessWaitlistResult>;
  setCardShowMode(active: boolean, hours?: number): Promise<CardShowModeResult>;
  getAccessWhitelist(): Promise<AccessWhitelist>;
  addAccessWhitelistEmail(email: string): Promise<AccessWhitelist>;
  removeAccessWhitelistEmail(email: string): Promise<AccessWhitelist>;
}

type SpotlightRepositoryErrorKind = 'request_failed' | 'invalid_response' | 'not_found';

export class SpotlightRepositoryRequestError extends Error {
  constructor(
    message: string,
    readonly kind: SpotlightRepositoryErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SpotlightRepositoryRequestError';
  }
}

export function isSpotlightRepositoryRequestError(
  error: unknown,
): error is SpotlightRepositoryRequestError {
  return error instanceof SpotlightRepositoryRequestError;
}

type JsonRequestResult<T> =
  | { kind: 'success'; data: T | null; meta: JsonRequestMeta }
  | { kind: 'not_found'; error: SpotlightRepositoryRequestError; meta: JsonRequestMeta }
  | { kind: 'error'; error: SpotlightRepositoryRequestError; meta: JsonRequestMeta | null };

// 12s (was 6s): the portfolio dashboard fans out to ~14 heavy aggregation
// endpoints in parallel; on mobile networks / a busy backend, 6s false-failed
// slow-but-working requests and surfaced a spurious "couldn't refresh" banner.
const defaultHttpRequestTimeoutMs = 12000;
const scanMatchRequestTimeoutMs = 20000;
// Raw visual matches return in <1s on a healthy network. Give each raw attempt a short
// timeout and retry transient transport/timeout/HTTP failures a couple of times, so one
// stalled upload (weak wifi, a far VPN exit) recovers on the next attempt instead of
// dead-ending to "Photo captured, but matches could not load". Retrying is safe: the
// backend upserts by the stable client-generated scanID (idempotent). Slabs are NOT
// retried here and keep the single long timeout above — their matches take 40-50s and a
// short timeout would false-fail them.
const rawMatchPerAttemptTimeoutMs = 10000;
const rawMatchAttempts = 3; // 1 initial attempt + up to 2 retries
const rawMatchRetryBackoffsMs = [500, 1000];
// The artifact upload carries the full normalized (+ optional source) image as
// base64, so it's heavier than the match request and was being starved by the
// 12s default while match got 20s. Give it its own, longer budget.
const scanArtifactUploadTimeoutMs = 25000;
// "Who's That Pokémon" carries a full selfie as JSON+base64 and the backend runs
// a vision model over it (share-card composition renders a PNG server-side), so
// both calls get a longer budget than the 12s default.
const whosThatPokemonRequestTimeoutMs = 30000;
// The consolidated dashboard endpoint computes every section server-side in one
// request, so it gets a longer budget than a single section. Raised to 30s so a
// cold-cache first load on the small VM (re-reading price history from disk) has
// room to *finish* — which warms the cache — instead of getting aborted at 20s and
// surfacing "couldn't refresh." Normal warm loads are sub-second, so this ceiling
// only ever applies to the rare cold path.
const dashboardRequestTimeoutMs = 30000;
// On-demand per-range history/ledger reads (the 7D→1M→3M→1Y/ALL toggle) hit a
// cold 27M-row cell table: a 3M/1Y window for a ~120-card portfolio reads ~160k
// scattered rows and measured ~5s cold (and the endpoint resolves+aggregates on
// top). At the 12s default a cold toggle could abort, return empty, and get the
// range cached as empty — so re-tapping that month did nothing ("can't toggle").
// Give these reads the same 30s budget as the consolidated dashboard so a cold
// toggle finishes (warming the cache) instead of false-failing.
const portfolioRangeRequestTimeoutMs = 30000;
// The first dashboard call after the backend's page cache goes cold can be slow
// enough to time out, but that attempt warms the cache, so a single short-backoff
// retry usually lands fast. Retry only on transport/timeout failures (never on a
// 404, which means the endpoint isn't deployed and should fall through to fanout).
const dashboardRetryAttempts = 2;
const dashboardRetryBackoffMs = 1200;

type JsonRequestMeta = {
  requestUrl: string;
  attemptCount: number;
};

type JsonRequestCandidateStrategy = 'all_candidates' | 'single_active';

type JsonRequestOptions = {
  allowNotFound?: boolean;
  candidateStrategy?: JsonRequestCandidateStrategy;
  requestLabel?: string;
  logTransport?: boolean;
  timeoutMs?: number;
};

type RepositoryClientContext = {
  appVersion?: string | null;
  buildNumber?: string | null;
};

type CardPricingTrendsPctDTO = {
  days7?: number | null;
  days30?: number | null;
  days90?: number | null;
};

type CardPricingSummaryDTO = {
  currencyCode?: string;
  market?: number | null;
  variant?: string | null;
  trendsPct?: CardPricingTrendsPctDTO | null;
  payload?: {
    condition?: string | null;
  } | null;
  // When a card has no raw price, the server may return a graded slab comp as a
  // reference: pricingMode === 'graded_reference' and market is that graded
  // price. grader/grade describe the slab (e.g. "PSA"/"10").
  pricingMode?: string | null;
  grader?: string | null;
  grade?: string | null;
};

type CardCandidateDTO = {
  id: string;
  name: string;
  setName: string;
  number: string;
  imageSmallURL?: string | null;
  imageLargeURL?: string | null;
  pricing?: CardPricingSummaryDTO | null;
  isFavorite?: boolean | null;
  // Server-computed rarity bucket; validated client-side against the known
  // bucket keys (the client never re-implements the rarity→bucket mapping).
  rarityBucket?: string | null;
  // Raw Scrydex catalog payload; we only read `variants[].marketplaces` to
  // surface per-printing TCGplayer product ids for deep links.
  sourcePayload?: {
    variants?: Array<{
      name?: string | null;
      marketplaces?: Array<{
        name?: string | null;
        product_id?: string | number | null;
      } | null> | null;
    } | null> | null;
  } | null;
};

type DeckEntryDTO = {
  id?: string;
  itemKind?: string | null;
  card: CardCandidateDTO;
  variantName?: string | null;
  slabContext?: {
    grader: string;
    grade?: string | null;
    certNumber?: string | null;
    variantName?: string | null;
  } | null;
  condition?: string | null;
  quantity: number;
  costBasisTotal?: number;
  costBasisCurrencyCode?: string | null;
  costBasisPerUnit?: number | null;
  costBasisCents?: number | null;
  listingUrl?: string | null;
  listingPriceCents?: number | null;
  listedAt?: string | null;
  addedAt?: string;
  isFavorite?: boolean | null;
  favoritedAt?: string | null;
  dayChangeAmount?: number | null;
  dayChangePercent?: number | null;
  sinceAddedChangeAmount?: number | null;
  sinceAddedChangePercent?: number | null;
  sinceAddedBaselineDate?: string | null;
  sparkPoints?: Array<number | null> | null;
  sparkTrendPct?: number | null;
};

type PortfolioHistoryDTO = {
  summary: {
    currentValue: number;
    deltaValue: number;
    deltaPercent?: number | null;
  };
  currencyCode?: string;
  points: Array<{
    date: string;
    totalValue: number;
    /** Cards added (add/buy events) rolled up on this day. */
    addedCount?: number | null;
    /** Total market value (dollars) of the cards added on this day. */
    addedValue?: number | null;
  }>;
};

type PortfolioLedgerDTO = {
  transactions: Array<{
    id: string;
    kind: 'buy' | 'sell';
    card: CardCandidateDTO;
    quantity: number;
    unitPrice?: number | null;
    totalPrice: number;
    currencyCode: string;
    occurredAt: string;
    /**
     * Backend-supplied condition code (e.g. "near_mint", "NM", "lightly_played").
     * The client formats it via mapDeckCondition into a user-friendly label.
     */
    condition?: string | null;
    /**
     * Slab context with grader + grade for graded cards.
     */
    slabContext?: {
      grader?: string | null;
      grade?: string | null;
    } | null;
    paymentMethod?: string | null;
    paidAt?: string | null;
    status?: string | null;
    /** Per-unit cost basis snapshotted on the sale row (dollars). */
    costBasisPerUnit?: number | null;
    /** Derived profit on the sale row (dollars). */
    profit?: number | null;
  }>;
  dailySeries?: Array<{
    date: string;
    revenue: number;
    sellCount?: number | null;
  }>;
};

// Raw insights payload (bestReturn / topSellers come as ledger-style rows that
// the client maps to RecentSaleRecord, same as /api/v1/portfolio/insights).
type PortfolioInsightsDTO = Omit<PortfolioInsights, 'bestReturnOfAllTime' | 'topSellersThisMonth'> & {
  bestReturnOfAllTime?: PortfolioLedgerDTO['transactions'][number] | null;
  topSellersThisMonth?: PortfolioLedgerDTO['transactions'] | null;
};

// Response of the consolidated GET /api/v1/portfolio/dashboard endpoint, which
// bundles every section the screen needs into one request. `sections` carries a
// per-section "ok" / "error: ..." status so a slow slice degrades gracefully.
type PortfolioDashboardDTO = {
  currencyCode?: string;
  inventory?: { entries?: DeckEntryDTO[] } | null;
  insights?: PortfolioInsightsDTO | null;
  ranges?: Partial<Record<keyof PortfolioDashboard['ranges'], {
    history?: PortfolioHistoryDTO | null;
    ledger?: PortfolioLedgerDTO | null;
  }>>;
  sections?: Record<string, string>;
};

type SearchResultsDTO = {
  results: CardCandidateDTO[];
  hasMore?: boolean;
};

type ScanMatchCandidateDTO = {
  rank?: number | null;
  candidate?: CardCandidateDTO | null;
  finalScore?: number | null;
  imageScore?: number | null;
};

type ScanMatchResponseDTO = {
  scanID?: string | null;
  topCandidates?: ScanMatchCandidateDTO[] | null;
  candidatePoolSize?: number | null;
  resolverMode?: string | null;
  slabContext?: DeckEntryDTO['slabContext'];
  reviewDisposition?: string | null;
  reviewReason?: string | null;
  targetLanguageMismatch?: {
    selected?: string | null;
    detected?: string | null;
    confidence?: number | null;
  } | null;
  performance?: {
    serverProcessingMs?: number | null;
  } | null;
};

type ScanCandidatesResponseDTO = {
  candidates?: ScanMatchCandidateDTO[] | null;
  total?: number | null;
};

type ScanArtifactUploadResponseDTO = {
  enabled?: boolean | null;
  reason?: string | null;
  scanID?: string | null;
  skipped?: boolean | null;
  sourceObjectPath?: string | null;
  normalizedObjectPath?: string | null;
  storage?: string | null;
  uploadedAt?: string | null;
};

type CardTextDTO = {
  number?: string | null;
  rarity?: string | null;
  types?: Array<string | null> | null;
  hp?: string | null;
  stage?: string | null;
  abilities?: Array<{
    name?: string | null;
    type?: string | null;
    text?: string | null;
  }> | null;
  attacks?: Array<{
    name?: string | null;
    cost?: Array<string | null> | null;
    damage?: string | null;
    text?: string | null;
  }> | null;
  weaknesses?: Array<{ type?: string | null; value?: string | null }> | null;
  resistances?: Array<{ type?: string | null; value?: string | null }> | null;
  retreatCost?: Array<string | null> | null;
};

type CardDetailFavoriteContextDTO = {
  favoritedAt?: string | null;
  sinceAddedChangeAmount?: number | null;
  sinceAddedChangePercent?: number | null;
  sinceAddedBaselineDate?: string | null;
};

type CardDetailDTO = {
  card: CardCandidateDTO;
  imageSmallURL?: string | null;
  imageLargeURL?: string | null;
  isFavorite?: boolean | null;
  favoritedAt?: string | null;
  favoriteContext?: CardDetailFavoriteContextDTO | null;
  isLiked?: boolean | null;
  likedAt?: string | null;
  likeCount?: number | null;
  watcherCount?: number | null;
  language?: string | null;
  counterpartCardID?: string | null;
  counterpartLanguage?: string | null;
  cardText?: CardTextDTO | null;
  population?: unknown;
  gradedReference?: unknown;
  artist?: string | null;
  setReleaseDate?: string | null;
};

type CardPriceTrendListDTO = {
  mode?: string | null;
  provider?: string | null;
  rows?: Array<{
    label?: string | null;
    key?: string | null;
    currentPrice?: number | null;
    currencyCode?: string | null;
    points?: Array<number | null> | null;
    trendPct?: number | null;
    confidence?: string | null;
    saleCount?: number | null;
  }> | null;
};

type CardConditionHistoryPointDTO = {
  date?: string | null;
  market?: number | null;
  low?: number | null;
  mid?: number | null;
  high?: number | null;
};

type CardConditionHistorySeriesDTO = {
  key?: string | null;
  label?: string | null;
  variantKey?: string | null;
  condition?: string | null;
  grader?: string | null;
  grade?: string | null;
  points?: Array<CardConditionHistoryPointDTO | null> | null;
};

type CardConditionHistoryDTO = {
  cardId?: string | null;
  lane?: string | null;
  currencyCode?: string | null;
  series?: Array<CardConditionHistorySeriesDTO | null> | null;
};

type CardFavoriteDTO = {
  cardID?: string | null;
  cardId?: string | null;
  isFavorite?: boolean | null;
  favoritedAt?: string | null;
};

type CardLikeDTO = {
  cardID?: string | null;
  cardId?: string | null;
  isLiked?: boolean | null;
  likedAt?: string | null;
};

type RawPricingMatrixDTO = {
  cardID?: string;
  currencyCode?: string;
  variants?: Array<{
    variant?: string;
    variantKey?: string;
    conditions?: Array<{
      code?: string;
      label?: string;
      low?: number | null;
      mid?: number | null;
      market?: number | null;
      high?: number | null;
    }>;
  }>;
};

type CardMarketHistoryDTO = {
  currencyCode: string;
  currentPrice?: number | null;
  points: Array<{
    date: string;
    market?: number | null;
    low?: number | null;
    mid?: number | null;
    high?: number | null;
  }>;
  availableVariants: Array<{
    id: string;
    label: string;
    currentPrice?: number | null;
  }>;
  availableConditions: Array<{
    id: string;
    label: string;
    currentPrice?: number | null;
  }>;
  selectedVariant?: string | null;
  selectedCondition?: string | null;
  deltas?: {
    days7?: { priceChange?: number | null; percentChange?: number | null };
    days14?: { priceChange?: number | null; percentChange?: number | null };
    days30?: { priceChange?: number | null; percentChange?: number | null };
  };
  volumeLevel?: 'low' | 'normal' | 'unknown';
  refreshedAt?: string | null;
};

type EbayCompsPriceDTO = {
  amount?: number | null;
  currencyCode?: string | null;
  display?: string | null;
};

type EbayCompsTransactionDTO = {
  id?: string;
  title?: string;
  saleType?: string | null;
  soldAt?: string | null;
  listingDate?: string | null;
  price?: EbayCompsPriceDTO | null;
  currencyCode?: string | null;
  listingURL?: string | null;
  link?: string | null;
};

type EbayCompsDTO = {
  status?: string | null;
  statusReason?: string | null;
  unavailableReason?: string | null;
  transactionCount?: number | null;
  transactions?: EbayCompsTransactionDTO[] | null;
  currencyCode?: string | null;
  searchURL?: string | null;
};

type CardRecentSaleDTO = {
  id?: string | null;
  title?: string | null;
  soldAt?: string | null;
  price?: EbayCompsPriceDTO | null;
  currencyCode?: string | null;
  listingURL?: string | null;
};

type CardRecentSalesDTO = {
  source?: string | null;
  status?: string | null;
  statusReason?: string | null;
  unavailableReason?: string | null;
  fetchedAt?: string | null;
  canRefresh?: boolean | null;
  saleCount?: number | null;
  sales?: CardRecentSaleDTO[] | null;
};

type PortfolioImportSummaryDTO = {
  totalRowCount?: number;
  rowCount?: number;
  matchedCount?: number;
  reviewCount?: number;
  ambiguousCount?: number;
  unresolvedCount?: number;
  unsupportedCount?: number;
  readyToCommitCount?: number;
  readyCount?: number;
  committedCount?: number;
  skippedCount?: number;
};

type PortfolioImportRowDTO = {
  id?: string;
  rowID?: string;
  rowIndex?: number;
  sourceCollectionName?: string | null;
  sourceCardName?: string;
  cardName?: string;
  setName?: string | null;
  collectorNumber?: string | null;
  quantity?: number;
  conditionLabel?: string | null;
  condition?: string | null;
  currencyCode?: string | null;
  acquisitionUnitPrice?: number | null;
  marketUnitPrice?: number | null;
  matchState?: string | null;
  matchStatus?: string | null;
  matchStrategy?: string | null;
  matchedCard?: CardCandidateDTO | null;
  candidateCards?: CardCandidateDTO[] | null;
  warnings?: string[] | null;
  rawSummary?: string | null;
  errorText?: string | null;
  normalizedRow?: {
    cardName?: string | null;
    setName?: string | null;
    collectorNumber?: string | null;
    sourceCondition?: string | null;
  } | null;
};

type PortfolioImportJobDTO = {
  id?: string;
  jobID?: string;
  sourceType?: PortfolioImportSourceType;
  status?: string | null;
  sourceFileName?: string;
  fileName?: string;
  summary?: PortfolioImportSummaryDTO | null;
  rows?: PortfolioImportRowDTO[] | null;
  warnings?: string[] | null;
  errorText?: string | null;
};

type PortfolioImportCommitResponseDTO = {
  jobID: string;
  status?: string | null;
  summary?: PortfolioImportSummaryDTO | null;
  job?: PortfolioImportJobDTO | null;
  message?: string | null;
};

type NormalizedCardPricingTrendsPct = {
  days7: number | null;
  days30: number | null;
  days90: number | null;
};

type NormalizedCardCandidate = {
  id: string;
  name: string;
  setName: string;
  number: string;
  imageSmallURL: string;
  imageLargeURL: string;
  isFavorite: boolean;
  rarityBucket?: RarityBucket;
  pricing: {
    currencyCode: string;
    market: number | null;
    variant?: string | null;
    condition?: string | null;
    trendsPct?: NormalizedCardPricingTrendsPct | null;
    // 'graded_reference' when `market` is a graded slab comp shown in place of a
    // missing raw price; grader/grade describe that slab.
    pricingMode?: string | null;
    grader?: string | null;
    grade?: string | null;
  };
  tcgPlayerVariants: TcgPlayerVariantMarketplace[];
};

function normalizePricingTrendsPct(
  value: { days7?: number | null; days30?: number | null; days90?: number | null } | null | undefined,
): NormalizedCardPricingTrendsPct | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const days7 = normalizeNumber(value.days7);
  const days30 = normalizeNumber(value.days30);
  const days90 = normalizeNumber(value.days90);
  if (days7 === null && days30 === null && days90 === null) {
    return null;
  }
  return { days7, days30, days90 };
}

function buildLoadResult<T>(
  state: SpotlightRepositoryLoadResult<T>['state'],
  data: T | null,
  errorMessage: string | null = null,
): SpotlightRepositoryLoadResult<T> {
  return {
    state,
    data,
    errorMessage,
  };
}

function buildSearchIndexText(entry: InventoryCardEntry) {
  return [
    entry.name,
    entry.setName,
    entry.cardNumber,
    entry.conditionLabel,
    entry.slabContext?.grader,
    entry.slabContext?.grade,
    entry.slabContext?.variantName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function buildHistoryInsights(deltas?: CardMarketHistoryDTO['deltas']): CardMarketInsight[] {
  return [
    {
      id: 'week',
      label: 'this week',
      deltaAmount: deltas?.days7?.priceChange ?? null,
      deltaPercent: deltas?.days7?.percentChange ?? null,
    },
    {
      id: 'twoWeeks',
      label: 'last 2 weeks',
      deltaAmount: deltas?.days14?.priceChange ?? null,
      deltaPercent: deltas?.days14?.percentChange ?? null,
    },
    {
      id: 'month',
      label: 'last month',
      deltaAmount: deltas?.days30?.priceChange ?? null,
      deltaPercent: deltas?.days30?.percentChange ?? null,
    },
  ];
}

function mapDeckCondition(condition?: string | null) {
  switch (condition) {
    case 'near_mint':
      return { label: 'Near Mint', shortLabel: 'NM' };
    case 'lightly_played':
      return { label: 'Lightly Played', shortLabel: 'LP' };
    case 'moderately_played':
      return { label: 'Moderately Played', shortLabel: 'MP' };
    case 'heavily_played':
      return { label: 'Heavily Played', shortLabel: 'HP' };
    case 'damaged':
      return { label: 'Damaged', shortLabel: 'DMG' };
    default:
      return { label: undefined, shortLabel: undefined };
  }
}

function formatShortDate(isoDate: string) {
  const isDateOnly = !isoDate.includes('T');
  const date = new Date(isDateOnly ? `${isoDate}T12:00:00.000Z` : isoDate);
  if (Number.isNaN(date.valueOf())) {
    return 'Today';
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(isDateOnly ? { timeZone: 'UTC' } : {}),
  });
}

function parseDateOnly(isoDate: string) {
  const normalized = isoDate.includes('T') ? isoDate.slice(0, 10) : isoDate;
  const date = new Date(`${normalized}T12:00:00.000Z`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatMonthYearLabel(isoDate: string) {
  const date = parseDateOnly(isoDate);
  if (!date) {
    return formatShortDate(isoDate);
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatRangeLabel(startISO: string, endISO: string) {
  const startLabel = formatShortDate(startISO);
  const endLabel = formatShortDate(endISO);
  return startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
}

function startOfWeekMonday(date: Date) {
  const next = new Date(date);
  const day = next.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
}

function endOfWeekSunday(date: Date) {
  const next = startOfWeekMonday(date);
  next.setUTCDate(next.getUTCDate() + 6);
  return next;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

const emptyPortfolioImportSummary: PortfolioImportSummary = {
  totalRowCount: 0,
  matchedCount: 0,
  reviewCount: 0,
  unresolvedCount: 0,
  unsupportedCount: 0,
  readyToCommitCount: 0,
  committedCount: 0,
  skippedCount: 0,
};

function normalizePortfolioImportStatus(status?: string | null): PortfolioImportJobStatus {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'previewing':
    case 'pending':
    case 'parsing':
    case 'preview_building':
      return 'previewing';
    case 'needs_review':
    case 'review':
    case 'in_review':
    case 'commit_partial':
      return 'needs_review';
    case 'ready':
    case 'ready_to_commit':
    case 'preview_ready':
      return 'ready';
    case 'committing':
      return 'committing';
    case 'completed':
    case 'committed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'unknown';
  }
}

function normalizePortfolioImportRowState(state?: string | null): PortfolioImportRowState {
  switch ((state ?? '').trim().toLowerCase()) {
    case 'matched':
    case 'exact_match':
      return 'matched';
    case 'review':
    case 'ambiguous':
    case 'needs_review':
      return 'review';
    case 'unresolved':
    case 'missing':
      return 'unresolved';
    case 'unsupported':
      return 'unsupported';
    case 'skipped':
      return 'skipped';
    case 'ready':
    case 'ready_to_commit':
    case 'resolved':
      return 'ready';
    case 'committed':
    case 'imported':
      return 'committed';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'unknown';
  }
}

function normalizePortfolioImportSummary(summary?: PortfolioImportSummaryDTO | null): PortfolioImportSummary {
  if (!summary) {
    return { ...emptyPortfolioImportSummary };
  }

  return {
    totalRowCount: summary.totalRowCount ?? summary.rowCount ?? 0,
    matchedCount: summary.matchedCount ?? 0,
    reviewCount: summary.reviewCount ?? summary.ambiguousCount ?? 0,
    unresolvedCount: summary.unresolvedCount ?? 0,
    unsupportedCount: summary.unsupportedCount ?? 0,
    readyToCommitCount: summary.readyToCommitCount ?? summary.readyCount ?? 0,
    committedCount: summary.committedCount ?? 0,
    skippedCount: summary.skippedCount ?? 0,
  };
}

function normalizePortfolioImportCandidate(
  candidate: CardCandidateDTO | null | undefined,
  baseUrl: string,
  inventoryEntries: InventoryCardEntry[],
): CatalogSearchResult | null {
  const normalized = candidate ? normalizeCardCandidate(candidate, baseUrl) : null;
  if (!normalized) {
    return null;
  }

  return {
    id: normalized.id,
    cardId: normalized.id,
    name: normalized.name,
    cardNumber: withCardNumberPrefix(normalized.number),
    setName: normalized.setName,
    subtitle: null,
    imageUrl: pickImageUrl([normalized.imageLargeURL, normalized.imageSmallURL], baseUrl),
    smallImageUrl: pickImageUrl([normalized.imageSmallURL], baseUrl) || null,
    largeImageUrl: pickImageUrl([normalized.imageLargeURL], baseUrl) || null,
    marketPrice: normalized.pricing.market,
    currencyCode: normalized.pricing.currencyCode,
    ownedQuantity: inventoryEntries
      .filter((entry) => entry.cardId === normalized.id)
      .reduce((sum, entry) => sum + entry.quantity, 0),
    isFavorite: normalized.isFavorite,
  };
}

function normalizePortfolioImportRow(
  row: PortfolioImportRowDTO,
  baseUrl: string,
  inventoryEntries: InventoryCardEntry[],
): PortfolioImportRowRecord {
  const warnings = Array.isArray(row.warnings) ? [...row.warnings] : [];
  if (row.errorText && !warnings.includes(row.errorText)) {
    warnings.push(row.errorText);
  }

  const candidateCards = Array.isArray(row.candidateCards)
    ? row.candidateCards
      .map((candidate) => normalizePortfolioImportCandidate(candidate, baseUrl, inventoryEntries))
      .filter((candidate): candidate is CatalogSearchResult => candidate !== null)
    : [];

  const matchedCard = normalizePortfolioImportCandidate(row.matchedCard, baseUrl, inventoryEntries);
  const normalizedRow = row.normalizedRow ?? undefined;

  return {
    id: row.id ?? row.rowID ?? `${row.rowIndex ?? 0}-${row.cardName ?? row.sourceCardName ?? 'row'}`,
    rowIndex: row.rowIndex ?? 0,
    sourceCollectionName: row.sourceCollectionName ?? null,
    sourceCardName: row.sourceCardName ?? row.cardName ?? normalizedRow?.cardName ?? '',
    setName: row.setName ?? normalizedRow?.setName ?? null,
    collectorNumber: row.collectorNumber ?? normalizedRow?.collectorNumber ?? null,
    quantity: row.quantity ?? 1,
    conditionLabel: row.conditionLabel ?? row.condition ?? normalizedRow?.sourceCondition ?? null,
    currencyCode: row.currencyCode ?? null,
    acquisitionUnitPrice: row.acquisitionUnitPrice ?? null,
    marketUnitPrice: row.marketUnitPrice ?? null,
    matchState: normalizePortfolioImportRowState(row.matchState ?? row.matchStatus),
    matchStrategy: row.matchStrategy ?? null,
    matchedCard,
    candidateCards,
    warnings,
    rawSummary: row.rawSummary ?? null,
  };
}

function normalizePortfolioImportJob(
  job: PortfolioImportJobDTO,
  baseUrl: string,
  inventoryEntries: InventoryCardEntry[],
): PortfolioImportJobRecord {
  return {
    id: job.id ?? job.jobID ?? '',
    sourceType: job.sourceType ?? 'collectr_csv_v1',
    status: normalizePortfolioImportStatus(job.status),
    sourceFileName: job.sourceFileName ?? job.fileName ?? '',
    summary: normalizePortfolioImportSummary(job.summary),
    rows: Array.isArray(job.rows)
      ? job.rows.map((row) => normalizePortfolioImportRow(row, baseUrl, inventoryEntries))
      : [],
    warnings: Array.isArray(job.warnings) ? job.warnings : [],
    errorText: job.errorText ?? null,
  };
}

function normalizePortfolioImportCommitResponse(
  response: PortfolioImportCommitResponseDTO,
  baseUrl: string,
  inventoryEntries: InventoryCardEntry[],
): PortfolioImportCommitResponsePayload {
  const summary = normalizePortfolioImportSummary(response.summary);
  const explicitMessage = response.message?.trim();

  return {
    jobID: response.jobID,
    status: normalizePortfolioImportStatus(response.status),
    summary,
    job: response.job ? normalizePortfolioImportJob(response.job, baseUrl, inventoryEntries) : null,
    message: explicitMessage
      ? explicitMessage
      : summary.committedCount > 0
        ? `Imported ${summary.committedCount} row${summary.committedCount === 1 ? '' : 's'}.`
        : null,
  };
}

function conditionCodeFromLabel(
  conditionLabel?: string | null,
): Exclude<InventoryCardEntry['conditionCode'], undefined> | null {
  switch ((conditionLabel ?? '').trim().toLowerCase()) {
    case 'near mint':
    case 'nm':
    case 'near_mint':
      return 'near_mint';
    case 'lightly played':
    case 'lp':
    case 'lightly_played':
      return 'lightly_played';
    case 'moderately played':
    case 'mp':
    case 'moderately_played':
      return 'moderately_played';
    case 'heavily played':
    case 'hp':
    case 'heavily_played':
      return 'heavily_played';
    case 'damaged':
    case 'dmg':
      return 'damaged';
    default:
      return null;
  }
}

function clonePortfolioImportJob(job: PortfolioImportJobRecord): PortfolioImportJobRecord {
  return JSON.parse(JSON.stringify(job)) as PortfolioImportJobRecord;
}

function buildPortfolioImportSummaryFromRows(rows: PortfolioImportRowRecord[]): PortfolioImportSummary {
  return rows.reduce<PortfolioImportSummary>((summary, row) => {
    summary.totalRowCount += 1;
    switch (row.matchState) {
      case 'matched':
        summary.matchedCount += 1;
        summary.readyToCommitCount += 1;
        break;
      case 'ready':
        summary.readyToCommitCount += 1;
        break;
      case 'review':
        summary.reviewCount += 1;
        break;
      case 'unresolved':
      case 'failed':
      case 'unknown':
        summary.unresolvedCount += 1;
        break;
      case 'unsupported':
        summary.unsupportedCount += 1;
        break;
      case 'skipped':
        summary.skippedCount += 1;
        break;
      case 'committed':
        summary.committedCount += 1;
        break;
    }
    return summary;
  }, { ...emptyPortfolioImportSummary });
}

function formatSoldAtLabel(isoDate: string) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.valueOf())) {
    return 'Sold recently';
  }

  return `Sold on ${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
}

function formatTradedAtLabel(isoDate: string) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.valueOf())) {
    return 'Traded recently';
  }

  return `Traded on ${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
}

function cleanedTcgPlayerToken(value?: string | null) {
  // Decompose accented chars (é→e), lowercase, keep apostrophes and slashes
  const normalized = (value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Strip a redundant "pokemon" prefix so set names like "Pokémon Card 151" don't double up
  return (
    normalized
      .replace(/[^a-z0-9/' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^pokemon\s+/, '') || null
  );
}

function buildTcgPlayerSearchUrl(params: {
  name: string;
  cardNumber: string;
  setName: string;
}) {
  const query = [
    'pokemon',
    cleanedTcgPlayerToken(params.setName),
    cleanedTcgPlayerToken(params.name),
    cleanedTcgPlayerToken(params.cardNumber.replace(/^#/, '')),
  ]
    .filter(Boolean)
    .join(' ');

  if (!query || query === 'pokemon') {
    return null;
  }

  // Encode manually: spaces as "+", slashes and apostrophes unencoded (matches TCGPlayer's own format)
  const encodedQ = encodeURIComponent(query)
    .replace(/%20/g, '+')
    .replace(/%2F/g, '/')
    .replace(/%27/g, "'");
  return `https://www.tcgplayer.com/search/all/product?q=${encodedQ}&view=grid`;
}

function buildDetailQueryParams(query: CardDetailQuery) {
  const detailQuery = new URLSearchParams();
  if (query.slabContext?.grader) {
    detailQuery.set('grader', query.slabContext.grader);
  }
  if (query.slabContext?.grade) {
    detailQuery.set('grade', query.slabContext.grade);
  }
  if (query.slabContext?.certNumber) {
    detailQuery.set('cert', query.slabContext.certNumber);
  }
  if (query.slabContext?.variantName) {
    detailQuery.set('variant', query.slabContext.variantName);
  }

  return detailQuery;
}

function buildRawDefaultMarketHistoryQuery(query: CardDetailQuery) {
  const historyQuery = buildDetailQueryParams(query);
  historyQuery.set('days', '30');
  if (!query.slabContext?.grader && !query.slabContext?.grade) {
    historyQuery.set('condition', 'NM');
  }

  return historyQuery;
}

function buildInventoryEntriesQueryParams(query?: InventoryEntriesQuery) {
  const params = new URLSearchParams();
  if (query?.favoritesOnly) {
    params.set('favorites', '1');
  }
  if (query?.includeInactive) {
    params.set('includeInactive', '1');
  }
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

// Row-sparkline series: an array of finite numbers, or null when the backend
// omitted/truncated the sparkline (or sent something malformed). Non-finite
// members are dropped rather than failing the whole series.
function normalizeSparkPoints(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const points = value.filter((point): point is number => typeof point === 'number' && Number.isFinite(point));
  return points.length > 0 ? points : null;
}

function normalizeInteger(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : fallback;
}

function normalizeCurrencyCode(value: unknown) {
  return normalizeString(value)?.toUpperCase() ?? 'USD';
}

// Backend sends 'English'/'Japanese'; the app uses lowercase ScannerCardLanguage.
function normalizeCardLanguage(value: unknown): ScannerCardLanguage | null {
  const text = normalizeString(value)?.toLowerCase();
  if (text === 'english' || text === 'japanese') {
    return text;
  }
  return null;
}

// GemRate population is defensive/untyped upstream JSON: keep only graders that
// carry at least one valid grade count, drop everything malformed. Returns null
// when nothing usable survives so the PDP can branch on presence.
function normalizeCardPopulation(value: unknown): CardPopulation | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const out: CardPopulation = {};
  for (const [grader, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const rawGrades = (raw as { grades?: unknown }).grades;
    const grades: Record<string, number> = {};
    if (rawGrades && typeof rawGrades === 'object') {
      for (const [grade, count] of Object.entries(rawGrades as Record<string, unknown>)) {
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
          grades[grade] = Math.round(count);
        }
      }
    }
    if (Object.keys(grades).length === 0) {
      continue;
    }
    const rawTotal = (raw as { totalPopulation?: unknown }).totalPopulation;
    const rawGemRate = (raw as { gemRate?: unknown }).gemRate;
    const totalPopulation =
      typeof rawTotal === 'number' && Number.isFinite(rawTotal)
        ? Math.max(0, Math.round(rawTotal))
        : Object.values(grades).reduce((sum, n) => sum + n, 0);
    out[grader.toUpperCase()] = {
      totalPopulation,
      gemRate: typeof rawGemRate === 'number' && Number.isFinite(rawGemRate) ? rawGemRate : null,
      grades,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// The backend sends `gradedReference` ONLY for graded-only cards (no raw price):
// the headline graded lane the PDP should open on. Null/malformed → null so the
// PDP keeps the raw default.
function normalizeGradedReference(value: unknown): CardDetailGradedReference | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const grader = normalizeString(record.grader);
  if (!grader) {
    return null;
  }
  const grade = normalizeString(record.grade);
  return {
    grader,
    grade,
    market: normalizeNumber(record.market),
    currencyCode: normalizeCurrencyCode(record.currencyCode),
    label: normalizeString(record.label) ?? [grader, grade].filter(Boolean).join(' '),
  };
}

function normalizeConditionCode(condition?: string | null): InventoryCardEntry['conditionCode'] {
  switch (condition) {
    case 'near_mint':
    case 'lightly_played':
    case 'moderately_played':
    case 'heavily_played':
    case 'damaged':
      return condition;
    default:
      return null;
  }
}

export function toMarketHistoryConditionCode(condition?: string | null): string | null {
  const trimmed = condition?.trim();
  if (!trimmed) {
    return null;
  }
  switch (trimmed.toLowerCase()) {
    case 'nm':
    case 'near_mint':
    case 'near mint':
      return 'NM';
    case 'lp':
    case 'lightly_played':
    case 'lightly played':
      return 'LP';
    case 'mp':
    case 'moderately_played':
    case 'moderately played':
      return 'MP';
    case 'hp':
    case 'heavily_played':
    case 'heavily played':
      return 'HP';
    case 'dm':
    case 'dmg':
    case 'damaged':
      return 'DM';
    default:
      return trimmed.toUpperCase();
  }
}

function normalizeImageUrl(value: unknown, baseUrl?: string) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return '';
  }

  if (/^(?:data|blob|file|content):/i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return /^(?:https?):$/i.test(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  }

  if (baseUrl && /^(?:\/|\.{1,2}\/)/.test(trimmed)) {
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return '';
    }
  }

  return '';
}

function pickImageUrl(candidates: unknown[], baseUrl?: string) {
  for (const candidate of candidates) {
    const imageUrl = normalizeImageUrl(candidate, baseUrl);
    if (imageUrl) {
      return imageUrl;
    }
  }

  return '';
}

function normalizeCardNumber(value: unknown) {
  return normalizeString(value) ?? '--';
}

function withCardNumberPrefix(value: string) {
  return value.startsWith('#') ? value : `#${value}`;
}

// The server owns the rarity→bucket mapping; the client only checks that a
// served value is one of the known bucket keys. Unknown/missing values map to
// undefined so the card simply matches no rarity filter chip (never crashes).
function normalizeRarityBucket(value: unknown): RarityBucket | undefined {
  return typeof value === 'string' && (RARITY_BUCKET_VALUES as readonly string[]).includes(value)
    ? (value as RarityBucket)
    : undefined;
}

function normalizeCardCandidate(candidate: CardCandidateDTO | null | undefined, baseUrl?: string) {
  const id = normalizeString(candidate?.id);
  const name = normalizeString(candidate?.name);
  const setName = normalizeString(candidate?.setName);
  // Unnumbered promos (e.g. JP Game Boy Dragonite, Ancient Mew) have a blank
  // collector number but are valid, selectable cards. Don't gate visibility on
  // `number` — default it to '--' so these don't silently drop out of scan
  // candidates. id + name + setName already identify the candidate.
  const number = normalizeCardNumber(candidate?.number);

  if (!id || !name || !setName) {
    return null;
  }

  return {
    id,
    name,
    setName,
    number,
    imageSmallURL: normalizeImageUrl(candidate?.imageSmallURL, baseUrl),
    imageLargeURL: normalizeImageUrl(candidate?.imageLargeURL, baseUrl),
    isFavorite: normalizeBoolean(candidate?.isFavorite) ?? false,
    rarityBucket: normalizeRarityBucket(candidate?.rarityBucket),
    pricing: {
      currencyCode: normalizeCurrencyCode(candidate?.pricing?.currencyCode),
      market: normalizeNumber(candidate?.pricing?.market),
      variant: normalizeString(candidate?.pricing?.variant),
      condition: normalizeString(candidate?.pricing?.payload?.condition),
      trendsPct: normalizePricingTrendsPct(candidate?.pricing?.trendsPct ?? null),
      pricingMode: normalizeString(candidate?.pricing?.pricingMode),
      grader: normalizeString(candidate?.pricing?.grader),
      grade: normalizeString(candidate?.pricing?.grade),
    },
    tcgPlayerVariants: normalizeTcgPlayerVariants(candidate?.sourcePayload?.variants),
  } satisfies NormalizedCardCandidate;
}

// Carry only the printing name + marketplace ids from the Scrydex sourcePayload
// so the PDP can deep-link "View on TCGplayer" to the exact per-printing product
// page. Defensive against missing/oddly-shaped JSON.
function normalizeTcgPlayerVariants(
  variants: NonNullable<CardCandidateDTO['sourcePayload']>['variants'],
): TcgPlayerVariantMarketplace[] {
  if (!Array.isArray(variants)) {
    return [];
  }
  const normalized: TcgPlayerVariantMarketplace[] = [];
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') {
      continue;
    }
    const marketplaces = Array.isArray(variant.marketplaces)
      ? variant.marketplaces
          .filter(
            (entry): entry is NonNullable<typeof entry> => !!entry && typeof entry === 'object',
          )
          .map((entry) => ({ name: entry.name ?? null, product_id: entry.product_id ?? null }))
      : [];
    normalized.push({ name: variant.name ?? null, marketplaces });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Multipart scan transport
//
// Scan images used to travel as ~150KB+ base64 strings inside JSON bodies,
// which burns JS-thread time on encode + GC (worst on budget Android phones).
// The default transport for POST /api/v1/scan/visual-match and
// POST /api/v1/scan-artifacts is now multipart/form-data:
//   - part `payload`: the same JSON body minus the base64 image field(s)
//   - part `normalized_image` (+ optional `source_image` for scan-artifacts):
//     JPEG file parts the OS streams natively from disk.
// Older backends without multipart answer 404/405/415 — and, critically, the
// CURRENTLY DEPLOYED backends answer 400 ("Invalid JSON body") because their
// JSON reader chokes on the multipart body. All four fall back to the
// JSON+base64 request for that call AND remember the failure for the rest of
// the app session so later scans go straight to JSON. A scan must never hard-
// fail just because multipart is unsupported. (A genuine post-upgrade 400
// costs one extra JSON attempt, which will surface the same 400 — correct,
// just slightly slower on a path that is already an error path.)
// ---------------------------------------------------------------------------

let scanMultipartUnsupportedThisSession = false;

export function __resetScanMultipartSupportForTests() {
  scanMultipartUnsupportedThisSession = false;
}

function canAttemptScanMultipart() {
  return !scanMultipartUnsupportedThisSession && typeof FormData === 'function';
}

function markScanMultipartUnsupported() {
  scanMultipartUnsupportedThisSession = true;
}

function isMultipartUnsupportedStatus(status: number | null | undefined) {
  // 400: deployed pre-multipart backends answer "Invalid JSON body".
  // 502: observed live — the pre-multipart handler drops the connection on a
  //      multipart body and the proxy answers 502.
  // 404/405/415: standard "endpoint/method/media-type unsupported".
  return status === 400 || status === 404 || status === 405 || status === 415 || status === 502;
}

function scannerImageFileUri(
  image: { fileUri?: string | null } | null | undefined,
): string | null {
  return normalizeString(image?.fileUri);
}

// React Native's fetch uploads `{ uri, name, type }` FormData entries by
// streaming the file from disk natively; the DOM typings only know Blob, hence
// the cast.
function appendMultipartJpegPart(
  form: FormData,
  partName: string,
  fileUri: string,
  fileName: string,
) {
  form.append(partName, { uri: fileUri, name: fileName, type: 'image/jpeg' } as unknown as Blob);
}

/**
 * Width/height-only copy of an image payload for the multipart `payload` part —
 * the same JSON as the base64 body minus the inline image bytes (and minus the
 * client-local fileUri, which the backend has no use for).
 */
function multipartImageMetadata(image: ScannerImagePayload) {
  return { width: image.width, height: image.height };
}

/**
 * Materializes an image payload into the inline-base64 shape the JSON endpoints
 * expect. Uses inline bytes when already present; otherwise LAZILY reads the
 * file via the app-supplied reader. Returns null when neither is available —
 * callers decide whether that image was optional.
 */
async function materializeScannerImageForJson(
  image: ScannerImagePayload | null | undefined,
  readFileAsBase64: ScannerCapturePayload['readFileAsBase64'],
): Promise<{ jpegBase64: string; width: number; height: number } | null> {
  if (!image) {
    return null;
  }
  const inline = normalizeString(image.jpegBase64);
  if (inline) {
    return { jpegBase64: inline, width: image.width, height: image.height };
  }
  const fileUri = scannerImageFileUri(image);
  if (!fileUri || !readFileAsBase64) {
    return null;
  }
  try {
    const base64 = normalizeString(await readFileAsBase64(fileUri));
    return base64 ? { jpegBase64: base64, width: image.width, height: image.height } : null;
  } catch {
    return null;
  }
}

// NOTE: `image` is emitted WITHOUT jpegBase64 — this object doubles as the
// multipart `payload` part. The JSON transport adds `image.jpegBase64` at the
// call site (matchScannerCapture) right before serializing.
function createScannerMatchPayload(
  payload: ScannerCapturePayload,
  scanID: string,
  clientContext?: RepositoryClientContext,
): Record<string, unknown> {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en_US';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const appVersion = normalizeString(clientContext?.appVersion) || '0';
  const buildNumber = normalizeString(clientContext?.buildNumber) || '0';
  const slabAnalysis = payload.mode === 'slabs' ? (payload.slabAnalysis ?? null) : null;
  // Phase 2: raw lane forwards an optional on-device collector-number reading as
  // SECONDARY verification (server reads ocrAnalysis.rawEvidence.collectorNumberExact).
  // Slab captures keep carrying their OCR evidence inside slabAnalysis.ocrAnalysis.
  const rawCollectorNumberExact =
    payload.mode === 'raw'
      ? normalizeString(payload.ocrAnalysis?.rawEvidence?.collectorNumberExact)
      : null;
  const rawOcrAnalysis = rawCollectorNumberExact
    ? { rawEvidence: { collectorNumberExact: rawCollectorNumberExact } }
    : null;

  return {
    scanID,
    capturedAt: new Date().toISOString(),
    clientContext: {
      platform: 'react_native',
      appVersion,
      buildNumber,
      localeIdentifier: locale,
      timeZoneIdentifier: timeZone,
    },
    image: {
      width: Math.max(1, normalizeInteger(payload.width, 1)),
      height: Math.max(1, normalizeInteger(payload.height, 1)),
    },
    recognizedTokens: [],
    collectorNumber: rawCollectorNumberExact,
    setHintTokens: [],
    setBadgeHint: null,
    promoCodeHint: null,
    slabGrader: slabAnalysis?.slabGrader ?? null,
    slabGrade: slabAnalysis?.slabGrade ?? null,
    slabCertNumber: slabAnalysis?.slabCertNumber ?? null,
    slabBarcodePayloads: slabAnalysis?.slabBarcodePayloads ?? [],
    slabGraderConfidence: slabAnalysis?.slabGraderConfidence ?? null,
    slabGradeConfidence: slabAnalysis?.slabGradeConfidence ?? null,
    slabCertConfidence: slabAnalysis?.slabCertConfidence ?? null,
    slabCardNumberRaw: slabAnalysis?.slabCardNumberRaw ?? null,
    slabParsedLabelText: slabAnalysis?.slabParsedLabelText ?? [],
    slabClassifierReasons: slabAnalysis?.slabClassifierReasons ?? [],
    slabRecommendedLookupPath: slabAnalysis?.slabRecommendedLookupPath ?? null,
    resolverModeHint: payload.mode === 'slabs' ? 'psa_slab' : 'raw_card',
    rawResolverMode: payload.mode === 'raw' ? 'visual' : null,
    cardLanguage: payload.cardLanguage ?? null,
    cropConfidence: 1,
    warnings: [],
    ocrAnalysis: slabAnalysis?.ocrAnalysis ?? rawOcrAnalysis,
  };
}

function createScanArtifactUploadPayload(
  payload: ScannerCapturePayload,
  scanID: string,
): Record<string, unknown> | null {
  // normalizedImage is the training-critical image; sourceImage is optional
  // context that can drop under phone memory pressure. Upload whatever we have
  // as long as the normalized image is present — never discard it just because
  // the optional source is missing.
  if (!payload.normalizedImage) {
    return null;
  }
  if (payload.captureSource === 'smoke_fixture') {
    return null;
  }

  return {
    scanID,
    submittedAt: normalizeString(payload.submittedAt) ?? new Date().toISOString(),
    captureSource: normalizeString(payload.captureSource) ?? 'camera',
    sourceImage: payload.sourceImage ?? null,
    normalizedImage: payload.normalizedImage,
  };
}

function scannerMatchEndpointPath(payload: ScannerCapturePayload) {
  return payload.mode === 'raw'
    ? 'api/v1/scan/visual-match'
    : 'api/v1/scan/match';
}

function createPseudoUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : ((random & 0x3) | 0x8);
    return value.toString(16);
  });
}

function mapScannerMatchCandidates(
  response: ScanMatchResponseDTO | null | undefined,
  baseUrl?: string,
): CatalogSearchResult[] {
  const topCandidates = Array.isArray(response?.topCandidates) ? response.topCandidates : [];

  return topCandidates.flatMap((entry) => {
    const card = normalizeCardCandidate(entry?.candidate, baseUrl);
    if (!card) {
      return [];
    }

    // When the card has no raw price, `market` is a graded slab comp shown as a
    // reference; tag it so the UI reads it as "PSA 10", not the ungraded value.
    const priceIsGradedReference = card.pricing.pricingMode === 'graded_reference';
    const gradedReferenceLabel = priceIsGradedReference
      ? (`${card.pricing.grader ?? ''} ${card.pricing.grade ?? ''}`.trim() || null)
      : null;

    return [{
      id: card.id,
      cardId: card.id,
      name: card.name,
      cardNumber: withCardNumberPrefix(card.number),
      setName: card.setName,
      subtitle: null,
      imageUrl: pickImageUrl([card.imageLargeURL, card.imageSmallURL], baseUrl),
      smallImageUrl: pickImageUrl([card.imageSmallURL], baseUrl) || null,
      largeImageUrl: pickImageUrl([card.imageLargeURL], baseUrl) || null,
      marketPrice: card.pricing.market,
      currencyCode: card.pricing.currencyCode,
      ownedQuantity: 0,
      isFavorite: card.isFavorite,
      matchScore: normalizeNumber(entry?.finalScore) ?? normalizeNumber(entry?.imageScore),
      // Persisted tray rows keep their full candidates[] — carry the bucket so
      // rehydrated rows can still render/filter without a fresh search.
      rarityBucket: card.rarityBucket,
      priceIsGradedReference,
      gradedReferenceLabel,
    }];
  });
}

function normalizeSlabContext(value: DeckEntryDTO['slabContext']): SlabContext | null {
  const grader = normalizeString(value?.grader);
  if (!grader) {
    return null;
  }

  return {
    grader,
    grade: normalizeString(value?.grade),
    certNumber: normalizeString(value?.certNumber),
    variantName: normalizeString(value?.variantName),
  };
}

function isScannerCardLanguage(value: string | null | undefined): value is ScannerCardLanguage {
  return value === 'english' || value === 'japanese';
}

function normalizeTargetLanguageMismatch(
  value: ScanMatchResponseDTO['targetLanguageMismatch'],
): ScannerTargetLanguageMismatch | null {
  const selected = normalizeString(value?.selected);
  const detected = normalizeString(value?.detected);
  // Only trust a well-formed, genuinely-opposing pair; anything else is ignored
  // so a malformed payload can never wrongly reject a scan.
  if (!isScannerCardLanguage(selected) || !isScannerCardLanguage(detected) || selected === detected) {
    return null;
  }
  return {
    selected,
    detected,
    confidence: normalizeNumber(value?.confidence) ?? 0,
  };
}

function mapDeckEntry(entry: DeckEntryDTO, baseUrl?: string): InventoryCardEntry | null {
  const card = normalizeCardCandidate(entry.card, baseUrl);
  if (!card) {
    return null;
  }

  const slabContext = normalizeSlabContext(entry.slabContext);
  // Most raw entries have NO stored variant (variant persistence is recent and
  // scanner adds don't set one), but the backend RESOLVES a variant to price the
  // entry (card.pricing.variant, e.g. "Holofoil") — use it as the display
  // fallback so the variant line matches the price actually shown.
  const variantName = normalizeString(entry.variantName)
    ?? normalizeString(entry.slabContext?.variantName)
    ?? normalizeString(card.pricing.variant);
  const conditionCopy = mapDeckCondition(entry.condition);
  const requestedConditionCode = normalizeConditionCode(entry.condition);
  const quantity = Math.max(normalizeNumber(entry.quantity) ?? 0, 0);
  const costBasisTotal = normalizeNumber(entry.costBasisTotal);
  const itemKind = normalizeString(entry.itemKind);
  const pricingCondition = conditionCodeFromLabel(card.pricing.condition) ?? normalizeConditionCode(card.pricing.condition);
  const hasMarketPrice = card.pricing.market != null && (
    requestedConditionCode == null
    || pricingCondition == null
    || requestedConditionCode === pricingCondition
  );

  // Prefer the explicit `costBasisPerUnit` the backend now surfaces (sourced
  // from the new cost_basis_cents column); fall back to the legacy derivation
  // from total / quantity when older backends haven't started populating it.
  const explicitCostBasisPerUnit = normalizeNumber(entry.costBasisPerUnit);
  const derivedCostBasisPerUnit =
    costBasisTotal && quantity > 0
      ? Number((costBasisTotal / quantity).toFixed(2))
      : null;

  return {
    id: normalizeString(entry.id) ?? `entry-${card.id}`,
    cardId: card.id,
    name: card.name,
    cardNumber: withCardNumberPrefix(card.number),
    setName: card.setName,
    imageUrl: pickImageUrl([card.imageSmallURL, card.imageLargeURL], baseUrl),
    smallImageUrl: pickImageUrl([card.imageSmallURL], baseUrl) || null,
    largeImageUrl: pickImageUrl([card.imageLargeURL], baseUrl) || null,
    marketPrice: card.pricing.market ?? 0,
    hasMarketPrice,
    currencyCode: card.pricing.currencyCode,
    quantity,
    addedAt: normalizeString(entry.addedAt) ?? new Date().toISOString(),
    kind: itemKind === 'slab' ? 'graded' : itemKind === 'raw' ? 'raw' : (slabContext ? 'graded' : 'raw'),
    variantName,
    conditionCode: normalizeConditionCode(entry.condition),
    conditionLabel: conditionCopy.label ?? null,
    conditionShortLabel: conditionCopy.shortLabel ?? null,
    slabContext,
    rarityBucket: card.rarityBucket,
    costBasisPerUnit: explicitCostBasisPerUnit ?? derivedCostBasisPerUnit,
    costBasisTotal: costBasisTotal ?? null,
    isFavorite: normalizeBoolean(entry.isFavorite) ?? card.isFavorite,
    favoritedAt: normalizeString(entry.favoritedAt) ?? null,
    dayChangeAmount: normalizeNumber(entry.dayChangeAmount) ?? null,
    dayChangePercent: normalizeNumber(entry.dayChangePercent) ?? null,
    sinceAddedChangeAmount: normalizeNumber(entry.sinceAddedChangeAmount) ?? null,
    sinceAddedChangePercent: normalizeNumber(entry.sinceAddedChangePercent) ?? null,
    sinceAddedBaselineDate: normalizeString(entry.sinceAddedBaselineDate) ?? null,
    sparkPoints: normalizeSparkPoints(entry.sparkPoints),
    sparkTrendPct: normalizeNumber(entry.sparkTrendPct) ?? null,
    listingUrl: normalizeString(entry.listingUrl) ?? null,
    listingPriceCents: normalizeNumber(entry.listingPriceCents) ?? null,
    listedAt: normalizeString(entry.listedAt) ?? null,
  };
}

function buildRecentSales(transactions: PortfolioLedgerDTO['transactions'], baseUrl?: string) {
  return transactions
    .flatMap((transaction) => {
      const id = normalizeString(transaction.id);
      const occurredAt = normalizeString(transaction.occurredAt);
      const card = normalizeCardCandidate(transaction.card, baseUrl);
      if (!id || !occurredAt || !card) {
        return [];
      }

      // Compose the display "qualityLabel" the UI shows on the Recent Sales
      // card. For slabs, prefer "<Grader> <Grade>" (e.g. "PSA 10"). For raw,
      // fall back to the human-readable condition label derived from the
      // condition code (e.g. "near_mint" -> "Near Mint").
      const grader = normalizeString(transaction.slabContext?.grader);
      const grade = normalizeString(transaction.slabContext?.grade);
      const conditionCopy = mapDeckCondition(transaction.condition);
      const derivedQualityLabel = (grader && grade ? `${grader} ${grade}` : '')
        || conditionCopy.label
        || '';
      const quantity = normalizeNumber(transaction.quantity);
      const paymentMethod = normalizeString(transaction.paymentMethod) ?? null;
      const paidAt = normalizeString(transaction.paidAt) ?? null;
      const rawStatus = normalizeString(transaction.status);
      const status: SaleStatus | null = (
        rawStatus === 'paid' || rawStatus === 'pending' || rawStatus === 'voided'
          ? rawStatus
          : null
      );

      return [{
        id,
        cardId: card.id,
        kind: transaction.kind === 'sell' ? 'sold' : 'traded',
        name: card.name,
        cardNumber: withCardNumberPrefix(card.number),
        setName: card.setName,
        soldPrice: normalizeNumber(transaction.unitPrice) ?? normalizeNumber(transaction.totalPrice) ?? 0,
        currencyCode: normalizeCurrencyCode(transaction.currencyCode),
        soldAtLabel: transaction.kind === 'sell' ? formatSoldAtLabel(occurredAt) : formatTradedAtLabel(occurredAt),
        soldAtISO: occurredAt,
        imageUrl: pickImageUrl([card.imageSmallURL, card.imageLargeURL], baseUrl),
        smallImageUrl: pickImageUrl([card.imageSmallURL], baseUrl) || null,
        largeImageUrl: pickImageUrl([card.imageLargeURL], baseUrl) || null,
        qualityLabel: derivedQualityLabel || null,
        quantity: quantity ?? null,
        paymentMethod,
        paidAt,
        status,
        costBasisPerUnit: normalizeNumber(transaction.costBasisPerUnit) ?? null,
        profit: normalizeNumber(transaction.profit) ?? null,
      } satisfies RecentSaleRecord];
    });
}

function aggregateDailySalesSeries(
  points: PortfolioChartPoint[],
  range: keyof PortfolioDashboard['ranges'],
) {
  if (range === '1W' || range === '1M' || points.length <= 1) {
    return points.map((point) => ({
      ...point,
      rangeEndISO: point.rangeEndISO ?? point.isoDate,
    }));
  }

  if (range === '3M') {
    const buckets = new Map<string, {
      startISO: string;
      endISO: string;
      value: number;
      salesCount: number;
    }>();

    points.forEach((point) => {
      const pointDate = parseDateOnly(point.isoDate);
      if (!pointDate) {
        return;
      }

      const weekStart = startOfWeekMonday(pointDate);
      const weekEnd = endOfWeekSunday(pointDate);
      const key = formatDateOnly(weekStart);
      const existing = buckets.get(key);
      const nextEndISO = point.rangeEndISO ?? point.isoDate;

      if (!existing) {
        buckets.set(key, {
          startISO: point.isoDate,
          endISO: nextEndISO > formatDateOnly(weekEnd) ? formatDateOnly(weekEnd) : nextEndISO,
          value: point.value,
          salesCount: point.salesCount ?? 0,
        });
        return;
      }

      existing.endISO = nextEndISO > existing.endISO ? nextEndISO : existing.endISO;
      existing.value = Number((existing.value + point.value).toFixed(2));
      existing.salesCount += point.salesCount ?? 0;
    });

    return Array.from(buckets.values()).map((bucket) => ({
      isoDate: bucket.startISO,
      shortLabel: formatRangeLabel(bucket.startISO, bucket.endISO),
      value: Number(bucket.value.toFixed(2)),
      salesCount: bucket.salesCount,
      rangeEndISO: bucket.endISO,
    }));
  }

  const buckets = new Map<string, {
    startISO: string;
    endISO: string;
    value: number;
    salesCount: number;
  }>();

  points.forEach((point) => {
    const pointDate = parseDateOnly(point.isoDate);
    if (!pointDate) {
      return;
    }

    const key = `${pointDate.getUTCFullYear()}-${String(pointDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const nextEndISO = point.rangeEndISO ?? point.isoDate;
    const existing = buckets.get(key);

    if (!existing) {
      buckets.set(key, {
        startISO: point.isoDate,
        endISO: nextEndISO,
        value: point.value,
        salesCount: point.salesCount ?? 0,
      });
      return;
    }

    existing.endISO = nextEndISO > existing.endISO ? nextEndISO : existing.endISO;
    existing.value = Number((existing.value + point.value).toFixed(2));
    existing.salesCount += point.salesCount ?? 0;
  });

  return Array.from(buckets.values()).map((bucket) => ({
    isoDate: bucket.startISO,
    shortLabel: formatMonthYearLabel(bucket.startISO),
    axisLabel: formatMonthYearLabel(bucket.startISO),
    value: Number(bucket.value.toFixed(2)),
    salesCount: bucket.salesCount,
    rangeEndISO: bucket.endISO,
  }));
}

function buildSalesSeries(
  ledger: PortfolioLedgerDTO,
  range: keyof PortfolioDashboard['ranges'],
) {
  const dailySeries = Array.isArray(ledger.dailySeries) ? ledger.dailySeries : [];
  if (dailySeries.length > 0) {
    const points = dailySeries.flatMap((point) => {
      const date = normalizeString(point?.date);
      if (!date) {
        return [];
      }

      return [{
        isoDate: date,
        shortLabel: formatShortDate(date),
        value: normalizeNumber(point?.revenue) ?? 0,
        salesCount: Math.max(0, Math.round(normalizeNumber(point?.sellCount) ?? 0)),
        rangeEndISO: date,
      }];
    });

    return aggregateDailySalesSeries(points, range);
  }

  const transactionPoints = ledger.transactions
    .flatMap((transaction) => {
      if (transaction.kind !== 'sell') {
        return [];
      }

      const occurredAt = normalizeString(transaction.occurredAt);
      if (!occurredAt) {
        return [];
      }

      return [{
        isoDate: occurredAt,
        shortLabel: formatShortDate(occurredAt),
        value: normalizeNumber(transaction.totalPrice) ?? 0,
        salesCount: 1,
        rangeEndISO: occurredAt.includes('T') ? occurredAt.slice(0, 10) : occurredAt,
      }];
    })
    .slice(0, 10)
    .reverse();

  return aggregateDailySalesSeries(transactionPoints, range);
}

function mapRangeToBackend(range: keyof PortfolioDashboard['ranges']) {
  switch (range) {
    case '1W':
      // Backend accepts both `1W` and the legacy `7D` alias for one release cycle.
      return '1W';
    case '1M':
      return '30D';
    case '3M':
      return '90D';
    case 'YTD':
      return 'YTD';
    case '1Y':
      return '1Y';
    case 'ALL':
      return 'ALL';
  }
}

function buildEmptyPortfolioHistory(): PortfolioHistoryDTO {
  return {
    summary: {
      currentValue: 0,
      deltaValue: 0,
      deltaPercent: 0,
    },
    currencyCode: 'USD',
    points: [],
  };
}

function buildEmptyPortfolioLedger(): PortfolioLedgerDTO {
  return {
    transactions: [],
    dailySeries: [],
  };
}

function buildEmptyPortfolioDashboard(): PortfolioDashboard {
  return {
    summary: {
      currentValue: 0,
      changeAmount: 0,
      changePercent: 0,
      asOfLabel: 'Today',
    },
    inventoryCount: 0,
    inventoryItems: [],
    recentSales: [],
    ranges: {
      '1W': { portfolio: [], sales: [] },
      '1M': { portfolio: [], sales: [] },
      '3M': { portfolio: [], sales: [] },
      YTD: { portfolio: [], sales: [] },
      '1Y': { portfolio: [], sales: [] },
      ALL: { portfolio: [], sales: [] },
    },
  };
}

function buildScannerCandidates(mode: ScannerMode, limit = 10) {
  return seedMockScannerCandidates(mode)
    .slice(0, Math.max(1, Math.min(limit, 10)))
    .map((candidate) => ({ ...candidate }));
}

function normalizeScannerMatchToken(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.replace(/[^a-z0-9]/g, '');
}

function normalizeScannerCardNumber(value: string | null | undefined) {
  const raw = typeof value === 'string' ? value.trim().replace(/^#/, '') : '';
  return normalizeScannerMatchToken(raw);
}

function buildScannerCandidateQueries(candidate: CatalogSearchResult) {
  const rawNumber = typeof candidate.cardNumber === 'string'
    ? candidate.cardNumber.trim().replace(/^#/, '')
    : '';

  return [
    [candidate.name, candidate.setName, rawNumber].filter(Boolean).join(' '),
    [candidate.name, rawNumber].filter(Boolean).join(' '),
    [candidate.name, candidate.setName].filter(Boolean).join(' '),
    candidate.name,
  ].filter((query, index, collection) => {
    return query.trim().length >= 2 && collection.indexOf(query) === index;
  });
}

function mergeResolvedScannerCandidate(
  seedCandidate: CatalogSearchResult,
  resolvedCandidate: CatalogSearchResult,
): CatalogSearchResult {
  return {
    ...seedCandidate,
    ...resolvedCandidate,
    currencyCode: resolvedCandidate.currencyCode ?? seedCandidate.currencyCode,
    imageUrl: resolvedCandidate.imageUrl || seedCandidate.imageUrl,
    smallImageUrl: resolvedCandidate.smallImageUrl || seedCandidate.smallImageUrl,
    largeImageUrl: resolvedCandidate.largeImageUrl || seedCandidate.largeImageUrl,
    marketPrice: resolvedCandidate.marketPrice ?? seedCandidate.marketPrice,
    ownedQuantity: resolvedCandidate.ownedQuantity ?? seedCandidate.ownedQuantity,
  };
}

function pickBestScannerCandidateMatch(
  seedCandidate: CatalogSearchResult,
  results: readonly CatalogSearchResult[],
) {
  const expectedName = normalizeScannerMatchToken(seedCandidate.name);
  const expectedSet = normalizeScannerMatchToken(seedCandidate.setName);
  const expectedNumber = normalizeScannerCardNumber(seedCandidate.cardNumber);

  const scored = results
    .map((result) => {
      const nameMatches = normalizeScannerMatchToken(result.name) === expectedName;
      const setMatches = normalizeScannerMatchToken(result.setName) === expectedSet;
      const numberMatches = normalizeScannerCardNumber(result.cardNumber) === expectedNumber;

      let score = 0;
      if (nameMatches) {
        score += 4;
      }
      if (setMatches) {
        score += 3;
      }
      if (numberMatches) {
        score += 4;
      }
      if (nameMatches && numberMatches) {
        score += 2;
      }
      if (nameMatches && setMatches && numberMatches) {
        score += 3;
      }

      return {
        result,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  const bestMatch = scored[0];
  if (!bestMatch || bestMatch.score < 6) {
    return null;
  }

  return mergeResolvedScannerCandidate(seedCandidate, bestMatch.result);
}

function isEmptyPortfolioDashboard(dashboard: PortfolioDashboard) {
  return dashboard.inventoryCount === 0
    && dashboard.recentSales.length === 0
    && Object.values(dashboard.ranges).every((range) => {
      return range.portfolio.length === 0 && range.sales.length === 0;
    });
}

function normalizePortfolioHistory(value: PortfolioHistoryDTO | null | undefined) {
  const summary = isRecord(value?.summary) ? value.summary : {} as Record<string, unknown>;
  const points = Array.isArray(value?.points) ? value.points : [];

  return {
    summary: {
      currentValue: normalizeNumber(summary.currentValue) ?? 0,
      deltaValue: normalizeNumber(summary.deltaValue) ?? 0,
      deltaPercent: normalizeNumber(summary.deltaPercent) ?? 0,
    },
    currencyCode: normalizeCurrencyCode(value?.currencyCode),
    points: points.flatMap((point) => {
      const date = normalizeString(point?.date);
      if (!date) {
        return [];
      }

      return [{
        date,
        totalValue: normalizeNumber(point?.totalValue) ?? 0,
        // Per-day add rollup (optional — older backends omit it). Defensive:
        // a malformed count collapses to 0 so no phantom buy marker renders.
        addedCount: Math.max(0, Math.round(normalizeNumber(point?.addedCount) ?? 0)),
        addedValue: normalizeNumber(point?.addedValue) ?? 0,
      }];
    }),
  } satisfies PortfolioHistoryDTO;
}

function normalizePortfolioLedger(value: PortfolioLedgerDTO | null | undefined) {
  const transactions = Array.isArray(value?.transactions) ? value.transactions : [];
  const dailySeries = Array.isArray(value?.dailySeries) ? value.dailySeries : [];

  return {
    transactions: transactions.flatMap((transaction) => {
      const id = normalizeString(transaction?.id);
      const kind = transaction?.kind === 'buy' || transaction?.kind === 'sell'
        ? transaction.kind
        : null;
      const occurredAt = normalizeString(transaction?.occurredAt);
      const card = normalizeCardCandidate(transaction?.card);
      if (!id || !kind || !occurredAt || !card) {
        return [];
      }

      // Preserve the backend's quality fields so buildRecentSales can map
      // them to a "Near Mint" / "PSA 10" qualityLabel for the Recent Sales
      // cards. Previously the normalizer dropped these, so qualityLabel
      // was always null even though the backend supplied the data.
      const slabContextRaw = transaction?.slabContext;
      const slabContext = slabContextRaw && typeof slabContextRaw === 'object'
        ? {
            grader: normalizeString(slabContextRaw.grader),
            grade: normalizeString(slabContextRaw.grade),
          }
        : null;

      return [{
        id,
        kind,
        card,
        quantity: normalizeNumber(transaction?.quantity) ?? 0,
        unitPrice: normalizeNumber(transaction?.unitPrice),
        totalPrice: normalizeNumber(transaction?.totalPrice) ?? 0,
        currencyCode: normalizeCurrencyCode(transaction?.currencyCode),
        occurredAt,
        condition: normalizeString(transaction?.condition),
        slabContext,
        paymentMethod: normalizeString(transaction?.paymentMethod) ?? null,
        paidAt: normalizeString(transaction?.paidAt) ?? null,
        status: normalizeString(transaction?.status) ?? null,
      }];
    }),
    dailySeries: dailySeries.flatMap((point) => {
      const date = normalizeString(point?.date);
      if (!date) {
        return [];
      }

      return [{
        date,
        revenue: normalizeNumber(point?.revenue) ?? 0,
        sellCount: normalizeNumber(point?.sellCount) ?? 0,
      }];
    }),
  } satisfies PortfolioLedgerDTO;
}

function mapPortfolioSeries(history: PortfolioHistoryDTO): PortfolioChartPoint[] {
  return history.points.map((point) => ({
    isoDate: point.date,
    shortLabel: formatShortDate(point.date),
    value: point.totalValue,
    // Buy-marker fields — re-normalized defensively so a chart point can never
    // carry a negative/NaN count even if a caller bypasses normalizePortfolioHistory.
    addedCount: Math.max(0, Math.round(normalizeNumber(point.addedCount) ?? 0)),
    addedValue: normalizeNumber(point.addedValue) ?? 0,
  }));
}

function mapMarketHistoryOption(
  option: CardMarketHistoryDTO['availableVariants'][number] | null | undefined,
) {
  const id = normalizeString(option?.id);
  const label = normalizeString(option?.label);
  if (!id || !label) {
    return null;
  }

  return {
    id,
    label,
    currentPrice: normalizeNumber(option?.currentPrice),
  };
}

function buildMarketHistoryRecord(
  history: CardMarketHistoryDTO | null | undefined,
  fallbackCurrencyCode: string,
): CardDetailRecord['marketHistory'] {
  const points = Array.isArray(history?.points) ? history.points : [];
  const availableVariants = Array.isArray(history?.availableVariants) ? history.availableVariants : [];
  const availableConditions = Array.isArray(history?.availableConditions) ? history.availableConditions : [];

  return {
    currencyCode: normalizeCurrencyCode(history?.currencyCode ?? fallbackCurrencyCode),
    currentPrice: normalizeNumber(history?.currentPrice),
    points: points.flatMap((point) => {
      const date = normalizeString(point?.date);
      if (!date) {
        return [];
      }

      return [{
        isoDate: date,
        shortLabel: formatShortDate(date),
        value:
          normalizeNumber(point?.market)
          ?? normalizeNumber(point?.mid)
          ?? normalizeNumber(point?.low)
          ?? normalizeNumber(point?.high)
          ?? 0,
      }];
    }),
    availableVariants: availableVariants
      .map((option) => mapMarketHistoryOption(option))
      .filter((option): option is NonNullable<typeof option> => option !== null),
    availableConditions: availableConditions
      .map((option) => mapMarketHistoryOption(option))
      .filter((option): option is NonNullable<typeof option> => option !== null),
    selectedVariant: normalizeString(history?.selectedVariant),
    selectedCondition: normalizeString(history?.selectedCondition),
    insights: buildHistoryInsights(history?.deltas),
    ...(history?.volumeLevel ? { volumeLevel: history.volumeLevel } : {}),
    refreshedAt: normalizeString(history?.refreshedAt),
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeString(item))
    .filter((item): item is string => item !== null);
}

function normalizeCardTextTypeValues(value: unknown): CardTextTypeValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const type = normalizeString((item as { type?: unknown })?.type);
    if (!type) {
      return [];
    }
    return [{ type, value: normalizeString((item as { value?: unknown })?.value) ?? '' }];
  });
}

// Defensive map of the detail's `favoriteContext` (the requester's wishlist
// baseline). Null when absent/malformed or when the user hasn't wishlisted the
// card; malformed members inside the object null out individually.
function buildFavoriteContext(
  payload: CardDetailFavoriteContextDTO | null | undefined,
): CardFavoriteContext | null {
  if (payload == null || typeof payload !== 'object') {
    return null;
  }
  return {
    favoritedAt: normalizeString(payload.favoritedAt),
    sinceAddedChangeAmount: normalizeNumber(payload.sinceAddedChangeAmount),
    sinceAddedChangePercent: normalizeNumber(payload.sinceAddedChangePercent),
    sinceAddedBaselineDate: normalizeString(payload.sinceAddedBaselineDate),
  };
}

function buildCardText(payload: CardTextDTO | null | undefined): CardText | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const abilities: CardTextAbility[] = Array.isArray(payload.abilities)
    ? payload.abilities.flatMap((ability) => {
      const name = normalizeString(ability?.name);
      if (!name) {
        return [];
      }
      return [{ name, type: normalizeString(ability?.type), text: normalizeString(ability?.text) }];
    })
    : [];

  const attacks: CardTextAttack[] = Array.isArray(payload.attacks)
    ? payload.attacks.flatMap((attack) => {
      const name = normalizeString(attack?.name);
      if (!name) {
        return [];
      }
      return [{
        name,
        cost: normalizeStringList(attack?.cost),
        damage: normalizeString(attack?.damage),
        text: normalizeString(attack?.text),
      }];
    })
    : [];

  return {
    number: normalizeString(payload.number),
    rarity: normalizeString(payload.rarity),
    types: normalizeStringList(payload.types),
    hp: normalizeString(payload.hp),
    stage: normalizeString(payload.stage),
    abilities,
    attacks,
    weaknesses: normalizeCardTextTypeValues(payload.weaknesses),
    resistances: normalizeCardTextTypeValues(payload.resistances),
    retreatCost: normalizeStringList(payload.retreatCost),
  };
}

function buildCardPriceTrendList(
  payload: CardPriceTrendListDTO | null | undefined,
): CardPriceTrendList | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const mode: CardPriceTrendMode = payload.mode === 'graded' ? 'graded' : 'raw';
  const provider: CardPriceTrendList['provider'] =
    payload.provider === 'ebay' || payload.provider === 'tcgplayer'
      ? payload.provider
      : mode === 'graded'
        ? 'ebay'
        : 'tcgplayer';

  const rows: CardPriceTrendRow[] = Array.isArray(payload.rows)
    ? payload.rows.flatMap((row) => {
      const label = normalizeString(row?.label);
      const key = normalizeString(row?.key);
      if (!label || !key) {
        return [];
      }
      const points = Array.isArray(row?.points)
        ? row.points.map((point) => normalizeNumber(point) ?? 0)
        : [];
      const confidenceRaw = normalizeString(row?.confidence)?.toLowerCase();
      const confidence =
        confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
          ? confidenceRaw
          : null;
      return [{
        label,
        key,
        currentPrice: normalizeNumber(row?.currentPrice),
        currencyCode: normalizeCurrencyCode(row?.currencyCode),
        points,
        trendPct: normalizeNumber(row?.trendPct),
        confidence,
        saleCount: normalizeNumber(row?.saleCount),
      }];
    })
    : [];

  return { mode, provider, rows };
}

function buildCardConditionHistory(
  payload: CardConditionHistoryDTO | null | undefined,
  requestedLane: CardConditionHistoryLane,
): CardConditionHistory | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const lane: CardConditionHistoryLane = payload.lane === 'graded' || payload.lane === 'raw'
    ? payload.lane
    : requestedLane;
  const currencyCode = normalizeCurrencyCode(payload.currencyCode);

  const series: CardConditionHistorySeries[] = Array.isArray(payload.series)
    ? payload.series.flatMap((entry) => {
      const key = normalizeString(entry?.key);
      const label = normalizeString(entry?.label);
      if (!key || !label) {
        return [];
      }
      const points: CardConditionHistoryPoint[] = Array.isArray(entry?.points)
        ? entry.points.flatMap((point) => {
          const date = normalizeString(point?.date);
          if (!date) {
            return [];
          }
          return [{
            date,
            market: normalizeNumber(point?.market),
            low: normalizeNumber(point?.low),
            mid: normalizeNumber(point?.mid),
            high: normalizeNumber(point?.high),
          }];
        })
        : [];
      // The endpoint omits series with no points, but defend against a stray
      // empty series so the selector never renders a chartless option.
      if (points.length === 0) {
        return [];
      }
      return [{
        key,
        label,
        variantKey: normalizeString(entry?.variantKey),
        condition: normalizeString(entry?.condition),
        grader: normalizeString(entry?.grader),
        grade: normalizeString(entry?.grade),
        points,
      }];
    })
    : [];

  return {
    cardId: normalizeString(payload.cardId) ?? '',
    lane,
    currencyCode,
    series,
  };
}

function buildCardEbayListingRecord(
  listing: EbayCompsTransactionDTO,
  fallbackCurrencyCode: string,
): CardEbayListingRecord | null {
  const id = normalizeString(listing.id);
  const title = normalizeString(listing.title);
  if (!id || !title) {
    return null;
  }

  const nestedCurrencyCode = normalizeString(listing.price?.currencyCode);
  return {
    id,
    title,
    saleType: normalizeString(listing.saleType),
    listingDate: normalizeString(listing.listingDate ?? listing.soldAt),
    priceAmount: normalizeNumber(listing.price?.amount),
    currencyCode: normalizeCurrencyCode(listing.currencyCode ?? nestedCurrencyCode ?? fallbackCurrencyCode),
    listingUrl: normalizeString(listing.listingURL ?? listing.link),
  };
}

function buildCardEbayListingsRecord(
  payload: EbayCompsDTO | null | undefined,
  fallbackCurrencyCode: string,
): CardEbayListingsRecord | null {
  if (!payload) {
    return null;
  }

  const listings = Array.isArray(payload.transactions)
    ? payload.transactions
      .map((listing) => buildCardEbayListingRecord(listing, fallbackCurrencyCode))
      .filter((listing): listing is CardEbayListingRecord => listing !== null)
      .sort((left, right) => {
        const leftPrice = left.priceAmount;
        const rightPrice = right.priceAmount;

        if (leftPrice == null && rightPrice == null) {
          return left.title.localeCompare(right.title);
        }

        if (leftPrice == null) {
          return 1;
        }

        if (rightPrice == null) {
          return -1;
        }

        if (leftPrice !== rightPrice) {
          return leftPrice - rightPrice;
        }

        return left.title.localeCompare(right.title);
      })
    : [];

  return {
    status: normalizeString(payload.status) === 'unavailable' ? 'unavailable' : 'available',
    statusReason: normalizeString(payload.statusReason),
    unavailableReason: normalizeString(payload.unavailableReason),
    searchUrl: normalizeString(payload.searchURL),
    listingCount: normalizeNumber(payload.transactionCount) ?? listings.length,
    listings,
  };
}

function buildCardRecentSaleRecord(
  sale: CardRecentSaleDTO,
  fallbackCurrencyCode: string,
): CardRecentSaleRecord | null {
  const id = normalizeString(sale.id);
  const title = normalizeString(sale.title) ?? 'Untitled eBay sale';
  if (!id) {
    return null;
  }

  const nestedCurrencyCode = normalizeString(sale.price?.currencyCode);
  return {
    id,
    title,
    soldAt: normalizeString(sale.soldAt),
    priceAmount: normalizeNumber(sale.price?.amount),
    currencyCode: normalizeCurrencyCode(sale.currencyCode ?? nestedCurrencyCode ?? fallbackCurrencyCode),
    saleUrl: normalizeString(sale.listingURL),
  };
}

function buildCardRecentSalesRecord(
  payload: CardRecentSalesDTO | null | undefined,
  fallbackCurrencyCode: string,
): CardRecentSalesRecord | null {
  if (!payload) {
    return null;
  }

  const sales = Array.isArray(payload.sales)
    ? payload.sales
      .map((sale) => buildCardRecentSaleRecord(sale, fallbackCurrencyCode))
      .filter((sale): sale is CardRecentSaleRecord => sale !== null)
      .sort((left, right) => {
        const leftTime = Date.parse(left.soldAt ?? '');
        const rightTime = Date.parse(right.soldAt ?? '');
        const leftHasTime = Number.isFinite(leftTime);
        const rightHasTime = Number.isFinite(rightTime);
        if (leftHasTime && rightHasTime && leftTime !== rightTime) {
          return rightTime - leftTime;
        }
        if (leftHasTime !== rightHasTime) {
          return leftHasTime ? -1 : 1;
        }
        const leftPrice = left.priceAmount;
        const rightPrice = right.priceAmount;
        if (leftPrice == null && rightPrice == null) {
          return left.title.localeCompare(right.title);
        }
        if (leftPrice == null) {
          return 1;
        }
        if (rightPrice == null) {
          return -1;
        }
        if (leftPrice !== rightPrice) {
          return rightPrice - leftPrice;
        }
        return left.title.localeCompare(right.title);
      })
    : [];

  return {
    source: normalizeString(payload.source) === 'ebay' ? 'ebay' : 'ebay',
    status: normalizeString(payload.status) === 'available' ? 'available' : 'unavailable',
    statusReason: normalizeString(payload.statusReason),
    unavailableReason: normalizeString(payload.unavailableReason),
    fetchedAt: normalizeString(payload.fetchedAt),
    canRefresh: normalizeBoolean(payload.canRefresh) ?? false,
    saleCount: normalizeNumber(payload.saleCount) ?? sales.length,
    sales,
  };
}

function errorMessageFromUnknown(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    const normalizedMessage = error.message.trim().toLowerCase();
    if (normalizedMessage === 'network request failed' || normalizedMessage === 'failed to fetch') {
      return fallback;
    }
    return error.message;
  }

  return fallback;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

async function safeResponseText(response: Response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export class MockSpotlightRepository implements SpotlightRepository {
  private inventoryEntries = seedMockInventoryEntries();
  private recentSales = seedMockRecentSales();
  private cardTransactions: CardTransactionRecord[] = seedMockCardTransactions();
  private catalogResults = seedMockCatalogResults();
  private cardDetails = seedMockCardDetails();
  private favoriteCardTimestamps = new Map<string, string>();
  private likeCardTimestamps = new Map<string, string>();
  private portfolioImportJobs = new Map<string, PortfolioImportJobRecord>();
  private labelingSessions = new Map<string, LabelingSessionRecord>();
  private labelingSessionArtifacts = new Map<string, LabelingSessionArtifactRecord>();
  // Access gate is OPEN in mock/dev so local + test flows aren't gated.
  private accessShowModeActive = true;
  private accessWhitelist: string[] = [];

  private favoriteTimestampForCard(cardId: string) {
    return this.favoriteCardTimestamps.get(cardId) ?? null;
  }

  private annotateInventoryEntry(entry: InventoryCardEntry): InventoryCardEntry {
    return {
      ...entry,
      isFavorite: this.favoriteCardTimestamps.has(entry.cardId),
    };
  }

  private inventoryEntriesForQuery(query?: InventoryEntriesQuery) {
    const entries = this.inventoryEntries.map((entry) => this.annotateInventoryEntry({ ...entry }));
    if (query?.favoritesOnly) {
      return entries.filter((entry) => entry.isFavorite);
    }
    return entries;
  }

  private annotateCatalogResult(result: CatalogSearchResult): CatalogSearchResult {
    return {
      ...result,
      isFavorite: this.favoriteCardTimestamps.has(result.cardId),
    };
  }

  async loadPortfolioDashboard(_options?: { range?: keyof PortfolioDashboard['ranges'] }) {
    const dashboard = buildMockDashboard(this.inventoryEntriesForQuery(), this.recentSales);
    dashboard.inventoryItems = dashboard.inventoryItems.map((entry) => this.annotateInventoryEntry(entry));
    return buildLoadResult(
      dashboard.inventoryItems.length > 0 || dashboard.recentSales.length > 0 ? 'success' : 'empty',
      dashboard,
    );
  }

  async getPortfolioDashboard() {
    const result = await this.loadPortfolioDashboard();
    return result.data ?? buildEmptyPortfolioDashboard();
  }

  async getPortfolioRange(range: keyof PortfolioDashboard['ranges']) {
    const dashboard = await this.getPortfolioDashboard();
    return dashboard.ranges[range];
  }

  async getPortfolioPerformance(): Promise<PortfolioPerformance> {
    const entries = this.inventoryEntriesForQuery();
    const rows: PortfolioPerformanceRow[] = entries.map((entry) => {
      const currentPrice = entry.hasMarketPrice ? entry.marketPrice : null;
      const currentValue = currentPrice != null ? currentPrice * entry.quantity : null;
      return {
        entryId: entry.id,
        cardId: entry.cardId,
        name: entry.name,
        cardNumber: entry.cardNumber,
        setName: entry.setName,
        imageUrl: entry.smallImageUrl ?? entry.imageUrl ?? null,
        smallImageUrl: entry.smallImageUrl ?? null,
        quantity: entry.quantity,
        kind: entry.kind,
        grade: entry.slabContext?.grade ?? null,
        variantName: entry.variantName ?? null,
        condition: entry.conditionLabel ?? null,
        currentPrice,
        currentValue,
        costBasisTotal: entry.costBasisTotal ?? null,
        jan1Price: null,
        yearStartValue: null,
        ytdGainDollar: null,
        ytdGainPercent: null,
        todayGainDollar: null,
        todayGainPercent: null,
        monthGainDollar: null,
        monthGainPercent: null,
        isFavorite: entry.isFavorite === true,
        sparkline: [],
      };
    });
    return {
      itemCount: rows.length,
      currencyCode: entries[0]?.currencyCode ?? 'USD',
      refreshedAt: new Date(0).toISOString(),
      rows,
    };
  }

  async loadInventoryEntries(query?: InventoryEntriesQuery) {
    const entries = this.inventoryEntriesForQuery(query);
    return buildLoadResult(entries.length > 0 ? 'success' : 'empty', entries);
  }

  async getInventoryEntries(query?: InventoryEntriesQuery) {
    const result = await this.loadInventoryEntries(query);
    return result.data ?? [];
  }

  async loadCatalogCards(query: string, limit = 20, offset = 0, options?: CatalogSearchOptions): Promise<CatalogSearchLoadResult> {
    const normalized = query.trim().toLowerCase();
    const rarityBucket = options?.rarityBucket;
    // Mirrors the HTTP repository: a rarity chip alone is a valid search.
    if (normalized.length < 2 && !rarityBucket) {
      return { ...buildLoadResult('empty', []), hasMore: false };
    }

    const start = Math.max(0, offset);
    const matched = this.catalogResults.filter((result) => {
      if (rarityBucket && result.rarityBucket !== rarityBucket) {
        return false;
      }
      if (normalized.length === 0) {
        return true;
      }
      return [result.name, result.setName, result.cardNumber, result.subtitle]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalized);
    });
    const results = matched
      .slice(start, start + limit)
      .map((result) => ({
        ...result,
        ownedQuantity: this.inventoryEntries
          .filter((entry) => entry.cardId === result.cardId)
          .reduce((sum, entry) => sum + entry.quantity, 0),
      }))
      .map((result) => this.annotateCatalogResult(result));

    return {
      ...buildLoadResult(results.length > 0 ? 'success' : 'empty', results),
      hasMore: matched.length > start + limit,
    };
  }

  async searchCatalogCards(query: string, limit = 20) {
    const result = await this.loadCatalogCards(query, limit);
    return result.data ?? [];
  }

  async searchCatalogCardsPage(query: string, limit = 20, offset = 0, options?: CatalogSearchOptions): Promise<CatalogSearchPage> {
    const result = await this.loadCatalogCards(query, limit, offset, options);
    return { cards: result.data ?? [], hasMore: result.hasMore };
  }

  async matchScannerCapture(payload: ScannerCapturePayload, _options?: ScannerMatchOptions) {
    const candidates = buildScannerCandidates(payload.mode, 10);
    return {
      scanID: createPseudoUUID(),
      candidates,
      candidatePoolSize: candidates.length,
    } satisfies ScannerMatchResult;
  }

  async fetchScanCandidates(_scanId: string, offset: number, limit: number) {
    const all = buildScannerCandidates('raw', 30);
    const candidates = all.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
    return { candidates, total: all.length };
  }

  async getScannerCandidates(mode: ScannerMode, limit = 10) {
    return buildScannerCandidates(mode, limit);
  }

  async submitScanFeedback(_payload: ScanFeedbackPayload) {
    return undefined;
  }

  async whosThatPokemon(_payload: WhosThatPokemonPayload): Promise<WhosThatPokemonResult> {
    return {
      matches: [
        {
          species: 'Pikachu',
          pokedexId: 25,
          confidence: 0.92,
          reason: 'Bright-eyed, high-energy, and impossible to miss in a crowd.',
        },
        {
          species: 'Snorlax',
          pokedexId: 143,
          confidence: 0.54,
          reason: 'Radiates serious nap-first, snack-second energy.',
        },
        {
          species: 'Psyduck',
          pokedexId: 54,
          confidence: 0.21,
          reason: 'A little chaotic, endlessly lovable, mildly confused.',
        },
      ],
    };
  }

  async whosThatShareCard(_payload: WhosThatShareCardPayload): Promise<WhosThatShareCardResult> {
    // 1x1 transparent PNG so mock share flows produce a real (tiny) file.
    return {
      pngBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    };
  }

  async createLabelingSession(payload: LabelingSessionCreatePayload) {
    const cardID = normalizeString(payload.cardID);
    if (!cardID) {
      throw new SpotlightRepositoryRequestError('cardID is required.', 'request_failed');
    }

    const sessionID = normalizeString(payload.sessionID) ?? createPseudoUUID();
    const createdAt = normalizeString(payload.createdAt) ?? new Date().toISOString();
    const session: LabelingSessionRecord = {
      sessionID,
      cardID,
      status: 'capturing',
      createdAt,
      completedAt: null,
      abortedAt: null,
      artifactCount: 0,
    };
    this.labelingSessions.set(sessionID, { ...session });
    return { ...session };
  }

  async uploadLabelingSessionArtifact(payload: LabelingSessionArtifactUploadPayload) {
    const session = this.labelingSessions.get(payload.sessionID);
    if (!session) {
      throw new SpotlightRepositoryRequestError('Labeling session not found.', 'not_found', 404);
    }

    const artifactID = createPseudoUUID();
    const artifact: LabelingSessionArtifactRecord = {
      artifactID,
      sessionID: payload.sessionID,
      angleIndex: payload.angleIndex,
      angleLabel: payload.angleLabel,
      sourceObjectPath: `mock://labeling-sessions/${payload.sessionID}/${artifactID}/source.jpg`,
      normalizedObjectPath: `mock://labeling-sessions/${payload.sessionID}/${artifactID}/normalized.jpg`,
      uploadedAt: payload.submittedAt,
    };

    this.labelingSessionArtifacts.set(artifactID, { ...artifact });
    this.labelingSessions.set(payload.sessionID, {
      ...session,
      artifactCount: (session.artifactCount ?? 0) + 1,
    });
    return { ...artifact };
  }

  async completeLabelingSession(
    sessionID: string,
    payload: { completedAt?: string | null } = {},
  ) {
    const session = this.labelingSessions.get(sessionID);
    if (!session) {
      throw new SpotlightRepositoryRequestError('Labeling session not found.', 'not_found', 404);
    }
    if ((session.artifactCount ?? 0) < labelingSessionAngleLabels.length) {
      throw new SpotlightRepositoryRequestError(
        `Labeling session requires ${labelingSessionAngleLabels.length} artifacts.`,
        'request_failed',
      );
    }

    const nextSession: LabelingSessionRecord = {
      ...session,
      status: 'completed',
      completedAt: normalizeString(payload.completedAt) ?? new Date().toISOString(),
      abortedAt: null,
    };
    this.labelingSessions.set(sessionID, { ...nextSession });
    return { ...nextSession };
  }

  async abortLabelingSession(
    sessionID: string,
    payload: { abortedAt?: string | null } = {},
  ) {
    const session = this.labelingSessions.get(sessionID);
    if (!session) {
      throw new SpotlightRepositoryRequestError('Labeling session not found.', 'not_found', 404);
    }

    const nextSession: LabelingSessionRecord = {
      ...session,
      status: 'aborted',
      completedAt: null,
      abortedAt: normalizeString(payload.abortedAt) ?? new Date().toISOString(),
    };
    this.labelingSessions.set(sessionID, { ...nextSession });
    return { ...nextSession };
  }

  async loadCardDetail(query: CardDetailQuery, options?: CardDetailLoadOptions) {
    const includeOwnedEntries = options?.includeOwnedEntries ?? true;
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, query);
    return detail
      ? buildLoadResult('success', {
        ...detail,
        ownedEntries: includeOwnedEntries
          ? detail.ownedEntries.map((entry) => this.annotateInventoryEntry(entry))
          : [],
        isFavorite: this.favoriteCardTimestamps.has(query.cardId),
        favoritedAt: this.favoriteTimestampForCard(query.cardId),
        isLiked: this.likeCardTimestamps.has(query.cardId),
        likedAt: this.likeCardTimestamps.get(query.cardId) ?? null,
        likeCount: detail.likeCount ?? (this.likeCardTimestamps.has(query.cardId) ? 1 : 0),
        watcherCount: detail.watcherCount ?? 0,
        language: detail.language ?? null,
        counterpartCardId: detail.counterpartCardId ?? null,
        counterpartLanguage: detail.counterpartLanguage ?? null,
      })
      : buildLoadResult('not_found', null);
  }

  async getCardDetail(query: CardDetailQuery, options?: CardDetailLoadOptions) {
    const result = await this.loadCardDetail(query, options);
    return result.data;
  }

  async getCardMarketHistory(query: CardDetailQuery & {
    condition?: string | null;
    days?: number;
    variant?: string | null;
  }) {
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, query);
    return detail?.marketHistory ?? null;
  }

  async getCardPriceTrends(query: CardPriceTrendsQuery): Promise<CardPriceTrendList | null> {
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, { cardId: query.cardId });
    if (!detail) {
      return null;
    }
    const mode: CardPriceTrendMode = query.mode === 'graded' ? 'graded' : 'raw';
    const provider: CardPriceTrendList['provider'] = mode === 'graded' ? 'ebay' : 'tcgplayer';
    const currencyCode = detail.currencyCode ?? 'USD';
    const seriesValue = detail.marketHistory?.points?.map((point) => point.value) ?? [];
    const rows: CardPriceTrendRow[] =
      mode === 'graded'
        ? []
        : (detail.marketHistory?.availableConditions ?? []).map((option) => ({
          label: option.label ?? option.id,
          key: option.id,
          currentPrice: option.currentPrice ?? detail.marketPrice ?? null,
          currencyCode,
          points: seriesValue,
          trendPct: null,
        }));
    return { mode, provider, rows };
  }

  async getCardConditionHistory(query: CardConditionHistoryQuery): Promise<CardConditionHistory | null> {
    const lane: CardConditionHistoryLane = query.lane === 'graded' ? 'graded' : 'raw';
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, { cardId: query.cardId });
    if (!detail) {
      return null;
    }
    const currencyCode = detail.currencyCode ?? 'USD';
    const history = detail.marketHistory;
    const points: CardConditionHistoryPoint[] = (history?.points ?? []).map((point) => ({
      date: point.isoDate,
      market: point.value ?? null,
      low: null,
      mid: null,
      high: null,
    }));
    // The mock only carries a raw market-history series; the graded lane has no
    // synthetic source, so it returns no series (drives the empty state).
    const series: CardConditionHistorySeries[] = lane === 'graded' || points.length === 0
      ? []
      : (history?.availableConditions ?? []).map((option) => ({
        key: `normal|${option.id}`,
        label: option.label ?? option.id,
        variantKey: 'normal',
        condition: option.id,
        grader: null,
        grade: null,
        points,
      }));
    return { cardId: query.cardId, lane, currencyCode, series };
  }

  async getRawPricingMatrix(cardId: string): Promise<RawPricingMatrix> {
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, { cardId });
    const history = detail?.marketHistory ?? null;
    if (!history || !history.availableConditions || history.availableConditions.length === 0) {
      return {
        cardID: cardId,
        currencyCode: detail?.currencyCode ?? 'USD',
        variants: [],
      };
    }
    const variantLabel = history.selectedVariant
      ?? history.availableVariants?.[0]?.label
      ?? 'Normal';
    const variantKey = history.availableVariants?.[0]?.id ?? variantLabel.toLowerCase().replace(/\s+/g, '');
    return {
      cardID: cardId,
      currencyCode: history.currencyCode ?? detail?.currencyCode ?? 'USD',
      variants: [
        {
          variant: variantLabel,
          variantKey,
          conditions: history.availableConditions.map((option) => ({
            code: option.id,
            label: option.label ?? option.id,
            low: null,
            mid: null,
            market: option.currentPrice ?? null,
            high: null,
          })),
        },
      ],
    };
  }

  async getCardEbayListings(query: CardDetailQuery & {
    limit?: number;
  }) {
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, query);
    return detail?.ebayListings ?? null;
  }

  async getCardRecentSales(query: CardRecentSalesQuery) {
    // Any grader+grade is supported (PSA / BGS / CGC); only require both to be present.
    if (!query.slabContext?.grader || !query.slabContext?.grade) {
      return null;
    }
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, query);
    if (!detail?.ebayListings) {
      return {
        source: 'ebay',
        status: 'unavailable',
        statusReason: 'not_loaded',
        unavailableReason: null,
        fetchedAt: null,
        canRefresh: false,
        saleCount: 0,
        sales: [],
      } satisfies CardRecentSalesRecord;
    }
    return {
      source: 'ebay',
      status: detail.ebayListings.status,
      statusReason: detail.ebayListings.statusReason,
      unavailableReason: detail.ebayListings.unavailableReason,
      fetchedAt: '2026-05-03T12:00:00.000Z',
      canRefresh: false,
      saleCount: detail.ebayListings.listingCount,
      sales: detail.ebayListings.listings.map((listing) => ({
        id: listing.id,
        title: listing.title,
        soldAt: listing.listingDate,
        priceAmount: listing.priceAmount,
        currencyCode: listing.currencyCode,
        saleUrl: listing.listingUrl,
      })),
    } satisfies CardRecentSalesRecord;
  }

  async setCardFavorite(cardId: string, isFavorite?: boolean | null) {
    const currentlyFavorite = this.favoriteCardTimestamps.has(cardId);
    const nextIsFavorite = isFavorite == null ? !currentlyFavorite : isFavorite;
    if (nextIsFavorite) {
      if (!currentlyFavorite) {
        this.favoriteCardTimestamps.set(cardId, new Date().toISOString());
      }
    } else {
      this.favoriteCardTimestamps.delete(cardId);
    }
    return {
      cardId,
      isFavorite: nextIsFavorite,
      favoritedAt: this.favoriteTimestampForCard(cardId),
    } satisfies CardFavoriteRecord;
  }

  async setCardLike(cardId: string, isLiked?: boolean | null) {
    const currentlyLiked = this.likeCardTimestamps.has(cardId);
    const nextIsLiked = isLiked == null ? !currentlyLiked : isLiked;
    if (nextIsLiked) {
      if (!currentlyLiked) {
        this.likeCardTimestamps.set(cardId, new Date().toISOString());
      }
    } else {
      this.likeCardTimestamps.delete(cardId);
    }
    return {
      cardId,
      isLiked: nextIsLiked,
      likedAt: this.likeCardTimestamps.get(cardId) ?? null,
    } satisfies CardLikeRecord;
  }

  async getCardFavorites(_query?: CardFavoritesQuery): Promise<CardFavoriteEntry[]> {
    const ownedEntryByCardId = new Map(
      this.inventoryEntries.map((entry) => [entry.cardId, entry] as const),
    );
    const entries: CardFavoriteEntry[] = [];
    const sortedFavorites = Array.from(this.favoriteCardTimestamps.entries())
      .sort(([, leftTs], [, rightTs]) => (leftTs < rightTs ? 1 : leftTs > rightTs ? -1 : 0));
    for (const [cardId, favoritedAt] of sortedFavorites) {
      const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, { cardId });
      if (!detail) {
        continue;
      }
      const ownedEntry = ownedEntryByCardId.get(cardId) ?? null;
      entries.push({
        cardId,
        name: detail.name,
        cardNumber: detail.cardNumber,
        setName: detail.setName,
        imageUrl: detail.imageUrl,
        smallImageUrl: detail.imageUrl,
        largeImageUrl: detail.largeImageUrl ?? null,
        marketPrice: detail.marketPrice ?? null,
        currencyCode: detail.currencyCode ?? 'USD',
        favoritedAt,
        isOwned: ownedEntry != null,
        kind: ownedEntry?.kind ?? null,
        variantName: ownedEntry?.variantName ?? null,
        conditionLabel: ownedEntry?.conditionLabel ?? null,
        conditionShortLabel: ownedEntry?.conditionShortLabel ?? null,
        slabContext: ownedEntry?.slabContext ?? null,
        dayChangeAmount: ownedEntry?.dayChangeAmount ?? null,
        dayChangePercent: ownedEntry?.dayChangePercent ?? null,
      });
    }
    return entries;
  }

  async getAddToCollectionOptions(cardId: string) {
    const detailResult = await this.loadCardDetail({ cardId });
    if (!detailResult.data) {
      throw new SpotlightRepositoryRequestError(
        'Card not found in the local catalog.',
        'not_found',
        404,
      );
    }

    return {
      variants: detailResult.data.variantOptions.map((variant) => ({
        id: variant.id,
        label: variant.label,
      })),
      defaultVariant: detailResult.data.variantOptions[0]?.id ?? 'normal',
      defaultPrice: detailResult.data.marketPrice ?? 0,
    };
  }

  async createPortfolioBuy(payload: PortfolioBuyRequestPayload) {
    const { updatedEntries, deckEntryID, inserted } = appendMockBuy(
      this.inventoryEntries,
      this.cardDetails,
      {
        cardID: payload.cardID,
        slabContext: payload.slabContext,
        variantName: payload.variantName ?? null,
        condition: payload.condition,
        quantity: payload.quantity,
        unitPrice: payload.unitPrice,
      },
    );
    this.inventoryEntries = updatedEntries;
    const matchingEntry = updatedEntries.find((entry) => entry.id === deckEntryID);
    if (matchingEntry) {
      this.recentSales = [buildMockRecentTrade(payload, matchingEntry), ...this.recentSales];
    }

    return {
      deckEntryID,
      cardID: payload.cardID,
      inserted,
      quantityAdded: payload.quantity,
      totalSpend: Number((payload.quantity * payload.unitPrice).toFixed(2)),
      boughtAt: payload.boughtAt,
    };
  }

  async createInventoryEntry(payload: InventoryEntryCreateRequestPayload) {
    const quantity = Math.max(1, payload.quantity ?? 1);
    const { updatedEntries, deckEntryID } = appendMockBuy(
      this.inventoryEntries,
      this.cardDetails,
      {
        cardID: payload.cardID,
        slabContext: payload.slabContext,
        variantName: payload.variantName ?? null,
        condition: payload.condition,
        quantity,
        unitPrice: null,
      },
    );
    this.inventoryEntries = updatedEntries;

    return {
      deckEntryID,
      cardID: payload.cardID,
      variantName: payload.variantName ?? null,
      condition: payload.condition,
      confirmationID: null,
      sourceScanID: payload.sourceScanID,
      addedAt: payload.addedAt,
    };
  }

  async replacePortfolioEntry(payload: PortfolioEntryReplaceRequestPayload) {
    const existingEntry = this.inventoryEntries.find((entry) => entry.id === payload.deckEntryID);
    if (!existingEntry) {
      throw new SpotlightRepositoryRequestError('Deck entry not found.', 'not_found', 404);
    }

    this.inventoryEntries = this.inventoryEntries.filter((entry) => entry.id !== payload.deckEntryID);

    const { updatedEntries, deckEntryID } = appendMockBuy(
      this.inventoryEntries,
      this.cardDetails,
      {
        cardID: payload.cardID,
        slabContext: payload.slabContext,
        variantName: payload.variantName ?? null,
        condition: payload.condition,
        quantity: payload.quantity,
        unitPrice: payload.unitPrice,
      },
    );

    this.inventoryEntries = updatedEntries;

    return {
      previousDeckEntryID: payload.deckEntryID,
      deckEntryID,
      cardID: payload.cardID,
      quantity: payload.quantity,
      unitPrice: payload.unitPrice ?? null,
      updatedAt: payload.updatedAt,
    };
  }

  async deletePortfolioEntry(payload: PortfolioEntryDeleteRequestPayload) {
    const existingEntry = this.inventoryEntries.find((entry) => entry.id === payload.deckEntryID);
    if (!existingEntry) {
      throw new SpotlightRepositoryRequestError('Deck entry not found.', 'not_found', 404);
    }
    this.inventoryEntries = this.inventoryEntries.filter((entry) => entry.id !== payload.deckEntryID);
    return {
      deckEntryID: existingEntry.id,
      cardID: existingEntry.cardId,
    };
  }

  async deletePortfolioEntriesBulk(payload: PortfolioEntryBulkDeleteRequestPayload) {
    const idsToDelete = new Set(payload.deckEntryIDs);
    const deletedDeckEntryIDs = this.inventoryEntries
      .filter((entry) => idsToDelete.has(entry.id))
      .map((entry) => entry.id);
    this.inventoryEntries = this.inventoryEntries.filter((entry) => !idsToDelete.has(entry.id));
    return {
      deletedDeckEntryIDs,
      deletedCount: deletedDeckEntryIDs.length,
    };
  }

  async deleteAccount(): Promise<AccountDeleteResponsePayload> {
    return { deleted: true };
  }

  async exportDeckEntriesCsv(): Promise<string> {
    return 'name,set,number,quantity\n';
  }

  async setPortfolioEntryQuantity(payload: SetPortfolioEntryQuantityRequestPayload) {
    return {
      deckEntryID: payload.deckEntryID,
      cardID: 'mock-card',
      quantity: payload.quantity,
      deleted: payload.quantity === 0,
    };
  }

  async updateDeckEntryCostBasis(payload: UpdateDeckEntryCostBasisRequestPayload) {
    return {
      deckEntryID: payload.deckEntryID,
      cardID: 'mock-card',
      costBasisPerUnit: payload.costBasisPerUnit,
      costBasisPerUnitCents:
        payload.costBasisPerUnit == null ? null : Math.round(payload.costBasisPerUnit * 100),
      currencyCode: 'USD',
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
  }

  async createPortfolioSale(payload: PortfolioSaleRequestPayload) {
    const { updatedEntries, saleResponse, recentSale } = updateInventoryForSale(
      this.inventoryEntries,
      payload,
    );
    this.inventoryEntries = updatedEntries;
    this.recentSales = [recentSale, ...this.recentSales];
    return saleResponse;
  }

  async createPortfolioSalesBatch(payloads: PortfolioSaleRequestPayload[]) {
    const responses: PortfolioSaleResponsePayload[] = [];
    for (const payload of payloads) {
      responses.push(await this.createPortfolioSale(payload));
    }
    return responses;
  }

  async createCardTransaction(payload: CreateCardTransactionPayload): Promise<CardTransactionRecord> {
    const record: CardTransactionRecord = {
      id: createPseudoUUID(),
      kind: payload.kind,
      amountCents: payload.amountCents,
      currencyCode: payload.currencyCode,
      occurredAt: payload.occurredAt,
      occurredAtLabel: null,
      note: payload.note,
      itemCount: payload.itemCount,
      photoUrl: payload.photo ? `data:image/jpeg;base64,${payload.photo.jpegBase64}` : null,
      imageUrl: payload.imageUrl ?? null,
      createdAt: new Date().toISOString(),
      paymentMethod: payload.paymentMethod ?? null,
    };
    this.cardTransactions = [record, ...this.cardTransactions];
    return record;
  }

  async listCardTransactions(): Promise<CardTransactionRecord[]> {
    return this.cardTransactions.map((transaction) => ({ ...transaction }));
  }

  async loadTransactionInsights(): Promise<TransactionInsights> {
    const emptyKinds = () => ({
      sold: { count: 0, amountCents: 0 },
      bought: { count: 0, amountCents: 0 },
      traded: { count: 0, amountCents: 0 },
    });
    const allTime = emptyKinds();
    const thisMonth = emptyKinds();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let biggestSale: CardTransactionRecord | null = null;
    const monthSold: CardTransactionRecord[] = [];

    for (const transaction of this.cardTransactions) {
      const kind = transaction.kind as 'sold' | 'bought' | 'traded';
      if (!(kind in allTime)) {
        continue;
      }
      const count = transaction.itemCount ?? 1;
      const amount = transaction.amountCents ?? 0;
      allTime[kind].count += count;
      allTime[kind].amountCents += amount;
      const occurred = transaction.occurredAt ? new Date(transaction.occurredAt) : null;
      const inMonth = occurred != null && occurred >= monthStart;
      if (inMonth) {
        thisMonth[kind].count += count;
        thisMonth[kind].amountCents += amount;
      }
      if (kind === 'sold' && transaction.amountCents != null) {
        if (!biggestSale || (transaction.amountCents ?? 0) > (biggestSale.amountCents ?? 0)) {
          biggestSale = transaction;
        }
        if (inMonth) {
          monthSold.push(transaction);
        }
      }
    }
    monthSold.sort((left, right) => (right.amountCents ?? 0) - (left.amountCents ?? 0));

    const sampleImage = 'https://images.pokemontcg.io/sm1/1.png';
    const biggestPurchase: CardTransactionRecord = {
      id: 'txn-mock-bought',
      kind: 'bought',
      amountCents: 8800,
      currencyCode: 'USD',
      occurredAt: '2026-06-08T18:00:00.000Z',
      occurredAtLabel: 'Bought on Jun 8, 2026',
      note: 'Booth pickup at the June show',
      itemCount: 1,
      photoUrl: sampleImage,
      imageUrl: sampleImage,
      createdAt: '2026-06-08T18:01:00.000Z',
      paymentMethod: 'cash',
    };
    const topGrowth: InsightGrowthCard[] = [
      {
        cardId: 'sm1-1',
        name: 'Ludicolo',
        setName: 'Sun & Moon',
        cardNumber: '1/149',
        imageUrl: 'https://images.pokemontcg.io/sm1/1.png',
        currencyCode: 'USD',
        changeAmountCents: 399,
        changePct: 3.2,
      },
      {
        cardId: 'sm1-2',
        name: 'Dartrix',
        setName: 'Sun & Moon',
        cardNumber: '9/149',
        imageUrl: 'https://images.pokemontcg.io/sm1/9.png',
        currencyCode: 'USD',
        changeAmountCents: 250,
        changePct: 1.8,
      },
      {
        cardId: 'swsh1-25',
        name: 'Zacian V',
        setName: 'Sword & Shield',
        cardNumber: '138/202',
        imageUrl: 'https://images.pokemontcg.io/swsh1/138.png',
        currencyCode: 'USD',
        changeAmountCents: 1200,
        changePct: 5.6,
      },
    ];

    return {
      currencyCode: 'USD',
      thisMonth,
      allTime,
      biggestSale: biggestSale ? { ...biggestSale } : null,
      topSalesThisMonth: monthSold.slice(0, 10).map((sale) => ({ ...sale })),
      totalPortfolioValueCents: 180000,
      scannedCount: 2876,
      wishlistedCount: 40,
      biggestPurchase,
      topGrowth,
    };
  }

  async markSalePaid(saleID: string): Promise<SaleLifecycleResponsePayload> {
    return {
      saleID,
      paidAt: new Date().toISOString(),
      voidedAt: null,
      status: 'paid',
      remainingQuantity: 0,
    };
  }

  async voidSale(saleID: string): Promise<SaleLifecycleResponsePayload> {
    return {
      saleID,
      paidAt: null,
      voidedAt: new Date().toISOString(),
      status: 'voided',
    };
  }

  async getVendorWalletHandles(): Promise<VendorWalletHandles> {
    return {
      venmoHandle: null,
      cashappHandle: null,
      paypalMeSlug: null,
      zelleEmailOrPhone: null,
      updatedAt: null,
    };
  }

  async updateVendorWalletHandles(payload: VendorWalletHandlesUpdate): Promise<VendorWalletHandles> {
    return {
      venmoHandle: payload.venmoHandle ?? null,
      cashappHandle: payload.cashappHandle ?? null,
      paypalMeSlug: payload.paypalMeSlug ?? null,
      zelleEmailOrPhone: payload.zelleEmailOrPhone ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  async previewPortfolioImport(payload: PortfolioImportPreviewRequestPayload) {
    const primaryCandidate = this.catalogResults[0];
    const secondaryCandidate = this.catalogResults[1];
    const tertiaryCandidate = this.catalogResults[2];

    if (!primaryCandidate || !secondaryCandidate || !tertiaryCandidate) {
      throw new SpotlightRepositoryRequestError(
        'Mock portfolio import catalog is unavailable.',
        'request_failed',
      );
    }

    const rows: PortfolioImportRowRecord[] = [
      {
        id: 'mock-import-row-1',
        rowIndex: 1,
        sourceCollectionName: payload.sourceType === 'collectr_csv_v1' ? 'Collectr Binder' : 'TCGplayer Store',
        sourceCardName: primaryCandidate.name,
        setName: primaryCandidate.setName,
        collectorNumber: primaryCandidate.cardNumber,
        quantity: 2,
        conditionLabel: 'Near Mint',
        currencyCode: primaryCandidate.currencyCode ?? 'USD',
        acquisitionUnitPrice: primaryCandidate.marketPrice ?? 0.31,
        marketUnitPrice: primaryCandidate.marketPrice ?? 0.31,
        matchState: 'ready',
        matchStrategy: 'exact_title_number',
        matchedCard: primaryCandidate,
        candidateCards: [primaryCandidate],
        warnings: [],
        rawSummary: null,
      },
      {
        id: 'mock-import-row-2',
        rowIndex: 2,
        sourceCollectionName: payload.sourceType === 'collectr_csv_v1' ? 'Collectr Binder' : 'TCGplayer Store',
        sourceCardName: 'Celebi Promo',
        setName: secondaryCandidate.setName,
        collectorNumber: secondaryCandidate.cardNumber,
        quantity: 1,
        conditionLabel: 'Near Mint',
        currencyCode: secondaryCandidate.currencyCode ?? 'USD',
        acquisitionUnitPrice: secondaryCandidate.marketPrice ?? 18,
        marketUnitPrice: secondaryCandidate.marketPrice ?? 18,
        matchState: 'review',
        matchStrategy: 'ambiguous_name',
        matchedCard: null,
        candidateCards: [secondaryCandidate, tertiaryCandidate],
        warnings: ['Multiple cards look similar. Pick the right one before importing.'],
        rawSummary: null,
      },
    ];

    const job: PortfolioImportJobRecord = {
      id: `mock-import-${this.portfolioImportJobs.size + 1}`,
      sourceType: payload.sourceType,
      status: rows.some((row) => row.matchState === 'review' || row.matchState === 'unresolved')
        ? 'needs_review'
        : 'ready',
      sourceFileName: payload.fileName,
      summary: buildPortfolioImportSummaryFromRows(rows),
      rows,
      warnings: [],
      errorText: null,
    };

    this.portfolioImportJobs.set(job.id, clonePortfolioImportJob(job));
    return clonePortfolioImportJob(job);
  }

  async fetchPortfolioImportJob(jobID: string) {
    const job = this.portfolioImportJobs.get(jobID);
    if (!job) {
      throw new SpotlightRepositoryRequestError('Import job not found.', 'not_found', 404);
    }

    return clonePortfolioImportJob(job);
  }

  async resolvePortfolioImportRow(jobID: string, payload: PortfolioImportResolveRequestPayload) {
    const existing = this.portfolioImportJobs.get(jobID);
    if (!existing) {
      throw new SpotlightRepositoryRequestError('Import job not found.', 'not_found', 404);
    }

    const nextJob = clonePortfolioImportJob(existing);
    nextJob.rows = nextJob.rows.map((row) => {
      if (row.id !== payload.rowID) {
        return row;
      }

      if (payload.action === 'skip') {
        return {
          ...row,
          matchState: 'skipped',
          matchedCard: null,
        };
      }

      const matchedCard = [
        row.matchedCard,
        ...row.candidateCards,
        ...this.catalogResults,
      ].find((candidate) => candidate?.cardId === payload.matchedCardID) ?? null;

      return {
        ...row,
        matchState: matchedCard ? 'ready' : row.matchState,
        matchedCard,
        warnings: matchedCard ? [] : row.warnings,
      };
    });
    nextJob.summary = buildPortfolioImportSummaryFromRows(nextJob.rows);
    nextJob.status = nextJob.summary.readyToCommitCount > 0 && nextJob.summary.reviewCount === 0 && nextJob.summary.unresolvedCount === 0
      ? 'ready'
      : nextJob.summary.reviewCount > 0 || nextJob.summary.unresolvedCount > 0
        ? 'needs_review'
        : nextJob.summary.committedCount > 0
          ? 'completed'
          : existing.status;

    this.portfolioImportJobs.set(jobID, clonePortfolioImportJob(nextJob));
    return nextJob;
  }

  async commitPortfolioImportJob(jobID: string) {
    const existing = this.portfolioImportJobs.get(jobID);
    if (!existing) {
      throw new SpotlightRepositoryRequestError('Import job not found.', 'not_found', 404);
    }

    const nextJob = clonePortfolioImportJob(existing);
    let committedCount = 0;

    for (const row of nextJob.rows) {
      if ((row.matchState === 'ready' || row.matchState === 'matched') && row.matchedCard) {
        committedCount += 1;
        const { updatedEntries } = appendMockBuy(
          this.inventoryEntries,
          this.cardDetails,
          {
            cardID: row.matchedCard.cardId,
            condition: conditionCodeFromLabel(row.conditionLabel),
            quantity: Math.max(1, row.quantity),
            unitPrice: row.acquisitionUnitPrice ?? row.marketUnitPrice ?? row.matchedCard.marketPrice ?? 0,
          },
        );
        this.inventoryEntries = updatedEntries;
        row.matchState = 'committed';
      }
    }

    nextJob.summary = buildPortfolioImportSummaryFromRows(nextJob.rows);
    nextJob.status = committedCount > 0 ? 'completed' : nextJob.status;
    this.portfolioImportJobs.set(jobID, clonePortfolioImportJob(nextJob));

    return {
      jobID,
      status: nextJob.status,
      summary: nextJob.summary,
      job: clonePortfolioImportJob(nextJob),
      message: committedCount > 0 ? `Imported ${committedCount} row${committedCount === 1 ? '' : 's'}.` : null,
    };
  }

  async listExpansions(_game?: string): Promise<ExpansionRecord[]> {
    return [];
  }

  async listCardsInExpansion(_expansionId: string, query?: string, _limit?: number): Promise<CatalogSearchResult[]> {
    if (!query?.trim()) {
      return [];
    }
    return this.searchCatalogCards(query);
  }

  async getAccessStatus(): Promise<AccessStatus> {
    return {
      accessOpen: this.accessShowModeActive,
      allowed: true,
      isAdmin: false,
      showMode: {
        active: this.accessShowModeActive,
        until: null,
        remainingSeconds: 0,
      },
    };
  }

  async redeemInviteCode(code: string): Promise<AccessRedeemResult> {
    const redeemed = code.trim() === 'ekalight_special_guest';
    return { redeemed, allowed: redeemed };
  }

  async joinAccessWaitlist(_email: string): Promise<AccessWaitlistResult> {
    return { ok: true };
  }

  async setCardShowMode(active: boolean, _hours?: number): Promise<CardShowModeResult> {
    this.accessShowModeActive = active;
    return { accessOpen: active };
  }

  async getAccessWhitelist(): Promise<AccessWhitelist> {
    return { emails: [...this.accessWhitelist] };
  }

  async addAccessWhitelistEmail(email: string): Promise<AccessWhitelist> {
    const normalized = email.trim().toLowerCase();
    if (normalized && !this.accessWhitelist.includes(normalized)) {
      this.accessWhitelist = [...this.accessWhitelist, normalized].sort();
    }
    return { emails: [...this.accessWhitelist] };
  }

  async removeAccessWhitelistEmail(email: string): Promise<AccessWhitelist> {
    const normalized = email.trim().toLowerCase();
    this.accessWhitelist = this.accessWhitelist.filter((value) => value !== normalized);
    return { emails: [...this.accessWhitelist] };
  }
}

export class HttpSpotlightRepository implements SpotlightRepository {
  private readonly baseUrls: string[];
  private readonly getAccessToken: (() => string | null | Promise<string | null>) | null;
  private readonly clientContext: RepositoryClientContext | null;

  private activeBaseUrl: string;

  constructor(
    baseUrl: string | string[],
    options?: {
      getAccessToken?: (() => string | null | Promise<string | null>) | null;
      clientContext?: RepositoryClientContext | null;
    },
  ) {
    const candidates = (Array.isArray(baseUrl) ? baseUrl : [baseUrl])
      .map((candidate) => candidate.trim().replace(/\/+$/, ''))
      .filter((candidate, index, collection) => {
        return candidate.length > 0 && collection.indexOf(candidate) === index;
      });

    this.baseUrls = candidates.length > 0 ? candidates : ['http://127.0.0.1:8788'];
    this.activeBaseUrl = this.baseUrls[0];
    this.getAccessToken = options?.getAccessToken ?? null;
    this.clientContext = options?.clientContext ?? null;
  }

  private get baseUrl() {
    return this.activeBaseUrl;
  }

  private logRequestTransport(
    label: string,
    payload: Record<string, string | number | null | undefined>,
  ) {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    const details = Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value ?? 'n/a'}`)
      .join(' ');
    console.info(`[SPOTLIGHT API] ${label}${details ? ` ${details}` : ''}`);
  }

  private async requestInitWithAuth(init?: RequestInit) {
    if (!this.getAccessToken) {
      return init;
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return init;
    }

    const headers = new Headers(init?.headers ?? undefined);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return {
      ...init,
      headers,
    } satisfies RequestInit;
  }

  private async searchCatalogCardsForScanner(query: string, limit = 12) {
    const normalized = query.trim();
    if (normalized.length < 2) {
      return [];
    }

    const queryParams = new URLSearchParams({
      q: normalized,
      limit: String(Math.max(1, Math.min(limit, 100))),
    });
    const searchResponse = await this.requestJson<SearchResultsDTO>(
      `${this.baseUrl}/api/v1/cards/search?${queryParams.toString()}`,
    );

    if (searchResponse.kind !== 'success') {
      return [];
    }

    const rawResults = Array.isArray(searchResponse.data?.results) ? searchResponse.data.results : [];
    return rawResults
      .flatMap((result: CardCandidateDTO) => {
        const card = normalizeCardCandidate(result, this.baseUrl);
        if (!card) {
          return [];
        }

        return [{
          id: card.id,
          cardId: card.id,
          name: card.name,
          cardNumber: withCardNumberPrefix(card.number),
          setName: card.setName,
          subtitle: null,
          imageUrl: pickImageUrl([card.imageLargeURL, card.imageSmallURL], this.baseUrl),
          smallImageUrl: pickImageUrl([card.imageSmallURL], this.baseUrl) || null,
          largeImageUrl: pickImageUrl([card.imageLargeURL], this.baseUrl) || null,
          marketPrice: card.pricing.market,
          currencyCode: card.pricing.currencyCode,
          ownedQuantity: 0,
          isFavorite: card.isFavorite,
          rarityBucket: card.rarityBucket,
        }];
      });
  }

  private async resolveScannerCandidate(candidate: CatalogSearchResult) {
    const queries = buildScannerCandidateQueries(candidate);

    for (const query of queries) {
      const results = await this.searchCatalogCardsForScanner(query);
      const resolvedCandidate = pickBestScannerCandidateMatch(candidate, results);
      if (resolvedCandidate) {
        return resolvedCandidate;
      }
    }

    return candidate;
  }

  async loadPortfolioDashboard(options?: { range?: keyof PortfolioDashboard['ranges'] }) {
    // Prefer the single consolidated endpoint (one request instead of ~14).
    // Falls back to the legacy per-section fan-out when the backend doesn't yet
    // expose the endpoint (404) or the consolidated call fails, so OTA clients
    // and backend deploys don't have to be in lockstep.
    const range = options?.range ?? '1W';
    const consolidated = await this.loadPortfolioDashboardViaConsolidatedEndpoint(range);
    if (consolidated) {
      return consolidated;
    }
    return this.loadPortfolioDashboardViaFanout();
  }

  // Fetch a single chart range on demand (the dashboard now computes only the
  // open range; the chart fetches the rest when the user switches to them).
  async getPortfolioRange(
    range: keyof PortfolioDashboard['ranges'],
  ): Promise<PortfolioDashboard['ranges'][keyof PortfolioDashboard['ranges']]> {
    const [historyResult, ledgerResult] = await Promise.all([
      this.loadPortfolioHistory(range),
      this.loadPortfolioLedger(mapRangeToBackend(range)),
    ]);
    return {
      portfolio: mapPortfolioSeries(historyResult.data ?? buildEmptyPortfolioHistory()),
      sales: buildSalesSeries(ledgerResult.data ?? buildEmptyPortfolioLedger(), range),
    };
  }

  private async loadPortfolioDashboardViaConsolidatedEndpoint(
    range: keyof PortfolioDashboard['ranges'],
  ): Promise<SpotlightRepositoryLoadResult<PortfolioDashboard> | null> {
    const queryParams = new URLSearchParams({ timeZone: 'America/Los_Angeles', range });
    const url = `${this.baseUrl}/api/v1/portfolio/dashboard?${queryParams.toString()}`;

    // Retry transport/timeout failures with a short backoff: a cold-cache first
    // call can exceed the timeout, but it warms the backend's page cache, so the
    // retry usually returns fast. A 'not_found' (404) breaks out immediately so
    // the caller falls through to the per-section fan-out instead of retrying.
    let response = await this.requestJson<PortfolioDashboardDTO>(
      url,
      undefined,
      { allowNotFound: true, timeoutMs: dashboardRequestTimeoutMs },
    );
    for (
      let attempt = 2;
      attempt <= dashboardRetryAttempts && response.kind === 'error';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, dashboardRetryBackoffMs));
      response = await this.requestJson<PortfolioDashboardDTO>(
        url,
        undefined,
        { allowNotFound: true, timeoutMs: dashboardRequestTimeoutMs },
      );
    }

    // 404 (endpoint not deployed) or any transport/parse error → return null so
    // the caller falls back to the per-section fan-out.
    if (response.kind !== 'success' || !response.data) {
      return null;
    }

    const dto = response.data;
    const sections = dto.sections ?? {};
    const sectionOk = (label: string) => sections[label] === 'ok';

    const historyResultFor = (
      key: keyof PortfolioDashboard['ranges'],
    ): SpotlightRepositoryLoadResult<PortfolioHistoryDTO> => {
      const raw = dto.ranges?.[key]?.history ?? null;
      if (!sectionOk(`history.${key}`) || !raw) {
        return buildLoadResult(
          'error',
          buildEmptyPortfolioHistory(),
          sections[`history.${key}`] ?? 'Portfolio history unavailable.',
        );
      }
      const history = normalizePortfolioHistory(raw);
      return buildLoadResult(history.points.length > 0 ? 'success' : 'empty', history);
    };

    const ledgerResultFor = (
      key: keyof PortfolioDashboard['ranges'],
    ): SpotlightRepositoryLoadResult<PortfolioLedgerDTO> => {
      const raw = dto.ranges?.[key]?.ledger ?? null;
      if (!sectionOk(`ledger.${key}`) || !raw) {
        return buildLoadResult(
          'error',
          buildEmptyPortfolioLedger(),
          sections[`ledger.${key}`] ?? 'Portfolio ledger unavailable.',
        );
      }
      const ledger = normalizePortfolioLedger(raw);
      return buildLoadResult(
        ledger.transactions.length > 0 || (ledger.dailySeries?.length ?? 0) > 0 ? 'success' : 'empty',
        ledger,
      );
    };

    const rawEntries = Array.isArray(dto.inventory?.entries) ? dto.inventory.entries : [];
    const entries = rawEntries
      .map((entry) => mapDeckEntry(entry, this.baseUrl))
      .filter((entry): entry is InventoryCardEntry => entry !== null);
    const inventoryResult: SpotlightRepositoryLoadResult<InventoryCardEntry[]> = sectionOk('inventory')
      ? buildLoadResult(entries.length > 0 ? 'success' : 'empty', entries)
      : buildLoadResult('error', [], sections.inventory ?? 'Inventory unavailable.');

    const rawInsights = dto.insights ?? null;
    const insights: PortfolioInsights | null = rawInsights
      ? {
          ...rawInsights,
          bestReturnOfAllTime: rawInsights.bestReturnOfAllTime
            ? (buildRecentSales([rawInsights.bestReturnOfAllTime], this.baseUrl)[0] ?? null)
            : null,
          topSellersThisMonth: buildRecentSales(rawInsights.topSellersThisMonth ?? [], this.baseUrl),
        }
      : null;

    return this.assemblePortfolioDashboard({
      inventoryResult,
      history1w: historyResultFor('1W'),
      history1m: historyResultFor('1M'),
      history3m: historyResultFor('3M'),
      historyYtd: historyResultFor('YTD'),
      history1y: historyResultFor('1Y'),
      historyAll: historyResultFor('ALL'),
      ledger1w: ledgerResultFor('1W'),
      ledger30d: ledgerResultFor('1M'),
      ledger90d: ledgerResultFor('3M'),
      ledgerYtd: ledgerResultFor('YTD'),
      ledger1y: ledgerResultFor('1Y'),
      ledgerAll: ledgerResultFor('ALL'),
      insights,
      criticalRange: range,
    });
  }

  private async loadPortfolioDashboardViaFanout() {
    const [
      inventoryResult,
      history1w,
      history1m,
      history3m,
      historyYtd,
      history1y,
      historyAll,
      ledger1w,
      ledger30d,
      ledger90d,
      ledgerYtd,
      ledger1y,
      ledgerAll,
      insights,
    ] = await Promise.all([
      this.loadInventoryEntries(),
      this.loadPortfolioHistory('1W'),
      this.loadPortfolioHistory('1M'),
      this.loadPortfolioHistory('3M'),
      this.loadPortfolioHistory('YTD'),
      this.loadPortfolioHistory('1Y'),
      this.loadPortfolioHistory('ALL'),
      this.loadPortfolioLedger('1W'),
      this.loadPortfolioLedger('30D'),
      this.loadPortfolioLedger('90D'),
      this.loadPortfolioLedger('YTD'),
      this.loadPortfolioLedger('1Y'),
      this.loadPortfolioLedger('ALL'),
      this.loadPortfolioInsights(),
    ]);

    return this.assemblePortfolioDashboard({
      inventoryResult,
      history1w,
      history1m,
      history3m,
      historyYtd,
      history1y,
      historyAll,
      ledger1w,
      ledger30d,
      ledger90d,
      ledgerYtd,
      ledger1y,
      ledgerAll,
      insights,
    });
  }

  private assemblePortfolioDashboard(parts: {
    inventoryResult: SpotlightRepositoryLoadResult<InventoryCardEntry[]>;
    history1w: SpotlightRepositoryLoadResult<PortfolioHistoryDTO>;
    history1m: SpotlightRepositoryLoadResult<PortfolioHistoryDTO>;
    history3m: SpotlightRepositoryLoadResult<PortfolioHistoryDTO>;
    historyYtd: SpotlightRepositoryLoadResult<PortfolioHistoryDTO>;
    history1y: SpotlightRepositoryLoadResult<PortfolioHistoryDTO>;
    historyAll: SpotlightRepositoryLoadResult<PortfolioHistoryDTO>;
    ledger1w: SpotlightRepositoryLoadResult<PortfolioLedgerDTO>;
    ledger30d: SpotlightRepositoryLoadResult<PortfolioLedgerDTO>;
    ledger90d: SpotlightRepositoryLoadResult<PortfolioLedgerDTO>;
    ledgerYtd: SpotlightRepositoryLoadResult<PortfolioLedgerDTO>;
    ledger1y: SpotlightRepositoryLoadResult<PortfolioLedgerDTO>;
    ledgerAll: SpotlightRepositoryLoadResult<PortfolioLedgerDTO>;
    insights: PortfolioInsights | null;
    /** The open range the dashboard was scoped to — it (not always 1W) is the
     *  must-have history slice for the partial-tolerance check below. */
    criticalRange?: keyof PortfolioDashboard['ranges'];
  }): SpotlightRepositoryLoadResult<PortfolioDashboard> {
    const {
      inventoryResult,
      history1w,
      history1m,
      history3m,
      historyYtd,
      history1y,
      historyAll,
      ledger1w,
      ledger30d,
      ledger90d,
      ledgerYtd,
      ledger1y,
      ledgerAll,
      insights,
      criticalRange = '1W',
    } = parts;

    const safeInventoryEntries = inventoryResult.data ?? [];
    const safeHistory1w = history1w.data ?? buildEmptyPortfolioHistory();
    const safeHistory1m = history1m.data ?? buildEmptyPortfolioHistory();
    const safeHistory3m = history3m.data ?? buildEmptyPortfolioHistory();
    const safeHistoryYtd = historyYtd.data ?? buildEmptyPortfolioHistory();
    const safeHistory1y = history1y.data ?? buildEmptyPortfolioHistory();
    const safeHistoryAll = historyAll.data ?? buildEmptyPortfolioHistory();
    const safeLedger1w = ledger1w.data ?? buildEmptyPortfolioLedger();
    const safeLedger30d = ledger30d.data ?? buildEmptyPortfolioLedger();
    const safeLedger90d = ledger90d.data ?? buildEmptyPortfolioLedger();
    const safeLedgerYtd = ledgerYtd.data ?? buildEmptyPortfolioLedger();
    const safeLedger1y = ledger1y.data ?? buildEmptyPortfolioLedger();
    const safeLedgerAll = ledgerAll.data ?? buildEmptyPortfolioLedger();

    const dashboard: PortfolioDashboard = {
      summary: {
        currentValue: safeHistory1w.summary.currentValue,
        changeAmount: safeHistory1w.summary.deltaValue,
        changePercent: safeHistory1w.summary.deltaPercent ?? 0,
        asOfLabel: safeHistory1w.points.length > 0
          ? formatShortDate(safeHistory1w.points[safeHistory1w.points.length - 1]?.date ?? '')
          : 'Today',
      },
      inventoryCount: safeInventoryEntries.length,
      inventoryItems: safeInventoryEntries,
      recentSales: buildRecentSales(safeLedgerAll.transactions, this.baseUrl),
      ranges: {
        '1W': {
          portfolio: mapPortfolioSeries(safeHistory1w),
          sales: buildSalesSeries(safeLedger1w, '1W'),
        },
        '1M': {
          portfolio: mapPortfolioSeries(safeHistory1m),
          sales: buildSalesSeries(safeLedger30d, '1M'),
        },
        '3M': {
          portfolio: mapPortfolioSeries(safeHistory3m),
          sales: buildSalesSeries(safeLedger90d, '3M'),
        },
        YTD: {
          portfolio: mapPortfolioSeries(safeHistoryYtd),
          sales: buildSalesSeries(safeLedgerYtd, 'YTD'),
        },
        '1Y': {
          portfolio: mapPortfolioSeries(safeHistory1y),
          sales: buildSalesSeries(safeLedger1y, '1Y'),
        },
        ALL: {
          portfolio: mapPortfolioSeries(safeHistoryAll),
          sales: buildSalesSeries(safeLedgerAll, 'ALL'),
        },
      },
      insights: insights ?? null,
    };

    // Partial tolerance: only the inventory list and the 1W history are
    // "must-have" — they drive the card list and the headline value/chart. The
    // longer history ranges and the per-range ledgers are secondary (only shown
    // when the user switches ranges), and they are the slowest endpoints, so a
    // single one timing out must NOT blank the whole screen. If a critical slice
    // fails we keep returning 'error' so the hook holds the last good dashboard
    // (showing the real value, not a spurious $0) and flags "couldn't refresh".
    const historyByRange = {
      '1W': history1w,
      '1M': history1m,
      '3M': history3m,
      YTD: historyYtd,
      '1Y': history1y,
      ALL: historyAll,
    } as const;
    const criticalErrorMessage = [inventoryResult, historyByRange[criticalRange]].find(
      (result) => result.state === 'error',
    )?.errorMessage ?? null;

    if (criticalErrorMessage) {
      return buildLoadResult('error', dashboard, criticalErrorMessage);
    }

    return buildLoadResult(
      isEmptyPortfolioDashboard(dashboard) ? 'empty' : 'success',
      dashboard,
    );
  }

  async getPortfolioDashboard() {
    const result = await this.loadPortfolioDashboard();
    return result.data ?? buildEmptyPortfolioDashboard();
  }

  async loadInventoryEntries(query?: InventoryEntriesQuery) {
    const queryParams = buildInventoryEntriesQueryParams(query);
    const response = await this.requestJsonRead<{ entries?: DeckEntryDTO[] } | DeckEntryDTO[]>(
      `${this.baseUrl}/api/v1/deck/entries${queryParams.toString() ? `?${queryParams.toString()}` : ''}`,
    );

    if (response.kind !== 'success') {
      return buildLoadResult('error', [], response.error.message);
    }

    const inventoryJson = response.data;
    const rawEntries = Array.isArray(inventoryJson)
      ? inventoryJson
      : Array.isArray(inventoryJson?.entries)
        ? inventoryJson.entries
        : [];

    const entries = rawEntries
      .map((entry: DeckEntryDTO) => mapDeckEntry(entry, this.baseUrl))
      .filter((entry): entry is InventoryCardEntry => entry !== null);

    return buildLoadResult(entries.length > 0 ? 'success' : 'empty', entries);
  }

  async getInventoryEntries(query?: InventoryEntriesQuery) {
    const result = await this.loadInventoryEntries(query);
    return result.data ?? [];
  }

  async loadCatalogCards(query: string, limit = 20, offset = 0, options?: CatalogSearchOptions): Promise<CatalogSearchLoadResult> {
    const normalized = query.trim();
    const rarityBucket = options?.rarityBucket;
    // A rarity chip alone is a valid search (browse-by-rarity with no text);
    // text-only searches keep the existing 2-character minimum.
    if (normalized.length < 2 && !rarityBucket) {
      return { ...buildLoadResult('empty', []), hasMore: false };
    }

    const queryParams = new URLSearchParams({
      limit: String(Math.max(1, Math.min(limit, 100))),
      offset: String(Math.max(0, offset)),
    });
    if (normalized.length > 0) {
      queryParams.set('q', normalized);
    }
    if (rarityBucket) {
      queryParams.set('rarityBucket', rarityBucket);
    }
    const [searchResponse, inventoryResult] = await Promise.all([
      this.requestJson<SearchResultsDTO>(`${this.baseUrl}/api/v1/cards/search?${queryParams.toString()}`),
      this.loadInventoryEntries(),
    ]);

    if (searchResponse.kind !== 'success') {
      return { ...buildLoadResult('error', [], searchResponse.error.message), hasMore: false };
    }

    const hasMore = Boolean(searchResponse.data?.hasMore);

    const inventoryEntries = inventoryResult.data ?? [];
    const rawResults = Array.isArray(searchResponse.data?.results) ? searchResponse.data.results : [];
    const results: CatalogSearchResult[] = rawResults
      .flatMap((result: CardCandidateDTO) => {
        const card = normalizeCardCandidate(result, this.baseUrl);
        if (!card) {
          return [];
        }

        return [{
          id: card.id,
          cardId: card.id,
          name: card.name,
          cardNumber: withCardNumberPrefix(card.number),
          setName: card.setName,
          subtitle: null,
          imageUrl: pickImageUrl([card.imageLargeURL, card.imageSmallURL], this.baseUrl),
          smallImageUrl: pickImageUrl([card.imageSmallURL], this.baseUrl) || null,
          largeImageUrl: pickImageUrl([card.imageLargeURL], this.baseUrl) || null,
          marketPrice: card.pricing.market,
          currencyCode: card.pricing.currencyCode,
          ownedQuantity: inventoryEntries
            .filter((entry: InventoryCardEntry) => entry.cardId === card.id)
            .reduce((sum: number, entry: InventoryCardEntry) => sum + entry.quantity, 0),
          isFavorite: card.isFavorite,
          rarityBucket: card.rarityBucket,
        }];
      });

    return { ...buildLoadResult(results.length > 0 ? 'success' : 'empty', results), hasMore };
  }

  async searchCatalogCards(query: string, limit = 20) {
    const result = await this.loadCatalogCards(query, limit);
    if (result.state === 'error') {
      throw new SpotlightRepositoryRequestError(
        result.errorMessage ?? 'Search unavailable right now.',
        'request_failed',
      );
    }

    return result.data ?? [];
  }

  async searchCatalogCardsPage(query: string, limit = 20, offset = 0, options?: CatalogSearchOptions): Promise<CatalogSearchPage> {
    const result = await this.loadCatalogCards(query, limit, offset, options);
    if (result.state === 'error') {
      throw new SpotlightRepositoryRequestError(
        result.errorMessage ?? 'Search unavailable right now.',
        'request_failed',
      );
    }

    return { cards: result.data ?? [], hasMore: result.hasMore };
  }

  async matchScannerCapture(payload: ScannerCapturePayload, options?: ScannerMatchOptions) {
    const endpointPath = scannerMatchEndpointPath(payload);
    const startedAt = Date.now();
    // Generate the scanID up-front so the same id keys both the match and the artifact
    // upload (the backend upserts by it). See the per-mode upload timing below.
    const scanID = createPseudoUUID();
    const isRawMatch = payload.mode === 'raw';

    // Build the payload JSON once and reuse it across retry attempts. It rides
    // as the multipart `payload` part (default) or — with image.jpegBase64
    // added — as the JSON fallback body.
    const baseMatchPayload = createScannerMatchPayload(payload, scanID, this.clientContext ?? undefined);
    const matchImageMeta = baseMatchPayload.image as { height: number; width: number };
    const normalizedFileUri = normalizeString(payload.fileUri)
      ?? scannerImageFileUri(payload.normalizedImage);
    // Only the raw lane's /scan/visual-match speaks multipart (the slab lane's
    // /scan/match is not part of the multipart contract), and only when the
    // capture has a normalized file on disk to stream.
    let useMultipart = isRawMatch && !!normalizedFileUri && canAttemptScanMultipart();

    const matchRequestOptions: JsonRequestOptions = {
      candidateStrategy: 'single_active',
      logTransport: true,
      requestLabel: endpointPath,
      // Raw matches return in <1s; use a short per-attempt timeout so a stalled
      // upload gives up fast and a retry can land. Slabs keep the single long timeout
      // (their matches legitimately take 40-50s).
      timeoutMs: isRawMatch ? rawMatchPerAttemptTimeoutMs : scanMatchRequestTimeoutMs,
    };

    // JSON+base64 fallback body, built LAZILY (and cached across retries) so
    // the default multipart path never materializes base64 on the JS thread at
    // all; the read only happens when the fallback is actually taken.
    let jsonMatchBodyPromise: Promise<string | null> | null = null;
    const resolveJsonMatchBody = () => {
      jsonMatchBodyPromise ??= (async () => {
        const inline = normalizeString(payload.jpegBase64);
        const jpegBase64 = inline
          ?? (normalizedFileUri && payload.readFileAsBase64
            ? normalizeString(await payload.readFileAsBase64(normalizedFileUri).catch(() => null))
            : null);
        if (!jpegBase64) {
          return null;
        }
        return JSON.stringify({
          ...baseMatchPayload,
          image: { jpegBase64, ...matchImageMeta },
        });
      })();
      return jsonMatchBodyPromise;
    };

    const runMatchRequest = async (): Promise<JsonRequestResult<ScanMatchResponseDTO>> => {
      if (useMultipart && normalizedFileUri) {
        const form = new FormData();
        form.append('payload', JSON.stringify(baseMatchPayload));
        appendMultipartJpegPart(form, 'normalized_image', normalizedFileUri, 'normalized.jpg');
        const multipartResponse = await this.requestJson<ScanMatchResponseDTO>(
          `${this.baseUrl}/${endpointPath}`,
          {
            body: form,
            // CRITICAL: no Content-Type header here — fetch must generate the
            // multipart boundary itself.
            method: 'POST',
          },
          matchRequestOptions,
        );
        if (multipartResponse.kind !== 'error') {
          return multipartResponse;
        }
        // Older backend without multipart: remember for the rest of the app
        // session so later scans go straight to JSON.
        if (isMultipartUnsupportedStatus(multipartResponse.error.status)) {
          markScanMultipartUnsupported();
        }
        // Belt and braces: ANY multipart failure retries THIS call over
        // JSON+base64 before surfacing an error — a scan must never fail
        // without having tried the legacy transport once. Non-negotiation
        // failures (transient 500/network) do NOT latch, so the next scan
        // attempts multipart again.
        useMultipart = false;
      }

      const jsonBody = await resolveJsonMatchBody();
      if (!jsonBody) {
        return {
          kind: 'error',
          error: new SpotlightRepositoryRequestError(
            'Scan image could not be read for upload.',
            'request_failed',
          ),
          meta: null,
        };
      }
      return this.requestJson<ScanMatchResponseDTO>(
        `${this.baseUrl}/${endpointPath}`,
        {
          body: jsonBody,
          headers: {
            'Content-Type': 'application/json',
          },
          method: 'POST',
        },
        matchRequestOptions,
      );
    };

    // Fire-and-forget the artifact (training image) upload. The backend accepts the same
    // client-generated scanID for both endpoints, and failures are surfaced via the
    // callback rather than thrown.
    const fireArtifactUpload = () => {
      void this.uploadScanArtifactsForMatch(payload, scanID)
        .then((result) => {
          options?.onArtifactUploadComplete?.(result);
          return result;
        })
        .catch((error: unknown) => {
          const failure: ScannerArtifactUploadResult = {
            status: 'failed',
            errorKind: 'request_failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          };
          options?.onArtifactUploadComplete?.(failure);
          return failure;
        });
    };

    // Slab matches take 40-50s on staging; if the heavier artifact upload were chained
    // behind the match, users often background the app before it kicks off, leaving zero
    // slab artifacts in GCS (see repo bug investigation 2026-05-19). So slabs upload in
    // PARALLEL. Raw matches are <1s, so we DEFER the raw artifact upload until after the
    // match resolves — that way the heavier source-image upload never competes with the
    // match for uplink bandwidth on weak networks (the show-floor / VPN failure mode).
    if (!isRawMatch) {
      fireArtifactUpload();
    }

    // Retry the raw match on transient transport/timeout/HTTP failures (mirrors the
    // dashboard retry). A `200` — including a low-confidence/wrong match — is a success
    // and is never retried. Retrying is idempotent (backend upserts by scanID). Slabs run
    // a single attempt (no retry) to preserve their long-match behavior.
    let response = await runMatchRequest();
    if (isRawMatch) {
      for (
        let attempt = 2;
        attempt <= rawMatchAttempts && response.kind === 'error';
        attempt += 1
      ) {
        const backoffMs = rawMatchRetryBackoffsMs[attempt - 2]
          ?? rawMatchRetryBackoffsMs[rawMatchRetryBackoffsMs.length - 1];
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        response = await runMatchRequest();
      }
      // Deferred raw artifact upload: the match is done (success or final failure), so the
      // upload now gets the uplink to itself.
      fireArtifactUpload();
    }

    if (response.kind !== 'success') {
      throw response.error;
    }

    const roundTripMs = Date.now() - startedAt;
    const serverProcessingMs = normalizeNumber(response.data?.performance?.serverProcessingMs);
    // The backend echoes the client-supplied scanID, but fall back to the local one if the
    // response shape ever changes so the upload keys stay aligned.
    const responseScanID = normalizeString(response.data?.scanID) ?? scanID;

    const candidates = mapScannerMatchCandidates(response.data, this.baseUrl);

    return {
      scanID: responseScanID,
      candidates,
      candidatePoolSize: normalizeNumber(response.data?.candidatePoolSize) ?? candidates.length,
      endpointPath,
      resolverMode: normalizeString(response.data?.resolverMode),
      reviewDisposition: normalizeString(response.data?.reviewDisposition),
      reviewReason: normalizeString(response.data?.reviewReason),
      requestAttemptCount: response.meta.attemptCount,
      requestUrl: response.meta.requestUrl,
      roundTripMs,
      serverProcessingMs,
      slabContext: normalizeSlabContext(response.data?.slabContext),
      targetLanguageMismatch: normalizeTargetLanguageMismatch(response.data?.targetLanguageMismatch),
    } satisfies ScannerMatchResult;
  }

  async fetchScanCandidates(scanId: string, offset: number, limit: number) {
    const queryParams = new URLSearchParams({
      offset: String(Math.max(0, Math.trunc(offset))),
      limit: String(Math.max(1, Math.trunc(limit))),
    });
    const response = await this.requestJsonOrThrow<ScanCandidatesResponseDTO>(
      `${this.baseUrl}/api/v1/scan/${encodeURIComponent(scanId)}/candidates?${queryParams.toString()}`,
      { method: 'GET' },
    );
    const candidates = mapScannerMatchCandidates(
      { topCandidates: response?.candidates } as ScanMatchResponseDTO,
      this.baseUrl,
    );
    const total = normalizeNumber(response?.total) ?? candidates.length;
    return { candidates, total };
  }

  async getScannerCandidates(mode: ScannerMode, limit = 10) {
    const seededCandidates = buildScannerCandidates(mode, limit);
    const resolvedCandidates = await Promise.all(
      seededCandidates.map((candidate) => this.resolveScannerCandidate(candidate)),
    );
    return resolvedCandidates;
  }

  async submitScanFeedback(payload: ScanFeedbackPayload) {
    await this.requestJsonOrThrow<{ status?: string }>(`${this.baseUrl}/api/v1/scan/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async whosThatPokemon(payload: WhosThatPokemonPayload): Promise<WhosThatPokemonResult> {
    // Mirrors the matchScannerCapture JSON+base64 transport: the selfie travels
    // inline in the JSON body; auth rides on requestInitWithAuth inside
    // requestJson. Palette hexes are optional and omitted when empty.
    const body: Record<string, unknown> = {
      image: {
        jpegBase64: payload.jpegBase64,
        width: payload.width,
        height: payload.height,
      },
    };
    const palette = (payload.palette ?? []).filter(
      (hex) => typeof hex === 'string' && hex.trim().length > 0,
    );
    if (palette.length > 0) {
      body.palette = palette;
    }

    const response = await this.requestJsonOrThrow<{ matches?: unknown }>(
      `${this.baseUrl}/api/v1/whos-that-pokemon`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: whosThatPokemonRequestTimeoutMs },
    );

    const rawMatches = Array.isArray(response.matches) ? response.matches : [];
    const matches = rawMatches.flatMap((raw): WhosThatPokemonMatch[] => {
      const record = (raw ?? {}) as Record<string, unknown>;
      const species = normalizeString(record.species);
      const pokedexId = normalizeNumber(record.pokedexId);
      if (!species || pokedexId == null || pokedexId <= 0) {
        return [];
      }
      const confidence = normalizeNumber(record.confidence) ?? 0;
      return [{
        species,
        pokedexId: Math.trunc(pokedexId),
        confidence: Math.min(1, Math.max(0, confidence)),
        reason: normalizeString(record.reason) ?? '',
      }];
    });

    if (matches.length === 0) {
      throw new SpotlightRepositoryRequestError(
        'The match service returned no Pokémon matches.',
        'invalid_response',
      );
    }

    return { matches };
  }

  async whosThatShareCard(payload: WhosThatShareCardPayload): Promise<WhosThatShareCardResult> {
    const response = await this.requestJsonOrThrow<{ pngBase64?: unknown }>(
      `${this.baseUrl}/api/v1/whos-that-pokemon/share-card`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: { jpegBase64: payload.jpegBase64 },
          species: payload.species,
          pokedexId: payload.pokedexId,
          reason: payload.reason,
          confidence: payload.confidence,
        }),
      },
      { timeoutMs: whosThatPokemonRequestTimeoutMs },
    );

    const pngBase64 = normalizeString(response.pngBase64);
    if (!pngBase64) {
      throw new SpotlightRepositoryRequestError(
        'The share card image was missing from the response.',
        'invalid_response',
      );
    }

    return { pngBase64 };
  }

  async createLabelingSession(payload: LabelingSessionCreatePayload) {
    return this.requestJsonOrThrow<LabelingSessionRecord>(`${this.baseUrl}/api/v1/labeling-sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async uploadLabelingSessionArtifact(payload: LabelingSessionArtifactUploadPayload) {
    const encodedSessionID = encodeURIComponent(payload.sessionID);
    return this.requestJsonOrThrow<LabelingSessionArtifactRecord>(
      `${this.baseUrl}/api/v1/labeling-sessions/${encodedSessionID}/artifacts`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
  }

  async completeLabelingSession(
    sessionID: string,
    payload: { completedAt?: string | null } = {},
  ) {
    const encodedSessionID = encodeURIComponent(sessionID);
    return this.requestJsonOrThrow<LabelingSessionRecord>(
      `${this.baseUrl}/api/v1/labeling-sessions/${encodedSessionID}/complete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
  }

  async abortLabelingSession(
    sessionID: string,
    payload: { abortedAt?: string | null } = {},
  ) {
    const encodedSessionID = encodeURIComponent(sessionID);
    return this.requestJsonOrThrow<LabelingSessionRecord>(
      `${this.baseUrl}/api/v1/labeling-sessions/${encodedSessionID}/abort`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
  }

  async loadCardDetail(query: CardDetailQuery, options?: CardDetailLoadOptions) {
    const detailQuery = buildDetailQueryParams(query);

    const detailUrl = `${this.baseUrl}/api/v1/cards/${query.cardId}${detailQuery.toString() ? `?${detailQuery.toString()}` : ''}`;
    const historyQuery = buildRawDefaultMarketHistoryQuery(query);

    // Owned entries come from the full-collection endpoint, which is unrelated
    // to the card identity/pricing the page needs to paint. Kick it off in
    // parallel but DON'T gate the returned detail on it: when the caller opts
    // out (the PDP fast path), skip it entirely so the card image + variants
    // render as soon as detail + market-history resolve, instead of waiting on
    // the user's entire collection. `getCardDetailCached` sources owned context
    // from the already-loaded inventory cache instead.
    const includeOwnedEntries = options?.includeOwnedEntries ?? true;
    const inventoryPromise = includeOwnedEntries ? this.loadInventoryEntries() : null;

    const [detailResponse, historyResponse] = await Promise.all([
      this.requestJson<CardDetailDTO>(detailUrl, undefined, { allowNotFound: true }),
      this.requestJson<CardMarketHistoryDTO>(`${this.baseUrl}/api/v1/cards/${query.cardId}/market-history?${historyQuery.toString()}`),
    ]);

    if (detailResponse.kind === 'not_found') {
      return buildLoadResult('not_found', null);
    }

    if (detailResponse.kind === 'error') {
      return buildLoadResult('error', null, detailResponse.error.message);
    }

    if (detailResponse.data === null) {
      return buildLoadResult('not_found', null);
    }

    const card = normalizeCardCandidate(detailResponse.data.card, this.baseUrl);
    if (!card) {
      return buildLoadResult('error', null, 'Received an invalid card detail payload from Spotlight backend.');
    }

    const marketHistory = historyResponse.kind === 'success'
      ? buildMarketHistoryRecord(historyResponse.data, card.pricing.currencyCode)
      : buildMarketHistoryRecord(null, card.pricing.currencyCode);

    const detail: CardDetailRecord = {
      cardId: card.id,
      name: card.name,
      cardNumber: withCardNumberPrefix(card.number),
      setName: card.setName,
      imageUrl: pickImageUrl([
        detailResponse.data.imageLargeURL,
        detailResponse.data.card.imageLargeURL,
        detailResponse.data.imageSmallURL,
        detailResponse.data.card.imageSmallURL,
      ], this.baseUrl),
      largeImageUrl:
        pickImageUrl([
          detailResponse.data.imageLargeURL,
          detailResponse.data.card.imageLargeURL,
        ], this.baseUrl) || null,
      marketPrice: card.pricing.market ?? marketHistory.currentPrice ?? null,
      currencyCode: card.pricing.currencyCode,
      marketplaceLabel: 'TCGPLAYER BUYING OPTIONS',
      marketplaceUrl: buildTcgPlayerSearchUrl({
        name: card.name,
        cardNumber: card.number,
        setName: card.setName,
      }),
      marketHistory: {
        ...marketHistory,
        currentPrice: marketHistory.currentPrice ?? card.pricing.market ?? 0,
      },
      ownedEntries: ((await inventoryPromise)?.data ?? []).filter((entry: InventoryCardEntry) => entry.cardId === query.cardId),
      variantOptions: marketHistory.availableVariants,
      isFavorite: normalizeBoolean(detailResponse.data.isFavorite) ?? card.isFavorite,
      favoritedAt: normalizeString(detailResponse.data.favoritedAt),
      favoriteContext: buildFavoriteContext(detailResponse.data.favoriteContext),
      isLiked: normalizeBoolean(detailResponse.data.isLiked) ?? false,
      likedAt: normalizeString(detailResponse.data.likedAt),
      likeCount: normalizeInteger(detailResponse.data.likeCount),
      watcherCount: normalizeInteger(detailResponse.data.watcherCount),
      language: normalizeCardLanguage(detailResponse.data.language),
      counterpartCardId: normalizeString(detailResponse.data.counterpartCardID),
      counterpartLanguage: normalizeCardLanguage(detailResponse.data.counterpartLanguage),
      trendsPct: card.pricing.trendsPct ?? null,
      cardText: buildCardText(detailResponse.data.cardText),
      tcgPlayerVariants: card.tcgPlayerVariants,
      population: normalizeCardPopulation(detailResponse.data.population),
      gradedReference: normalizeGradedReference(detailResponse.data.gradedReference),
      artist: normalizeString(detailResponse.data.artist),
      releaseDate: normalizeString(detailResponse.data.setReleaseDate),
    };

    return buildLoadResult('success', detail);
  }

  async getCardDetail(query: CardDetailQuery, options?: CardDetailLoadOptions) {
    const result = await this.loadCardDetail(query, options);
    if (result.state === 'error') {
      throw new SpotlightRepositoryRequestError(
        result.errorMessage ?? 'Could not load this card right now.',
        'request_failed',
      );
    }

    return result.data;
  }

  async getRawPricingMatrix(cardId: string): Promise<RawPricingMatrix> {
    const encodedCardID = encodeURIComponent(cardId);
    const response = await this.requestJson<RawPricingMatrixDTO>(
      `${this.baseUrl}/api/v1/cards/${encodedCardID}/raw-pricing-matrix`,
      undefined,
      { allowNotFound: true },
    );

    if (response.kind !== 'success' || response.data === null) {
      return { cardID: cardId, currencyCode: 'USD', variants: [] };
    }

    const data = response.data;
    return {
      cardID: normalizeString(data.cardID) ?? cardId,
      currencyCode: normalizeString(data.currencyCode) ?? 'USD',
      variants: Array.isArray(data.variants)
        ? data.variants.map((variant) => ({
            variant: normalizeString(variant.variant) ?? '',
            variantKey: normalizeString(variant.variantKey) ?? '',
            conditions: Array.isArray(variant.conditions)
              ? variant.conditions
                  .map((condition): RawPricingMatrixConditionRow => ({
                    code: normalizeString(condition.code) ?? '',
                    label: normalizeString(condition.label) ?? '',
                    low: typeof condition.low === 'number' ? condition.low : null,
                    mid: typeof condition.mid === 'number' ? condition.mid : null,
                    market: typeof condition.market === 'number' ? condition.market : null,
                    high: typeof condition.high === 'number' ? condition.high : null,
                  }))
                  .filter((condition) => !!condition.code)
              : [],
          }))
          .filter((variant) => !!variant.variant && variant.conditions.length > 0)
        : [],
    };
  }

  async getCardMarketHistory(query: CardDetailQuery & {
    condition?: string | null;
    days?: number;
    variant?: string | null;
  }) {
    const historyQuery = buildDetailQueryParams(query);
    historyQuery.set('days', String(Math.max(7, Math.min(query.days ?? 30, 90))));
    if (query.variant) {
      historyQuery.set('variant', query.variant);
    }
    if (query.condition) {
      const shortCode = toMarketHistoryConditionCode(query.condition);
      if (shortCode) {
        historyQuery.set('condition', shortCode);
      }
    } else if (!query.slabContext?.grader && !query.slabContext?.grade) {
      historyQuery.set('condition', 'NM');
    }

    const response = await this.requestJson<CardMarketHistoryDTO>(
      `${this.baseUrl}/api/v1/cards/${query.cardId}/market-history?${historyQuery.toString()}`,
      undefined,
      { allowNotFound: true },
    );

    if (response.kind !== 'success' || response.data === null) {
      return null;
    }

    return buildMarketHistoryRecord(response.data, 'USD');
  }

  async getCardPriceTrends(query: CardPriceTrendsQuery): Promise<CardPriceTrendList | null> {
    const trendsQuery = new URLSearchParams();
    trendsQuery.set('mode', query.mode);
    if (query.variant) {
      trendsQuery.set('variant', query.variant);
    }
    if (query.grader) {
      trendsQuery.set('grader', query.grader);
    }

    const response = await this.requestJson<CardPriceTrendListDTO>(
      `${this.baseUrl}/api/v1/cards/${encodeURIComponent(query.cardId)}/price-trends?${trendsQuery.toString()}`,
      undefined,
      { allowNotFound: true },
    );

    if (response.kind !== 'success' || response.data === null) {
      return null;
    }

    return buildCardPriceTrendList(response.data);
  }

  async getCardConditionHistory(query: CardConditionHistoryQuery): Promise<CardConditionHistory | null> {
    const lane: CardConditionHistoryLane = query.lane === 'graded' ? 'graded' : 'raw';
    const historyQuery = new URLSearchParams();
    historyQuery.set('lane', lane);
    historyQuery.set('days', String(Math.max(7, Math.min(query.days ?? 365, 365))));

    const response = await this.requestJson<CardConditionHistoryDTO>(
      `${this.baseUrl}/api/v1/cards/${encodeURIComponent(query.cardId)}/condition-history?${historyQuery.toString()}`,
      undefined,
      { allowNotFound: true },
    );

    if (response.kind !== 'success' || response.data === null) {
      return null;
    }

    return buildCardConditionHistory(response.data, lane);
  }

  async getCardEbayListings(query: CardDetailQuery & {
    limit?: number;
  }) {
    const ebayQuery = buildDetailQueryParams(query);
    ebayQuery.set('limit', String(Math.max(1, Math.min(query.limit ?? 5, 20))));
    const response = await this.requestJson<EbayCompsDTO>(
      `${this.baseUrl}/api/v1/cards/${query.cardId}/ebay-comps?${ebayQuery.toString()}`,
      undefined,
      { allowNotFound: true },
    );

    if (response.kind !== 'success' || response.data === null) {
      return null;
    }

    return buildCardEbayListingsRecord(response.data, 'USD');
  }

  async getCardRecentSales(query: CardRecentSalesQuery) {
    const recentSalesQuery = buildDetailQueryParams(query);
    recentSalesQuery.set('source', query.source ?? 'ebay');
    recentSalesQuery.set('limit', String(Math.max(1, Math.min(query.limit ?? 5, 20))));
    if (query.refresh) {
      recentSalesQuery.set('refresh', '1');
    }
    const response = await this.requestJson<CardRecentSalesDTO>(
      `${this.baseUrl}/api/v1/cards/${query.cardId}/recent-sales?${recentSalesQuery.toString()}`,
      undefined,
      { allowNotFound: true },
    );

    if (response.kind !== 'success' || response.data === null) {
      return null;
    }

    return buildCardRecentSalesRecord(response.data, 'USD');
  }

  async setCardFavorite(cardId: string, isFavorite?: boolean | null) {
    const encodedCardID = encodeURIComponent(cardId);
    const response = await this.requestJsonOrThrow<CardFavoriteDTO>(`${this.baseUrl}/api/v1/cards/${encodedCardID}/favorite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(isFavorite == null ? {} : { isFavorite }),
    });
    return {
      cardId: normalizeString(response.cardId) ?? normalizeString(response.cardID) ?? cardId,
      isFavorite: normalizeBoolean(response.isFavorite) ?? false,
      favoritedAt: normalizeString(response.favoritedAt),
    };
  }

  async setCardLike(cardId: string, isLiked?: boolean | null) {
    const encodedCardID = encodeURIComponent(cardId);
    const response = await this.requestJsonOrThrow<CardLikeDTO>(`${this.baseUrl}/api/v1/cards/${encodedCardID}/like`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(isLiked == null ? {} : { isLiked }),
    });
    return {
      cardId: normalizeString(response.cardId) ?? normalizeString(response.cardID) ?? cardId,
      isLiked: normalizeBoolean(response.isLiked) ?? false,
      likedAt: normalizeString(response.likedAt),
    } satisfies CardLikeRecord;
  }

  async getCardFavorites(query?: CardFavoritesQuery): Promise<CardFavoriteEntry[]> {
    const params = new URLSearchParams();
    if (typeof query?.limit === 'number') {
      params.set('limit', String(query.limit));
    }
    if (typeof query?.offset === 'number') {
      params.set('offset', String(query.offset));
    }
    const queryString = params.toString();
    const url = `${this.baseUrl}/api/v1/card-favorites${queryString ? `?${queryString}` : ''}`;
    const response = await this.requestJson<{ entries?: unknown[] }>(url);
    if (response.kind !== 'success' || !response.data) {
      return [];
    }
    const entries = Array.isArray(response.data.entries) ? response.data.entries : [];
    return entries
      .map((entry): CardFavoriteEntry | null => {
        if (!isRecord(entry)) {
          return null;
        }
        const card = isRecord(entry.card) ? entry.card : null;
        if (!card) {
          return null;
        }
        const cardId = normalizeString(card.id);
        if (!cardId) {
          return null;
        }
        const pricing = isRecord(card.pricing) ? card.pricing : null;
        const marketPrice = pricing
          ? normalizeNumber(pricing.market)
            ?? normalizeNumber(pricing.primaryPrice)
            ?? normalizeNumber(pricing.mid)
            ?? normalizeNumber(pricing.low)
            ?? null
          : null;
        const currencyCode = pricing
          ? normalizeString(pricing.currencyCode) ?? 'USD'
          : 'USD';
        const slabContext = normalizeSlabContext(
          isRecord(entry.slabContext) ? (entry.slabContext as DeckEntryDTO['slabContext']) : null,
        );
        const conditionCopy = mapDeckCondition(normalizeString(entry.condition));
        return {
          cardId,
          name: normalizeString(card.name) ?? '',
          cardNumber: normalizeString(card.number) ?? '',
          setName: normalizeString(card.setName) ?? '',
          imageUrl: normalizeString(card.imageSmallURL) ?? normalizeString(card.imageLargeURL) ?? '',
          smallImageUrl: normalizeString(card.imageSmallURL),
          largeImageUrl: normalizeString(card.imageLargeURL),
          marketPrice,
          currencyCode,
          favoritedAt: normalizeString(entry.favoritedAt),
          isOwned: normalizeBoolean(entry.isOwned) ?? false,
          kind: slabContext ? 'graded' : 'raw',
          variantName: normalizeString(entry.variantName)
            ?? (pricing ? normalizeString(pricing.variant) : null),
          conditionLabel: conditionCopy.label ?? null,
          conditionShortLabel: conditionCopy.shortLabel ?? null,
          slabContext,
          rarityBucket: normalizeRarityBucket(card.rarityBucket),
          dayChangeAmount: normalizeNumber(entry.dayChangeAmount) ?? null,
          dayChangePercent: normalizeNumber(entry.dayChangePercent) ?? null,
          sinceAddedChangeAmount: normalizeNumber(entry.sinceAddedChangeAmount) ?? null,
          sinceAddedChangePercent: normalizeNumber(entry.sinceAddedChangePercent) ?? null,
          sinceAddedBaselineDate: normalizeString(entry.sinceAddedBaselineDate) ?? null,
          sparkPoints: normalizeSparkPoints(entry.sparkPoints),
          sparkTrendPct: normalizeNumber(entry.sparkTrendPct) ?? null,
        };
      })
      .filter((entry): entry is CardFavoriteEntry => entry !== null);
  }

  async getAddToCollectionOptions(cardId: string) {
    const detailResult = await this.loadCardDetail({ cardId });
    if (!detailResult.data) {
      throw new SpotlightRepositoryRequestError(
        detailResult.state === 'not_found'
          ? 'Card not found in the local catalog.'
          : detailResult.errorMessage ?? 'Could not load this card right now.',
        detailResult.state === 'not_found' ? 'not_found' : 'request_failed',
        detailResult.state === 'not_found' ? 404 : undefined,
      );
    }

    return {
      variants: detailResult.data.variantOptions.map((option) => ({
        id: option.id,
        label: option.label,
      })),
      defaultVariant: detailResult.data.variantOptions[0]?.id ?? 'normal',
      defaultPrice: detailResult.data.marketPrice ?? 0,
    };
  }

  async createPortfolioBuy(payload: PortfolioBuyRequestPayload) {
    return this.requestJsonOrThrow<PortfolioBuyResponsePayload>(`${this.baseUrl}/api/v1/portfolio/buys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async createInventoryEntry(payload: InventoryEntryCreateRequestPayload) {
    const body = {
      cardID: payload.cardID,
      slabContext: payload.slabContext,
      variantName: payload.variantName ?? null,
      condition: payload.condition,
      quantity: payload.quantity,
      sourceScanID: payload.sourceScanID,
      selectionSource: payload.selectionSource,
      selectedRank: payload.selectedRank ?? null,
      wasTopPrediction: payload.wasTopPrediction ?? null,
      addedAt: payload.addedAt,
      costBasisPerUnit: payload.costBasisPerUnit ?? null,
    };
    return this.requestJsonOrThrow<InventoryEntryCreateResponsePayload>(`${this.baseUrl}/api/v1/deck/entries`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async replacePortfolioEntry(payload: PortfolioEntryReplaceRequestPayload) {
    return this.requestJsonOrThrow<PortfolioEntryReplaceResponsePayload>(`${this.baseUrl}/api/v1/deck/entries/replace`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async deletePortfolioEntry(payload: PortfolioEntryDeleteRequestPayload) {
    return this.requestJsonOrThrow<PortfolioEntryDeleteResponsePayload>(`${this.baseUrl}/api/v1/deck/entries/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async deletePortfolioEntriesBulk(payload: PortfolioEntryBulkDeleteRequestPayload) {
    return this.requestJsonOrThrow<PortfolioEntryBulkDeleteResponsePayload>(`${this.baseUrl}/api/v1/deck/entries/delete-bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async deleteAccount() {
    return this.requestJsonOrThrow<AccountDeleteResponsePayload>(`${this.baseUrl}/api/v1/account/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async exportDeckEntriesCsv(): Promise<string> {
    // The response is text/csv, not JSON, so it's fetched via requestText and
    // returned verbatim as the raw CSV body. Owner-scoped server-side.
    return this.requestTextOrThrow(`${this.baseUrl}/api/v1/deck/entries/export`, {
      method: 'GET',
      headers: {
        Accept: 'text/csv',
      },
    });
  }

  async setPortfolioEntryQuantity(payload: SetPortfolioEntryQuantityRequestPayload) {
    return this.requestJsonOrThrow<SetPortfolioEntryQuantityResponsePayload>(`${this.baseUrl}/api/v1/deck/entries/quantity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async updateDeckEntryCostBasis(payload: UpdateDeckEntryCostBasisRequestPayload) {
    return this.requestJsonOrThrow<UpdateDeckEntryCostBasisResponsePayload>(`${this.baseUrl}/api/v1/deck/entries/cost-basis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async createPortfolioSale(payload: PortfolioSaleRequestPayload) {
    return this.requestJsonOrThrow<PortfolioSaleResponsePayload>(`${this.baseUrl}/api/v1/portfolio/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async createPortfolioSalesBatch(payloads: PortfolioSaleRequestPayload[]) {
    const payload = await this.requestJsonOrThrow<{ results?: PortfolioSaleResponsePayload[] }>(
      `${this.baseUrl}/api/v1/portfolio/sales/batch`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sales: payloads }),
      },
    );
    return Array.isArray(payload.results) ? payload.results : [];
  }

  async createCardTransaction(payload: CreateCardTransactionPayload) {
    const record = await this.requestJsonOrThrow<CardTransactionRecord>(
      `${this.baseUrl}/api/v1/card-transactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    return this.absolutizeCardTransaction(record);
  }

  async listCardTransactions() {
    const response = await this.requestJsonOrThrow<{ transactions?: CardTransactionRecord[] }>(
      `${this.baseUrl}/api/v1/card-transactions`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
    return (response.transactions ?? []).map((transaction) => this.absolutizeCardTransaction(transaction));
  }

  async loadTransactionInsights(): Promise<TransactionInsights> {
    const queryParams = new URLSearchParams({ timeZone: 'America/Los_Angeles' });
    const payload = await this.requestJsonOrThrow<TransactionInsights>(
      `${this.baseUrl}/api/v1/portfolio/transaction-insights?${queryParams.toString()}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const dto = payload as Record<string, unknown> & TransactionInsights;
    const rawGrowth = Array.isArray(dto.topGrowth) ? (dto.topGrowth as Record<string, unknown>[]) : [];
    const topGrowth: InsightGrowthCard[] = rawGrowth.map((x) => ({
      cardId: String(x.cardId),
      name: String(x.name ?? ''),
      setName: (x.setName as string | null) ?? null,
      cardNumber: (x.cardNumber as string | null) ?? null,
      imageUrl: normalizeImageUrl((x.imageUrl as string | null) ?? null, this.baseUrl) || null,
      currencyCode: String(x.currencyCode ?? 'USD'),
      changeAmountCents: Number(x.changeAmountCents ?? 0),
      changePct: Number(x.changePct ?? 0),
    }));
    return {
      ...payload,
      biggestSale: payload.biggestSale ? this.absolutizeCardTransaction(payload.biggestSale) : null,
      topSalesThisMonth: (payload.topSalesThisMonth ?? []).map((sale) =>
        this.absolutizeCardTransaction(sale),
      ),
      totalPortfolioValueCents: Number(dto.totalPortfolioValueCents ?? 0),
      scannedCount: Number(dto.scannedCount ?? 0),
      wishlistedCount: Number(dto.wishlistedCount ?? 0),
      biggestPurchase: payload.biggestPurchase
        ? this.absolutizeCardTransaction(payload.biggestPurchase)
        : null,
      topGrowth,
    };
  }

  private absolutizeCardTransaction(record: CardTransactionRecord): CardTransactionRecord {
    const photoUrl = normalizeImageUrl(record.photoUrl, this.baseUrl);
    return {
      ...record,
      photoUrl: photoUrl || null,
      imageUrl: normalizeImageUrl(record.imageUrl, this.baseUrl) || null,
    };
  }

  async markSalePaid(saleID: string) {
    return this.requestJsonOrThrow<SaleLifecycleResponsePayload>(
      `${this.baseUrl}/api/v1/sales/${encodeURIComponent(saleID)}/mark-paid`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
  }

  async voidSale(saleID: string) {
    return this.requestJsonOrThrow<SaleLifecycleResponsePayload>(
      `${this.baseUrl}/api/v1/sales/${encodeURIComponent(saleID)}/void`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
  }

  async getVendorWalletHandles() {
    return this.requestJsonOrThrow<VendorWalletHandles>(
      `${this.baseUrl}/api/v1/vendor/wallet-handles`,
    );
  }

  async updateVendorWalletHandles(payload: VendorWalletHandlesUpdate) {
    return this.requestJsonOrThrow<VendorWalletHandles>(
      `${this.baseUrl}/api/v1/vendor/wallet-handles`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
  }

  async previewPortfolioImport(payload: PortfolioImportPreviewRequestPayload) {
    const [job, inventoryEntries] = await Promise.all([
      this.requestJsonOrThrow<PortfolioImportJobDTO>(
        `${this.baseUrl}/api/v1/portfolio/imports/preview`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      ),
      this.getInventoryEntries().catch(() => []),
    ]);

    return normalizePortfolioImportJob(job, this.baseUrl, inventoryEntries);
  }

  async fetchPortfolioImportJob(jobID: string) {
    const encodedJobID = encodeURIComponent(jobID);
    const [job, inventoryEntries] = await Promise.all([
      this.requestJsonOrThrow<PortfolioImportJobDTO>(`${this.baseUrl}/api/v1/portfolio/imports/${encodedJobID}`),
      this.getInventoryEntries().catch(() => []),
    ]);

    return normalizePortfolioImportJob(job, this.baseUrl, inventoryEntries);
  }

  async resolvePortfolioImportRow(jobID: string, payload: PortfolioImportResolveRequestPayload) {
    const encodedJobID = encodeURIComponent(jobID);
    const requestBody = payload.action === 'skip'
      ? {
        rowID: payload.rowID,
        skip: true,
      }
      : {
        rowID: payload.rowID,
        cardID: payload.matchedCardID ?? null,
      };

    const [job, inventoryEntries] = await Promise.all([
      this.requestJsonOrThrow<PortfolioImportJobDTO>(
        `${this.baseUrl}/api/v1/portfolio/imports/${encodedJobID}/resolve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
      ),
      this.getInventoryEntries().catch(() => []),
    ]);

    return normalizePortfolioImportJob(job, this.baseUrl, inventoryEntries);
  }

  async commitPortfolioImportJob(jobID: string) {
    const encodedJobID = encodeURIComponent(jobID);
    const response = await this.requestJsonOrThrow<PortfolioImportCommitResponseDTO>(
      `${this.baseUrl}/api/v1/portfolio/imports/${encodedJobID}/commit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    const inventoryEntries = await this.getInventoryEntries().catch(() => []);
    return normalizePortfolioImportCommitResponse(response, this.baseUrl, inventoryEntries);
  }

  async listExpansions(game = 'pokemon'): Promise<ExpansionRecord[]> {
    const params = new URLSearchParams({ game });
    const response = await this.requestJson<{ expansions: ExpansionRecord[] }>(
      `${this.baseUrl}/api/v1/expansions?${params.toString()}`,
    );
    if (response.kind !== 'success') {
      return [];
    }
    return Array.isArray(response.data?.expansions) ? response.data.expansions : [];
  }

  async listCardsInExpansion(expansionId: string, query = '', limit = 50): Promise<CatalogSearchResult[]> {
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(limit, 200))) });
    if (query.trim()) {
      params.set('q', query.trim());
    }
    const [searchResponse, inventoryResult] = await Promise.all([
      this.requestJson<SearchResultsDTO>(
        `${this.baseUrl}/api/v1/expansions/${encodeURIComponent(expansionId)}/cards?${params.toString()}`,
      ),
      this.loadInventoryEntries(),
    ]);
    if (searchResponse.kind !== 'success') {
      return [];
    }
    const inventoryEntries = inventoryResult.data ?? [];
    const rawResults = Array.isArray(searchResponse.data?.results) ? searchResponse.data.results : [];
    return rawResults.flatMap((result: CardCandidateDTO) => {
      const card = normalizeCardCandidate(result, this.baseUrl);
      if (!card) {
        return [];
      }
      return [{
        id: card.id,
        cardId: card.id,
        name: card.name,
        cardNumber: withCardNumberPrefix(card.number),
        setName: card.setName,
        subtitle: null,
        imageUrl: pickImageUrl([card.imageLargeURL, card.imageSmallURL], this.baseUrl),
        marketPrice: card.pricing.market,
        currencyCode: card.pricing.currencyCode,
        ownedQuantity: inventoryEntries
          .filter((entry: InventoryCardEntry) => entry.cardId === card.id)
          .reduce((sum: number, entry: InventoryCardEntry) => sum + entry.quantity, 0),
        isFavorite: card.isFavorite,
        rarityBucket: card.rarityBucket,
      }];
    });
  }

  async getAccessStatus(): Promise<AccessStatus> {
    const response = await this.requestJson<{
      accessOpen?: boolean | null;
      allowed?: boolean | null;
      isAdmin?: boolean | null;
      showMode?: {
        active?: boolean | null;
        until?: string | null;
        remainingSeconds?: number | null;
      } | null;
    }>(`${this.baseUrl}/api/v1/access/status`);

    if (response.kind !== 'success' || !response.data) {
      // FAIL OPEN: a transport error / empty body must never lock a user out.
      return {
        accessOpen: true,
        allowed: true,
        isAdmin: false,
        showMode: { active: false, until: null, remainingSeconds: 0 },
      };
    }

    const data = response.data;
    return {
      accessOpen: normalizeBoolean(data.accessOpen) ?? false,
      allowed: normalizeBoolean(data.allowed) ?? false,
      isAdmin: normalizeBoolean(data.isAdmin) ?? false,
      showMode: {
        active: normalizeBoolean(data.showMode?.active) ?? false,
        until: normalizeString(data.showMode?.until),
        remainingSeconds: normalizeNumber(data.showMode?.remainingSeconds) ?? 0,
      },
    };
  }

  async redeemInviteCode(code: string): Promise<AccessRedeemResult> {
    const response = await this.requestJson<{ redeemed?: boolean | null; allowed?: boolean | null }>(
      `${this.baseUrl}/api/v1/access/redeem`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      },
    );

    // A 400 means an invalid code — surface it as a non-throwing failure so the
    // BetweenShows screen can show "that code didn't work" without try/catch.
    if (response.kind !== 'success' || !response.data) {
      return { redeemed: false, allowed: false };
    }

    return {
      redeemed: normalizeBoolean(response.data.redeemed) ?? false,
      allowed: normalizeBoolean(response.data.allowed) ?? false,
    };
  }

  async joinAccessWaitlist(email: string): Promise<AccessWaitlistResult> {
    const response = await this.requestJson<{ ok?: boolean | null }>(
      `${this.baseUrl}/api/v1/access/waitlist`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      },
    );

    if (response.kind !== 'success' || !response.data) {
      return { ok: false };
    }

    return { ok: normalizeBoolean(response.data.ok) ?? false };
  }

  async setCardShowMode(active: boolean, hours?: number): Promise<CardShowModeResult> {
    const body: { active: boolean; hours?: number } = { active };
    if (typeof hours === 'number' && Number.isFinite(hours)) {
      body.hours = hours;
    }
    const response = await this.requestJsonOrThrow<{ active?: boolean | null; accessOpen?: boolean | null }>(
      `${this.baseUrl}/api/v1/ops/card-show-mode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    return { accessOpen: normalizeBoolean(response.accessOpen) ?? active };
  }

  async getAccessWhitelist(): Promise<AccessWhitelist> {
    const response = await this.requestJsonOrThrow<{ emails?: unknown }>(
      `${this.baseUrl}/api/v1/ops/access/whitelist`,
    );
    return { emails: Array.isArray(response.emails) ? response.emails.map((value) => String(value)) : [] };
  }

  async addAccessWhitelistEmail(email: string): Promise<AccessWhitelist> {
    const response = await this.requestJsonOrThrow<{ emails?: unknown }>(
      `${this.baseUrl}/api/v1/ops/access/whitelist`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, action: 'add' }),
      },
    );
    return { emails: Array.isArray(response.emails) ? response.emails.map((value) => String(value)) : [] };
  }

  async removeAccessWhitelistEmail(email: string): Promise<AccessWhitelist> {
    const response = await this.requestJsonOrThrow<{ emails?: unknown }>(
      `${this.baseUrl}/api/v1/ops/access/whitelist`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, action: 'remove' }),
      },
    );
    return { emails: Array.isArray(response.emails) ? response.emails.map((value) => String(value)) : [] };
  }

  private async loadPortfolioHistory(range: keyof PortfolioDashboard['ranges']) {
    const queryParams = new URLSearchParams({
      range: mapRangeToBackend(range),
      timeZone: 'America/Los_Angeles',
    });
    const response = await this.requestJsonRead<PortfolioHistoryDTO>(
      `${this.baseUrl}/api/v1/portfolio/history?${queryParams.toString()}`,
      undefined,
      { timeoutMs: portfolioRangeRequestTimeoutMs },
    );

    if (response.kind !== 'success') {
      return buildLoadResult('error', buildEmptyPortfolioHistory(), response.error.message);
    }

    const history = normalizePortfolioHistory(response.data);
    return buildLoadResult(history.points.length > 0 ? 'success' : 'empty', history);
  }

  private async loadPortfolioLedger(range: '1Y' | '30D' | '90D' | 'ALL' | '1W' | 'YTD') {
    const queryParams = new URLSearchParams({
      range,
      timeZone: 'America/Los_Angeles',
      limit: '50',
      offset: '0',
    });
    const response = await this.requestJsonRead<PortfolioLedgerDTO>(
      `${this.baseUrl}/api/v1/portfolio/ledger?${queryParams.toString()}`,
      undefined,
      { timeoutMs: portfolioRangeRequestTimeoutMs },
    );

    if (response.kind !== 'success') {
      return buildLoadResult('error', buildEmptyPortfolioLedger(), response.error.message);
    }

    const ledger = normalizePortfolioLedger(response.data);
    return buildLoadResult(
      ledger.transactions.length > 0 || (ledger.dailySeries?.length ?? 0) > 0 ? 'success' : 'empty',
      ledger,
    );
  }

  // Per-card "2026 Performance Tracker" table (Insights page). One batched heavy
  // read — routed through requestJsonRead so a backpressure 503 retries silently.
  // Defensive mapping tolerates missing fields (→ null / []).
  async getPortfolioPerformance(): Promise<PortfolioPerformance> {
    const response = await this.requestJsonRead<{
      itemCount?: number;
      currencyCode?: string;
      refreshedAt?: string;
      rows?: Array<Record<string, unknown>>;
    }>(`${this.baseUrl}/api/v1/portfolio/performance`);
    if (response.kind !== 'success' || !response.data) {
      // THROW on transport failure — never return an empty payload. The Insights
      // screen keeps its last-good rows on a rejected read; a fabricated
      // zero-row "success" here made a failed pull-to-refresh wipe the table
      // into the empty state. A truly empty portfolio still resolves normally
      // (success response with rows: []).
      throw new Error('portfolio performance read failed');
    }
    const raw = response.data;
    const num = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const rows: PortfolioPerformanceRow[] = (raw.rows ?? []).map((r) => ({
      entryId: String(r.entryId ?? ''),
      cardId: String(r.cardId ?? ''),
      name: String(r.name ?? ''),
      cardNumber: String(r.number ?? r.cardNumber ?? ''),
      setName: String(r.setName ?? ''),
      imageUrl: r.imageUrl != null ? String(r.imageUrl) : null,
      smallImageUrl: r.smallImageUrl != null ? String(r.smallImageUrl) : null,
      quantity: num(r.quantity) ?? 0,
      kind: r.kind === 'graded' ? 'graded' : 'raw',
      grade: r.grade != null ? String(r.grade) : null,
      variantName: r.variantName != null ? String(r.variantName) : null,
      condition: r.condition != null ? String(r.condition) : null,
      currentPrice: num(r.currentPrice),
      currentValue: num(r.currentValue),
      costBasisTotal: num(r.costBasisTotal),
      jan1Price: num(r.jan1Price),
      yearStartValue: num(r.yearStartValue),
      ytdGainDollar: num(r.ytdGainDollar),
      ytdGainPercent: num(r.ytdGainPercent),
      todayGainDollar: num(r.todayGainDollar),
      todayGainPercent: num(r.todayGainPercent),
      monthGainDollar: num(r.monthGainDollar),
      monthGainPercent: num(r.monthGainPercent),
      isFavorite: r.isFavorite === true,
      sparkline: Array.isArray(r.sparkline)
        ? r.sparkline.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        : [],
    }));
    return {
      itemCount: num(raw.itemCount) ?? rows.length,
      currencyCode: raw.currencyCode ?? 'USD',
      refreshedAt: raw.refreshedAt ?? '',
      rows,
    };
  }

  /**
   * Fetches the Insights aggregates from the backend. The featured sales
   * (`bestReturnOfAllTime`, `topSellersThisMonth`) arrive in the raw
   * ledger-transaction shape and must be passed through `buildRecentSales`
   * so the Insights screen sees the same `RecentSaleRecord` fields it does
   * for `recentSales`. Returns null on transport failure so the dashboard
   * fetch as a whole can stay resilient.
   */
  private async loadPortfolioInsights(): Promise<PortfolioInsights | null> {
    try {
      const response = await this.requestJson<
        Omit<PortfolioInsights, 'bestReturnOfAllTime' | 'topSellersThisMonth'> & {
          bestReturnOfAllTime?: PortfolioLedgerDTO['transactions'][number] | null;
          topSellersThisMonth?: PortfolioLedgerDTO['transactions'] | null;
        }
      >(`${this.baseUrl}/api/v1/portfolio/insights`);
      if (response.kind !== 'success' || !response.data) {
        return null;
      }
      const raw = response.data;
      const topSellers = buildRecentSales(raw.topSellersThisMonth ?? [], this.baseUrl);
      const bestReturn = raw.bestReturnOfAllTime
        ? (buildRecentSales([raw.bestReturnOfAllTime], this.baseUrl)[0] ?? null)
        : null;
      return {
        ...raw,
        bestReturnOfAllTime: bestReturn,
        topSellersThisMonth: topSellers,
      };
    } catch (_error) {
      return null;
    }
  }

  // A heavy read can get a fast 503 ("ServerBusy") when the backend sheds load
  // under a concurrency spike (read backpressure). The shed is momentary and the
  // 503 is marked retryable, so re-attempt silently with backoff — a spike stays
  // invisible to the user instead of surfacing "couldn't refresh". Reads are
  // idempotent so retrying is safe; only the heavy GET reads route through this.
  private async requestJsonRead<T>(
    url: string,
    init?: RequestInit,
    options?: JsonRequestOptions,
  ): Promise<JsonRequestResult<T>> {
    const backoffsMs = [400, 900, 1800];
    let result = await this.requestJson<T>(url, init, options);
    let attempt = 0;
    while (
      result.kind === 'error' &&
      result.error.status === 503 &&
      attempt < backoffsMs.length
    ) {
      await new Promise((resolve) => setTimeout(resolve, backoffsMs[attempt]));
      attempt += 1;
      result = await this.requestJson<T>(url, init, options);
    }
    return result;
  }

  private async requestJson<T>(
    url: string,
    init?: RequestInit,
    options?: JsonRequestOptions,
  ): Promise<JsonRequestResult<T>> {
    const candidateUrls = this.expandRequestCandidateUrls(url, options?.candidateStrategy);
    let lastNetworkError: SpotlightRepositoryRequestError | null = null;
    let lastRequestMeta: JsonRequestMeta | null = null;
    const requestInit = await this.requestInitWithAuth(init);

    for (const [index, candidateUrl] of candidateUrls.entries()) {
      const attemptCount = index + 1;
      let response: Response;
      const attemptStartedAt = Date.now();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => {
          controller.abort();
        }, options?.timeoutMs ?? defaultHttpRequestTimeoutMs)
        : null;

      try {
        response = await fetch(
          candidateUrl,
          controller ? { ...requestInit, signal: controller.signal } : requestInit,
        );
      } catch (error) {
        const elapsedMs = Date.now() - attemptStartedAt;
        lastRequestMeta = {
          attemptCount,
          requestUrl: candidateUrl,
        };
        lastNetworkError = new SpotlightRepositoryRequestError(
          isAbortError(error)
            ? 'Request timed out while contacting the Spotlight backend.'
            : errorMessageFromUnknown(error, 'Could not reach the Spotlight backend.'),
          'request_failed',
        );
        if (options?.logTransport) {
          this.logRequestTransport(options.requestLabel ?? 'request', {
            attempt: attemptCount,
            elapsedMs,
            error: lastNetworkError.message,
            outcome: isAbortError(error) ? 'timeout' : 'network_error',
            strategy: options.candidateStrategy ?? 'all_candidates',
            url: candidateUrl,
          });
        }
        continue;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }

      this.promoteSuccessfulBaseUrl(candidateUrl);
      const elapsedMs = Date.now() - attemptStartedAt;
      const requestMeta: JsonRequestMeta = {
        attemptCount,
        requestUrl: candidateUrl,
      };
      lastRequestMeta = requestMeta;

      if (options?.logTransport) {
        this.logRequestTransport(options.requestLabel ?? 'request', {
          attempt: attemptCount,
          elapsedMs,
          outcome: response.ok ? 'success' : 'http_error',
          status: response.status,
          strategy: options.candidateStrategy ?? 'all_candidates',
          url: candidateUrl,
        });
      }

      if (options?.allowNotFound && response.status === 404) {
        return {
          kind: 'not_found',
          error: new SpotlightRepositoryRequestError('Requested resource was not found.', 'not_found', 404),
          meta: requestMeta,
        };
      }

      if (!response.ok) {
        const message = await safeResponseText(response);
        return {
          kind: 'error',
          error: new SpotlightRepositoryRequestError(
            message || `Request failed with status ${response.status}`,
            'request_failed',
            response.status,
          ),
          meta: requestMeta,
        };
      }

      const text = await safeResponseText(response);
      if (!text.trim()) {
        return {
          kind: 'success',
          data: null,
          meta: requestMeta,
        };
      }

      try {
        return {
          kind: 'success',
          data: JSON.parse(text) as T,
          meta: requestMeta,
        };
      } catch {
        return {
          kind: 'error',
          error: new SpotlightRepositoryRequestError(
            'Received invalid JSON from the Spotlight backend.',
            'invalid_response',
            response.status,
          ),
          meta: requestMeta,
        };
      }
    }

    return {
      kind: 'error',
      error: lastNetworkError ?? new SpotlightRepositoryRequestError(
        'Could not reach the Spotlight backend.',
        'request_failed',
      ),
      meta: lastRequestMeta,
    };
  }

  private expandRequestCandidateUrls(
    url: string,
    strategy: JsonRequestCandidateStrategy = 'all_candidates',
  ) {
    if (strategy === 'single_active') {
      return [url];
    }

    const activeBaseUrl = this.activeBaseUrl;
    const orderedBaseUrls = [
      activeBaseUrl,
      ...this.baseUrls.filter((candidate) => candidate !== activeBaseUrl),
    ];

    if (!url.startsWith(activeBaseUrl)) {
      return [url];
    }

    return orderedBaseUrls.map((candidateBaseUrl) => {
      return `${candidateBaseUrl}${url.slice(activeBaseUrl.length)}`;
    });
  }

  private promoteSuccessfulBaseUrl(url: string) {
    const matchedBaseUrl = this.baseUrls.find((candidate) => url.startsWith(candidate));
    if (!matchedBaseUrl || matchedBaseUrl === this.activeBaseUrl) {
      return;
    }

    this.activeBaseUrl = matchedBaseUrl;
  }

  private async requestJsonOrThrow<T>(url: string, init?: RequestInit, options?: JsonRequestOptions) {
    const result = await this.requestJson<T>(url, init, options);
    if (result.kind !== 'success') {
      throw result.error;
    }

    if (result.data === null) {
      throw new SpotlightRepositoryRequestError(
        'Received an empty response from the Spotlight backend.',
        'invalid_response',
      );
    }

    return result.data;
  }

  // Text variant of requestJson: authenticates and fetches the same way (auth
  // header, per-attempt timeout/abort, base-url candidate failover) but returns
  // the raw response body as text instead of parsing JSON. Used for endpoints
  // that serve text/csv. Throws SpotlightRepositoryRequestError on transport or
  // HTTP failure, matching requestJsonOrThrow's error surface.
  private async requestTextOrThrow(
    url: string,
    init?: RequestInit,
    options?: Pick<JsonRequestOptions, 'candidateStrategy' | 'timeoutMs'>,
  ): Promise<string> {
    // A heavy read (e.g. CSV export) can get a fast 503 "ServerBusy" when the
    // backend sheds load under concurrency. That's retryable, so re-attempt
    // silently with backoff — matching requestJsonRead and the backend's
    // "client retries silently" design — instead of surfacing the raw 503.
    const serverBusyBackoffsMs = [600, 1200, 2400];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestTextOnce(url, init, options);
      } catch (error) {
        const isServerBusy =
          error instanceof SpotlightRepositoryRequestError && error.status === 503;
        if (!isServerBusy || attempt >= serverBusyBackoffsMs.length) {
          throw error;
        }
        const jitterMs = Math.floor(Math.random() * 200);
        await new Promise((resolve) =>
          setTimeout(resolve, serverBusyBackoffsMs[attempt] + jitterMs),
        );
      }
    }
  }

  private async requestTextOnce(
    url: string,
    init?: RequestInit,
    options?: Pick<JsonRequestOptions, 'candidateStrategy' | 'timeoutMs'>,
  ): Promise<string> {
    const candidateUrls = this.expandRequestCandidateUrls(url, options?.candidateStrategy);
    const requestInit = await this.requestInitWithAuth(init);
    let lastNetworkError: SpotlightRepositoryRequestError | null = null;

    for (const candidateUrl of candidateUrls) {
      let response: Response;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => {
          controller.abort();
        }, options?.timeoutMs ?? defaultHttpRequestTimeoutMs)
        : null;

      try {
        response = await fetch(
          candidateUrl,
          controller ? { ...requestInit, signal: controller.signal } : requestInit,
        );
      } catch (error) {
        lastNetworkError = new SpotlightRepositoryRequestError(
          isAbortError(error)
            ? 'Request timed out while contacting the Spotlight backend.'
            : errorMessageFromUnknown(error, 'Could not reach the Spotlight backend.'),
          'request_failed',
        );
        continue;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }

      this.promoteSuccessfulBaseUrl(candidateUrl);

      if (!response.ok) {
        const message = await safeResponseText(response);
        throw new SpotlightRepositoryRequestError(
          message || `Request failed with status ${response.status}`,
          'request_failed',
          response.status,
        );
      }

      return await response.text();
    }

    throw lastNetworkError ?? new SpotlightRepositoryRequestError(
      'Could not reach the Spotlight backend.',
      'request_failed',
    );
  }

  private async uploadScanArtifactsForMatch(
    payload: ScannerCapturePayload,
    scanID: string | null,
  ): Promise<ScannerArtifactUploadResult | null> {
    const uploadPayload = scanID ? createScanArtifactUploadPayload(payload, scanID) : null;
    if (!uploadPayload) {
      return null;
    }

    // Retry with backoff. The upload is idempotent (backend upserts by scanID),
    // so a transient network/VM hiccup shouldn't permanently drop the artifact.
    // After the first attempt we post a NORMALIZED-ONLY payload (the training-
    // critical image) to roughly halve the body and improve the odds it lands on
    // a weak uplink — the backend persists normalized-only fine, so there's no
    // training-data cost. NOTE: in-session retries don't cover the app-
    // backgrounded case; a persistent cross-launch upload queue (deferred) is the
    // remaining gap.
    const normalizedOnlyPayload = { ...uploadPayload, sourceImage: null };
    const retryBackoffsMs = [750, 1500, 3000];

    let result = await this.postScanArtifacts(uploadPayload, payload.readFileAsBase64);
    for (
      let attempt = 0;
      result.status === 'failed' && attempt < retryBackoffsMs.length;
      attempt += 1
    ) {
      const jitterMs = Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, retryBackoffsMs[attempt] + jitterMs));
      result = await this.postScanArtifacts(normalizedOnlyPayload, payload.readFileAsBase64);
    }
    return result;
  }

  private async postScanArtifacts(
    uploadPayload: Record<string, unknown>,
    readFileAsBase64?: ScannerCapturePayload['readFileAsBase64'],
  ): Promise<ScannerArtifactUploadResult> {
    const startedAt = Date.now();
    const url = `${this.baseUrl}/api/v1/scan-artifacts`;
    const requestOptions: JsonRequestOptions = {
      candidateStrategy: 'single_active',
      logTransport: true,
      requestLabel: 'api/v1/scan-artifacts',
      timeoutMs: scanArtifactUploadTimeoutMs,
    };
    const normalizedImage = (uploadPayload.normalizedImage ?? null) as ScannerImagePayload | null;
    const sourceImage = (uploadPayload.sourceImage ?? null) as ScannerImagePayload | null;

    const runUploadRequest = async (): Promise<JsonRequestResult<ScanArtifactUploadResponseDTO>> => {
      const normalizedFileUri = scannerImageFileUri(normalizedImage);
      // Multipart needs every image it is sending to exist as a file part; a
      // mixed payload (e.g. inline-only source) falls back to JSON so nothing
      // is silently dropped.
      const canStreamAllParts = !!normalizedFileUri
        && (!sourceImage || !!scannerImageFileUri(sourceImage));
      if (normalizedImage && normalizedFileUri && canStreamAllParts && canAttemptScanMultipart()) {
        const form = new FormData();
        form.append('payload', JSON.stringify({
          ...uploadPayload,
          normalizedImage: multipartImageMetadata(normalizedImage),
          sourceImage: sourceImage ? multipartImageMetadata(sourceImage) : null,
        }));
        appendMultipartJpegPart(form, 'normalized_image', normalizedFileUri, 'normalized.jpg');
        const sourceFileUri = scannerImageFileUri(sourceImage);
        if (sourceFileUri) {
          appendMultipartJpegPart(form, 'source_image', sourceFileUri, 'source.jpg');
        }
        const multipartResponse = await this.requestJson<ScanArtifactUploadResponseDTO>(
          url,
          {
            body: form,
            // CRITICAL: no Content-Type header — fetch generates the multipart
            // boundary itself.
            method: 'POST',
          },
          requestOptions,
        );
        if (multipartResponse.kind !== 'error') {
          return multipartResponse;
        }
        // Older backend without multipart: remember for the app session so
        // later uploads go straight to JSON.
        if (isMultipartUnsupportedStatus(multipartResponse.error.status)) {
          markScanMultipartUnsupported();
        }
        // Belt and braces: ANY multipart failure falls through to the
        // JSON+base64 body for this same upload (non-negotiation failures do
        // not latch the session flag).
      }

      // JSON+base64 path: materialize inline bytes lazily. The normalized image
      // is training-critical (fail without it, so the outer retry loop can try
      // again); the source image stays optional exactly as before.
      const jsonNormalized = await materializeScannerImageForJson(normalizedImage, readFileAsBase64);
      if (!jsonNormalized) {
        return {
          kind: 'error',
          error: new SpotlightRepositoryRequestError(
            'Scan artifact image could not be read for upload.',
            'request_failed',
          ),
          meta: null,
        };
      }
      const jsonSource = await materializeScannerImageForJson(sourceImage, readFileAsBase64);
      return this.requestJson<ScanArtifactUploadResponseDTO>(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...uploadPayload,
            normalizedImage: jsonNormalized,
            sourceImage: jsonSource,
          }),
        },
        requestOptions,
      );
    };

    const response = await runUploadRequest();

    const roundTripMs = Date.now() - startedAt;
    if (response.kind !== 'success') {
      return {
        status: 'failed',
        errorKind: response.error.kind,
        errorMessage: response.error.message,
        requestAttemptCount: response.meta?.attemptCount ?? null,
        requestUrl: response.meta?.requestUrl ?? null,
        roundTripMs,
      };
    }

    if (response.data?.enabled === false || response.data?.skipped === true) {
      return {
        status: 'skipped',
        reason: normalizeString(response.data?.reason),
        requestAttemptCount: response.meta.attemptCount,
        requestUrl: response.meta.requestUrl,
        roundTripMs,
        storage: normalizeString(response.data?.storage),
      };
    }

    return {
      status: 'uploaded',
      normalizedObjectPath: normalizeString(response.data?.normalizedObjectPath),
      requestAttemptCount: response.meta.attemptCount,
      requestUrl: response.meta.requestUrl,
      roundTripMs,
      sourceObjectPath: normalizeString(response.data?.sourceObjectPath),
      storage: normalizeString(response.data?.storage),
      uploadedAt: normalizeString(response.data?.uploadedAt),
    };
  }
}
