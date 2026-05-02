import {
  appendMockBuy,
  buildMockRecentTrade,
  buildMockDashboard,
  getMockCardDetail,
  seedMockCardDetails,
  seedMockCatalogResults,
  seedMockInventoryEntries,
  seedMockRecentSales,
  seedMockScannerCandidates,
  updateInventoryForSale,
} from './mock-data';
import { labelingSessionAngleLabels } from './types';
import type {
  AddToCollectionOptions,
  CardFavoriteRecord,
  CardDetailQuery,
  CardDetailRecord,
  CardEbayListingRecord,
  CardEbayListingsRecord,
  CardMarketInsight,
  CatalogSearchResult,
  InventoryEntryCreateRequestPayload,
  InventoryEntryCreateResponsePayload,
  InventoryCardEntry,
  InventoryEntriesQuery,
  LabelingSessionArtifactRecord,
  LabelingSessionArtifactUploadPayload,
  LabelingSessionCreatePayload,
  LabelingSessionRecord,
  PortfolioEntryReplaceRequestPayload,
  PortfolioEntryReplaceResponsePayload,
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
  PortfolioSaleRequestPayload,
  PortfolioSaleResponsePayload,
  RecentSaleRecord,
  ScannerCapturePayload,
  ScanFeedbackPayload,
  ScannerMatchResult,
  ScannerMode,
  SlabContext,
  SpotlightRepositoryLoadResult,
} from './types';

export interface SpotlightRepository {
  loadPortfolioDashboard(): Promise<SpotlightRepositoryLoadResult<PortfolioDashboard>>;
  getPortfolioDashboard(): Promise<PortfolioDashboard>;
  loadInventoryEntries(query?: InventoryEntriesQuery): Promise<SpotlightRepositoryLoadResult<InventoryCardEntry[]>>;
  getInventoryEntries(query?: InventoryEntriesQuery): Promise<InventoryCardEntry[]>;
  loadCatalogCards(query: string, limit?: number): Promise<SpotlightRepositoryLoadResult<CatalogSearchResult[]>>;
  searchCatalogCards(query: string, limit?: number): Promise<CatalogSearchResult[]>;
  matchScannerCapture(payload: ScannerCapturePayload): Promise<ScannerMatchResult>;
  getScannerCandidates(mode: ScannerMode, limit?: number): Promise<CatalogSearchResult[]>;
  submitScanFeedback(payload: ScanFeedbackPayload): Promise<void>;
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
  loadCardDetail(query: CardDetailQuery): Promise<SpotlightRepositoryLoadResult<CardDetailRecord | null>>;
  getCardDetail(query: CardDetailQuery): Promise<CardDetailRecord | null>;
  getCardMarketHistory(query: CardDetailQuery & {
    condition?: string | null;
    days?: number;
    variant?: string | null;
  }): Promise<CardDetailRecord['marketHistory'] | null>;
  getCardEbayListings(query: CardDetailQuery & {
    limit?: number;
  }): Promise<CardEbayListingsRecord | null>;
  setCardFavorite(cardId: string, isFavorite?: boolean | null): Promise<CardFavoriteRecord>;
  getAddToCollectionOptions(cardId: string): Promise<AddToCollectionOptions>;
  createInventoryEntry(payload: InventoryEntryCreateRequestPayload): Promise<InventoryEntryCreateResponsePayload>;
  createPortfolioBuy(payload: PortfolioBuyRequestPayload): Promise<PortfolioBuyResponsePayload>;
  replacePortfolioEntry(payload: PortfolioEntryReplaceRequestPayload): Promise<PortfolioEntryReplaceResponsePayload>;
  createPortfolioSale(payload: PortfolioSaleRequestPayload): Promise<PortfolioSaleResponsePayload>;
  createPortfolioSalesBatch(payloads: PortfolioSaleRequestPayload[]): Promise<PortfolioSaleResponsePayload[]>;
  previewPortfolioImport(payload: PortfolioImportPreviewRequestPayload): Promise<PortfolioImportJobRecord>;
  fetchPortfolioImportJob(jobID: string): Promise<PortfolioImportJobRecord>;
  resolvePortfolioImportRow(
    jobID: string,
    payload: PortfolioImportResolveRequestPayload,
  ): Promise<PortfolioImportJobRecord>;
  commitPortfolioImportJob(jobID: string): Promise<PortfolioImportCommitResponsePayload>;
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

const defaultHttpRequestTimeoutMs = 6000;
const scanMatchRequestTimeoutMs = 10000;

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

type CardPricingSummaryDTO = {
  currencyCode?: string;
  market?: number | null;
  variant?: string | null;
  payload?: {
    condition?: string | null;
  } | null;
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
  addedAt?: string;
  isFavorite?: boolean | null;
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
  }>;
  dailySeries?: Array<{
    date: string;
    revenue: number;
    sellCount?: number | null;
  }>;
};

type SearchResultsDTO = {
  results: CardCandidateDTO[];
};

type ScanMatchCandidateDTO = {
  rank?: number | null;
  candidate?: CardCandidateDTO | null;
};

type ScanMatchResponseDTO = {
  scanID?: string | null;
  topCandidates?: ScanMatchCandidateDTO[] | null;
  reviewDisposition?: string | null;
  reviewReason?: string | null;
  performance?: {
    serverProcessingMs?: number | null;
  } | null;
};

type CardDetailDTO = {
  card: CardCandidateDTO;
  imageSmallURL?: string | null;
  imageLargeURL?: string | null;
  isFavorite?: boolean | null;
  favoritedAt?: string | null;
};

type CardFavoriteDTO = {
  cardID?: string | null;
  cardId?: string | null;
  isFavorite?: boolean | null;
  favoritedAt?: string | null;
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

type NormalizedCardCandidate = {
  id: string;
  name: string;
  setName: string;
  number: string;
  imageSmallURL: string;
  imageLargeURL: string;
  isFavorite: boolean;
  pricing: {
    currencyCode: string;
    market: number | null;
    variant?: string | null;
    condition?: string | null;
  };
};

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

function cleanedMarketplaceToken(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildTcgPlayerSearchUrl(params: {
  name: string;
  cardNumber: string;
  setName: string;
}) {
  const query = [
    cleanedMarketplaceToken(params.name),
    cleanedMarketplaceToken(params.cardNumber.replace(/^#/, '')),
    cleanedMarketplaceToken(params.setName),
  ]
    .filter(Boolean)
    .join(' ');

  if (!query) {
    return null;
  }

  const searchParams = new URLSearchParams({
    q: query,
    view: 'grid',
  });

  return `https://www.tcgplayer.com/search/pokemon/product?${searchParams.toString()}`;
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

function normalizeInteger(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : fallback;
}

function normalizeCurrencyCode(value: unknown) {
  return normalizeString(value)?.toUpperCase() ?? 'USD';
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

function normalizeCardCandidate(candidate: CardCandidateDTO | null | undefined, baseUrl?: string) {
  const id = normalizeString(candidate?.id);
  const name = normalizeString(candidate?.name);
  const setName = normalizeString(candidate?.setName);
  const number = normalizeString(candidate?.number);

  if (!id || !name || !setName || !number) {
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
    pricing: {
      currencyCode: normalizeCurrencyCode(candidate?.pricing?.currencyCode),
      market: normalizeNumber(candidate?.pricing?.market),
      variant: normalizeString(candidate?.pricing?.variant),
      condition: normalizeString(candidate?.pricing?.payload?.condition),
    },
  } satisfies NormalizedCardCandidate;
}

function createScannerMatchPayload(
  payload: ScannerCapturePayload,
  clientContext?: RepositoryClientContext,
): Record<string, unknown> {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en_US';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const appVersion = normalizeString(clientContext?.appVersion) || '0';
  const buildNumber = normalizeString(clientContext?.buildNumber) || '0';

  return {
    scanID: createPseudoUUID(),
    capturedAt: new Date().toISOString(),
    clientContext: {
      platform: 'react_native',
      appVersion,
      buildNumber,
      localeIdentifier: locale,
      timeZoneIdentifier: timeZone,
    },
    image: {
      jpegBase64: payload.jpegBase64,
      width: Math.max(1, normalizeInteger(payload.width, 1)),
      height: Math.max(1, normalizeInteger(payload.height, 1)),
    },
    recognizedTokens: [],
    collectorNumber: null,
    setHintTokens: [],
    setBadgeHint: null,
    promoCodeHint: null,
    slabGrader: null,
    slabGrade: null,
    slabCertNumber: null,
    slabBarcodePayloads: [],
    slabGraderConfidence: null,
    slabGradeConfidence: null,
    slabCertConfidence: null,
    slabCardNumberRaw: null,
    slabParsedLabelText: [],
    slabClassifierReasons: [],
    slabRecommendedLookupPath: null,
    resolverModeHint: payload.mode === 'slabs' ? 'psa_slab' : 'raw_card',
    rawResolverMode: payload.mode === 'raw' ? 'visual' : null,
    cropConfidence: 1,
    warnings: [],
    ocrAnalysis: null,
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

    return [{
      id: card.id,
      cardId: card.id,
      name: card.name,
      cardNumber: withCardNumberPrefix(card.number),
      setName: card.setName,
      subtitle: null,
      imageUrl: pickImageUrl([card.imageLargeURL, card.imageSmallURL], baseUrl),
      marketPrice: card.pricing.market,
      currencyCode: card.pricing.currencyCode,
      ownedQuantity: 0,
      isFavorite: card.isFavorite,
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

function mapDeckEntry(entry: DeckEntryDTO, baseUrl?: string): InventoryCardEntry | null {
  const card = normalizeCardCandidate(entry.card, baseUrl);
  if (!card) {
    return null;
  }

  const slabContext = normalizeSlabContext(entry.slabContext);
  const variantName = normalizeString(entry.variantName) ?? normalizeString(entry.slabContext?.variantName);
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
    costBasisPerUnit:
      costBasisTotal && quantity > 0
        ? Number((costBasisTotal / quantity).toFixed(2))
        : null,
    costBasisTotal: costBasisTotal ?? null,
    isFavorite: normalizeBoolean(entry.isFavorite) ?? card.isFavorite,
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
      } satisfies RecentSaleRecord];
    });
}

function aggregateDailySalesSeries(
  points: PortfolioChartPoint[],
  range: keyof PortfolioDashboard['ranges'],
) {
  if (range === '7D' || range === '1M' || points.length <= 1) {
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
    case '7D':
      return '7D';
    case '1M':
      return '30D';
    case '3M':
      return '90D';
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
      '7D': { portfolio: [], sales: [] },
      '1M': { portfolio: [], sales: [] },
      '3M': { portfolio: [], sales: [] },
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

      return [{
        id,
        kind,
        card,
        quantity: normalizeNumber(transaction?.quantity) ?? 0,
        unitPrice: normalizeNumber(transaction?.unitPrice),
        totalPrice: normalizeNumber(transaction?.totalPrice) ?? 0,
        currencyCode: normalizeCurrencyCode(transaction?.currencyCode),
        occurredAt,
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

function mapPortfolioSeries(history: PortfolioHistoryDTO) {
  return history.points.map((point) => ({
    isoDate: point.date,
    shortLabel: formatShortDate(point.date),
    value: point.totalValue,
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
  private catalogResults = seedMockCatalogResults();
  private cardDetails = seedMockCardDetails();
  private favoriteCardTimestamps = new Map<string, string>();
  private portfolioImportJobs = new Map<string, PortfolioImportJobRecord>();
  private labelingSessions = new Map<string, LabelingSessionRecord>();
  private labelingSessionArtifacts = new Map<string, LabelingSessionArtifactRecord>();

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

  async loadPortfolioDashboard() {
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

  async loadInventoryEntries(query?: InventoryEntriesQuery) {
    const entries = this.inventoryEntriesForQuery(query);
    return buildLoadResult(entries.length > 0 ? 'success' : 'empty', entries);
  }

  async getInventoryEntries(query?: InventoryEntriesQuery) {
    const result = await this.loadInventoryEntries(query);
    return result.data ?? [];
  }

  async loadCatalogCards(query: string, limit = 20) {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) {
      return buildLoadResult('empty', []);
    }

    const results = this.catalogResults
      .filter((result) => {
        return [
          result.name,
          result.setName,
          result.cardNumber,
          result.subtitle,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(normalized);
      })
      .slice(0, Math.min(limit, 50))
      .map((result) => ({
        ...result,
        ownedQuantity: this.inventoryEntries
          .filter((entry) => entry.cardId === result.cardId)
          .reduce((sum, entry) => sum + entry.quantity, 0),
      }))
      .map((result) => this.annotateCatalogResult(result));

    return buildLoadResult(results.length > 0 ? 'success' : 'empty', results);
  }

  async searchCatalogCards(query: string, limit = 20) {
    const result = await this.loadCatalogCards(query, limit);
    return result.data ?? [];
  }

  async matchScannerCapture(payload: ScannerCapturePayload) {
    return {
      scanID: createPseudoUUID(),
      candidates: buildScannerCandidates(payload.mode, 10),
    } satisfies ScannerMatchResult;
  }

  async getScannerCandidates(mode: ScannerMode, limit = 10) {
    return buildScannerCandidates(mode, limit);
  }

  async submitScanFeedback(_payload: ScanFeedbackPayload) {
    return undefined;
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

  async loadCardDetail(query: CardDetailQuery) {
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, query);
    return detail
      ? buildLoadResult('success', {
        ...detail,
        ownedEntries: detail.ownedEntries.map((entry) => this.annotateInventoryEntry(entry)),
        isFavorite: this.favoriteCardTimestamps.has(query.cardId),
        favoritedAt: this.favoriteTimestampForCard(query.cardId),
      })
      : buildLoadResult('not_found', null);
  }

  async getCardDetail(query: CardDetailQuery) {
    const result = await this.loadCardDetail(query);
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

  async getCardEbayListings(query: CardDetailQuery & {
    limit?: number;
  }) {
    const detail = getMockCardDetail(this.cardDetails, this.inventoryEntries, query);
    return detail?.ebayListings ?? null;
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
        unitPrice: 0,
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
      unitPrice: payload.unitPrice,
      updatedAt: payload.updatedAt,
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
      limit: String(Math.max(1, Math.min(limit, 50))),
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
          marketPrice: card.pricing.market,
          currencyCode: card.pricing.currencyCode,
          ownedQuantity: 0,
          isFavorite: card.isFavorite,
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

  async loadPortfolioDashboard() {
    const [
      inventoryResult,
      history7d,
      history1m,
      history3m,
      history1y,
      historyAll,
      ledger7d,
      ledger30d,
      ledger90d,
      ledger1y,
      ledgerAll,
    ] = await Promise.all([
      this.loadInventoryEntries(),
      this.loadPortfolioHistory('7D'),
      this.loadPortfolioHistory('1M'),
      this.loadPortfolioHistory('3M'),
      this.loadPortfolioHistory('1Y'),
      this.loadPortfolioHistory('ALL'),
      this.loadPortfolioLedger('7D'),
      this.loadPortfolioLedger('30D'),
      this.loadPortfolioLedger('90D'),
      this.loadPortfolioLedger('1Y'),
      this.loadPortfolioLedger('ALL'),
    ]);

    const safeInventoryEntries = inventoryResult.data ?? [];
    const safeHistory7d = history7d.data ?? buildEmptyPortfolioHistory();
    const safeHistory1m = history1m.data ?? buildEmptyPortfolioHistory();
    const safeHistory3m = history3m.data ?? buildEmptyPortfolioHistory();
    const safeHistory1y = history1y.data ?? buildEmptyPortfolioHistory();
    const safeHistoryAll = historyAll.data ?? buildEmptyPortfolioHistory();
    const safeLedger7d = ledger7d.data ?? buildEmptyPortfolioLedger();
    const safeLedger30d = ledger30d.data ?? buildEmptyPortfolioLedger();
    const safeLedger90d = ledger90d.data ?? buildEmptyPortfolioLedger();
    const safeLedger1y = ledger1y.data ?? buildEmptyPortfolioLedger();
    const safeLedgerAll = ledgerAll.data ?? buildEmptyPortfolioLedger();

    const dashboard: PortfolioDashboard = {
      summary: {
        currentValue: safeHistory7d.summary.currentValue,
        changeAmount: safeHistory7d.summary.deltaValue,
        changePercent: safeHistory7d.summary.deltaPercent ?? 0,
        asOfLabel: safeHistory7d.points.length > 0
          ? formatShortDate(safeHistory7d.points[safeHistory7d.points.length - 1]?.date ?? '')
          : 'Today',
      },
      inventoryCount: safeInventoryEntries.length,
      inventoryItems: safeInventoryEntries,
      recentSales: buildRecentSales(safeLedgerAll.transactions, this.baseUrl),
      ranges: {
        '7D': {
          portfolio: mapPortfolioSeries(safeHistory7d),
          sales: buildSalesSeries(safeLedger7d, '7D'),
        },
        '1M': {
          portfolio: mapPortfolioSeries(safeHistory1m),
          sales: buildSalesSeries(safeLedger30d, '1M'),
        },
        '3M': {
          portfolio: mapPortfolioSeries(safeHistory3m),
          sales: buildSalesSeries(safeLedger90d, '3M'),
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
    };

    const errorMessage = [
      inventoryResult,
      history7d,
      history1m,
      history3m,
      historyAll,
      ledger7d,
      ledger30d,
      ledger90d,
      ledgerAll,
    ].find((result) => result.state === 'error')?.errorMessage ?? null;

    if (errorMessage) {
      return buildLoadResult('error', dashboard, errorMessage);
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
    const response = await this.requestJson<{ entries?: DeckEntryDTO[] } | DeckEntryDTO[]>(
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

  async loadCatalogCards(query: string, limit = 20) {
    const normalized = query.trim();
    if (normalized.length < 2) {
      return buildLoadResult('empty', []);
    }

    const queryParams = new URLSearchParams({
      q: normalized,
      limit: String(Math.max(1, Math.min(limit, 50))),
    });
    const [searchResponse, inventoryResult] = await Promise.all([
      this.requestJson<SearchResultsDTO>(`${this.baseUrl}/api/v1/cards/search?${queryParams.toString()}`),
      this.loadInventoryEntries(),
    ]);

    if (searchResponse.kind !== 'success') {
      return buildLoadResult('error', [], searchResponse.error.message);
    }

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
          marketPrice: card.pricing.market,
          currencyCode: card.pricing.currencyCode,
          ownedQuantity: inventoryEntries
            .filter((entry: InventoryCardEntry) => entry.cardId === card.id)
            .reduce((sum: number, entry: InventoryCardEntry) => sum + entry.quantity, 0),
          isFavorite: card.isFavorite,
        }];
      });

    return buildLoadResult(results.length > 0 ? 'success' : 'empty', results);
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

  async matchScannerCapture(payload: ScannerCapturePayload) {
    const endpointPath = scannerMatchEndpointPath(payload);
    const startedAt = Date.now();
    const response = await this.requestJson<ScanMatchResponseDTO>(
      `${this.baseUrl}/${endpointPath}`,
      {
        body: JSON.stringify(createScannerMatchPayload(payload, this.clientContext ?? undefined)),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      {
        candidateStrategy: 'single_active',
        logTransport: true,
        requestLabel: endpointPath,
        timeoutMs: scanMatchRequestTimeoutMs,
      },
    );

    if (response.kind !== 'success') {
      throw response.error;
    }

    const roundTripMs = Date.now() - startedAt;
    const serverProcessingMs = normalizeNumber(response.data?.performance?.serverProcessingMs);

    return {
      scanID: normalizeString(response.data?.scanID),
      candidates: mapScannerMatchCandidates(response.data, this.baseUrl),
      endpointPath,
      reviewDisposition: normalizeString(response.data?.reviewDisposition),
      reviewReason: normalizeString(response.data?.reviewReason),
      requestAttemptCount: response.meta.attemptCount,
      requestUrl: response.meta.requestUrl,
      roundTripMs,
      serverProcessingMs,
    } satisfies ScannerMatchResult;
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

  async loadCardDetail(query: CardDetailQuery) {
    const detailQuery = buildDetailQueryParams(query);

    const detailUrl = `${this.baseUrl}/api/v1/cards/${query.cardId}${detailQuery.toString() ? `?${detailQuery.toString()}` : ''}`;
    const ebayQuery = new URLSearchParams(detailQuery);
    ebayQuery.set('limit', '5');
    const ebayUrl = `${this.baseUrl}/api/v1/cards/${query.cardId}/ebay-comps?${ebayQuery.toString()}`;
    const historyQuery = buildRawDefaultMarketHistoryQuery(query);
    const [detailResponse, inventoryResult, historyResponse] = await Promise.all([
      this.requestJson<CardDetailDTO>(detailUrl, undefined, { allowNotFound: true }),
      this.loadInventoryEntries(),
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
    const ebayResponse = await this.requestJson<EbayCompsDTO>(ebayUrl);
    const ebayListings = ebayResponse.kind === 'success'
      ? buildCardEbayListingsRecord(ebayResponse.data, card.pricing.currencyCode)
      : {
        status: 'unavailable' as const,
        statusReason: 'request_failed',
        unavailableReason: 'Could not load eBay listings right now.',
        searchUrl: null,
        listingCount: 0,
        listings: [],
      };

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
      marketPrice: card.pricing.market ?? marketHistory.currentPrice ?? 0,
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
      ebayListings,
      ownedEntries: (inventoryResult.data ?? []).filter((entry: InventoryCardEntry) => entry.cardId === query.cardId),
      variantOptions: marketHistory.availableVariants,
      isFavorite: normalizeBoolean(detailResponse.data.isFavorite) ?? card.isFavorite,
      favoritedAt: normalizeString(detailResponse.data.favoritedAt),
    };

    return buildLoadResult('success', detail);
  }

  async getCardDetail(query: CardDetailQuery) {
    const result = await this.loadCardDetail(query);
    if (result.state === 'error') {
      throw new SpotlightRepositoryRequestError(
        result.errorMessage ?? 'Could not load this card right now.',
        'request_failed',
      );
    }

    return result.data;
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
      historyQuery.set('condition', query.condition);
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

  async getCardEbayListings(query: CardDetailQuery & {
    limit?: number;
  }) {
    const ebayQuery = buildDetailQueryParams(query);
    ebayQuery.set('limit', String(Math.max(1, Math.min(query.limit ?? 5, 5))));
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
    return this.requestJsonOrThrow<InventoryEntryCreateResponsePayload>(`${this.baseUrl}/api/v1/deck/entries`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
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

  private async loadPortfolioHistory(range: keyof PortfolioDashboard['ranges']) {
    const queryParams = new URLSearchParams({
      range: mapRangeToBackend(range),
      timeZone: 'America/Los_Angeles',
    });
    const response = await this.requestJson<PortfolioHistoryDTO>(
      `${this.baseUrl}/api/v1/portfolio/history?${queryParams.toString()}`,
    );

    if (response.kind !== 'success') {
      return buildLoadResult('error', buildEmptyPortfolioHistory(), response.error.message);
    }

    const history = normalizePortfolioHistory(response.data);
    return buildLoadResult(history.points.length > 0 ? 'success' : 'empty', history);
  }

  private async loadPortfolioLedger(range: '1Y' | '30D' | '90D' | 'ALL' | '7D') {
    const queryParams = new URLSearchParams({
      range,
      timeZone: 'America/Los_Angeles',
      limit: '50',
      offset: '0',
    });
    const response = await this.requestJson<PortfolioLedgerDTO>(
      `${this.baseUrl}/api/v1/portfolio/ledger?${queryParams.toString()}`,
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
}
