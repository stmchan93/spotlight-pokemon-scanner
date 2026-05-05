import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconEdit,
  IconHeart,
  IconHeartFilled,
  IconMinus,
  IconPlus,
} from '@tabler/icons-react-native';
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import {
  deckConditionOptions,
  type CardDetailRecord,
  type CardRecentSalesRecord,
} from '@spotlight/api-client';
import { Button, SurfaceCard, useSpotlightTheme } from '@spotlight/design-system';

import { resolveConditionDisplayLabel } from '@/lib/condition-display';
import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  resolveActiveScanReviewCandidate,
  resolveSimilarScanCandidates,
} from '@/features/cards/screens/scan-candidate-review-screen';
import {
  cardDetailPreviewFromCatalogResult,
  cardDetailPreviewFromInventoryEntry,
  getCardDetailPreview,
} from '@/features/cards/card-detail-preview-session';
import {
  formatCurrency,
  formatOptionalCurrency,
  formatPercent,
  formatSignedCurrency,
} from '@/features/portfolio/components/portfolio-formatting';
import { collectionSummaryLine, slabGradeSummary } from '@/features/sell/sell-order-helpers';
import { SellBackdrop } from '@/features/sell/components/sell-ui';
import {
  getScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

function displayNumber(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '#--';
  }

  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function cleanedMarketplaceToken(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildTcgPlayerSearchUrl(params: {
  cardNumber: string;
  name: string;
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

const favoriteHeartColor = '#E83E8C';
const recentSalesPageSize = 25;

type CardDetailScreenProps = {
  cardId: string;
  entryId?: string;
  onBack: () => void;
  onOpenAddToCollection: (cardId: string, entryId?: string) => void;
  onOpenScanCandidateReview?: (scanReviewId: string) => void;
  onOpenSell?: (entryId: string) => void;
  previewId?: string;
  scanReviewId?: string;
};

function buildPath(points: { x: number; y: number }[]) {
  if (points.length === 0) {
    return '';
  }

  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function buildAreaPath(points: { x: number; y: number }[], baseline: number) {
  if (points.length === 0) {
    return '';
  }

  return `${buildPath(points)} L ${points[points.length - 1]?.x ?? 0} ${baseline} L ${points[0]?.x ?? 0} ${baseline} Z`;
}

function compactCurrency(value: number, currencyCode: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: value >= 10 ? 0 : 2,
    maximumFractionDigits: value >= 10 ? 0 : 2,
  }).format(value);
}

function ownedCollectionLabel(entry: CardDetailRecord['ownedEntries'][number]) {
  if (entry.kind === 'graded') {
    return collectionSummaryLine(entry);
  }

  const condition = resolveConditionDisplayLabel({
    conditionCode: entry.conditionCode,
    conditionLabel: entry.conditionLabel,
    conditionShortLabel: entry.conditionShortLabel,
  });
  return condition;
}

function normalizeMarketConditionId(value?: string | null) {
  const normalized = value?.trim().toLowerCase();

  switch (normalized) {
    case 'nm':
    case 'near mint':
    case 'near_mint':
      return 'near_mint';
    case 'lp':
    case 'lightly played':
    case 'lightly_played':
      return 'lightly_played';
    case 'mp':
    case 'moderately played':
    case 'moderately_played':
      return 'moderately_played';
    case 'hp':
    case 'heavily played':
    case 'heavily_played':
      return 'heavily_played';
    case 'd':
    case 'dmg':
    case 'damaged':
      return 'damaged';
    default:
      return null;
  }
}

function defaultMarketConditionId(history?: CardDetailRecord['marketHistory'] | null) {
  return normalizeMarketConditionId(history?.selectedCondition)
    ?? normalizeMarketConditionId(history?.availableConditions[0]?.id)
    ?? normalizeMarketConditionId(history?.availableConditions[0]?.label)
    ?? null;
}

function ChevronIcon({
  collapsed = false,
  testID,
}: {
  collapsed?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.chevronIconFrame} testID={testID}>
      <View style={[styles.chevronIconInner, collapsed ? styles.chevronCollapsed : undefined]}>
        <View style={[styles.chevronIconStem, styles.chevronIconStemLeft]} />
        <View style={[styles.chevronIconStem, styles.chevronIconStemRight]} />
      </View>
    </View>
  );
}

function TrashIcon() {
  return <IconMinus color="#4D4F57" size={16} strokeWidth={2.1} />;
}

function PlusIcon() {
  return <IconPlus color="#0F0F12" size={16} strokeWidth={2.1} />;
}

function EditIcon() {
  return <IconEdit color="#4D4F57" size={16} strokeWidth={1.9} />;
}

function SellEntryIcon() {
  return <Text style={styles.collectionSellButtonLabel}>$</Text>;
}

type ParsedListingDate = {
  day: number;
  month: number;
  sortKey: number;
  year: number;
};

function parseListingDate(value?: string | null): ParsedListingDate | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const yearFirstMatch = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T].*)?$/);
  if (yearFirstMatch) {
    const year = Number(yearFirstMatch[1]);
    const first = Number(yearFirstMatch[2]);
    const second = Number(yearFirstMatch[3]);
    let month = first;
    let day = second;

    if (month > 12 && day <= 12) {
      month = day;
      day = first;
    }

    if (
      Number.isInteger(year)
      && Number.isInteger(month)
      && Number.isInteger(day)
      && month >= 1
      && month <= 12
      && day >= 1
      && day <= 31
    ) {
      return {
        day,
        month,
        sortKey: Date.UTC(year, month - 1, day),
        year,
      };
    }
  }

  const monthFirstMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T].*)?$/);
  if (monthFirstMatch) {
    const month = Number(monthFirstMatch[1]);
    const day = Number(monthFirstMatch[2]);
    const year = Number(monthFirstMatch[3]);
    if (
      Number.isInteger(year)
      && Number.isInteger(month)
      && Number.isInteger(day)
      && month >= 1
      && month <= 12
      && day >= 1
      && day <= 31
    ) {
      return {
        day,
        month,
        sortKey: Date.UTC(year, month - 1, day),
        year,
      };
    }
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    sortKey: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    year: date.getUTCFullYear(),
  };
}

function formatListingDateLabel(value?: string | null) {
  const parsed = parseListingDate(value);
  if (!parsed) {
    return value?.trim() || null;
  }

  const month = String(parsed.month).padStart(2, '0');
  const day = String(parsed.day).padStart(2, '0');
  return `${month}/${day}/${parsed.year}`;
}

function compareRecentSalesBySoldDateDesc(
  left: CardRecentSalesRecord['sales'][number],
  right: CardRecentSalesRecord['sales'][number],
) {
  const leftParsed = parseListingDate(left.soldAt);
  const rightParsed = parseListingDate(right.soldAt);
  const leftTime = leftParsed?.sortKey ?? Number.NEGATIVE_INFINITY;
  const rightTime = rightParsed?.sortKey ?? Number.NEGATIVE_INFINITY;

  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  const leftPrice = left.priceAmount ?? Number.NEGATIVE_INFINITY;
  const rightPrice = right.priceAmount ?? Number.NEGATIVE_INFINITY;
  if (leftPrice !== rightPrice) {
    return rightPrice - leftPrice;
  }

  return left.title.localeCompare(right.title);
}

function formatRecentSalesAgeLabel(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  const timestamp = parsed.getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  if (!Number.isFinite(diffMs)) {
    return null;
  }
  if (diffMs < 60000) {
    return 'Updated now';
  }
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 60) {
    return `Updated ${minutes}m ago`;
  }
  const hours = Math.max(0, Math.floor(diffMs / 3600000));
  return `Updated ${hours}h ago`;
}

function recentSalesAgeHours(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  const timestamp = parsed.getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  if (!Number.isFinite(diffMs)) {
    return null;
  }
  return Math.max(0, Math.floor(diffMs / 3600000));
}

function recentSalesAgeBucket(value?: string | null) {
  const hours = recentSalesAgeHours(value);
  if (hours == null) {
    return 'none';
  }
  if (hours < 24) {
    return '<24h';
  }
  if (hours < 48) {
    return '24_47h';
  }
  return '48h_plus';
}

function recentSalesCountBucket(value?: number | null) {
  const count = typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
  if (count <= 0) {
    return '0';
  }
  if (count === 1) {
    return '1';
  }
  if (count <= 5) {
    return '2_5';
  }
  return '6_plus';
}

function recentSalesLatencyBucket(value: number) {
  if (value < 500) {
    return '<500';
  }
  if (value < 1500) {
    return '500_1500';
  }
  if (value < 5000) {
    return '1500_5000';
  }
  return '5000_plus';
}

function recentSalesSectionState(value: CardRecentSalesRecord | null) {
  if (!value || value.statusReason === 'not_loaded') {
    return 'not_loaded';
  }
  if (value.status === 'available' && value.sales.length > 0) {
    return 'available';
  }
  if (value.statusReason === 'no_results') {
    return 'no_results';
  }
  return 'unavailable';
}

function EbayWordmarkBadge() {
  return (
    <View style={styles.ebayBadge}>
      <Text accessibilityLabel="eBay" style={styles.ebayWordmark}>
        <Text style={styles.ebayRed}>e</Text>
        <Text style={styles.ebayBlue}>b</Text>
        <Text style={styles.ebayYellow}>a</Text>
        <Text style={styles.ebayGreen}>y</Text>
      </Text>
    </View>
  );
}

function SimilarCardsButton({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  const theme = useSpotlightTheme();
  const title = count === 1 ? '1 similar card found' : `${count} similar cards found`;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.similarCardsButton,
        pressed ? styles.similarCardsButtonPressed : null,
      ]}
      testID="detail-similar-cards-button"
    >
      <Text
        style={[theme.typography.bodyStrong, styles.similarCardsTitle]}
        testID="detail-similar-cards-title"
      >
        {title}
      </Text>

      <Text style={styles.similarCardsChevron}>›</Text>
    </Pressable>
  );
}

function HistoryChart({
  currencyCode,
  currentPrice,
  points,
  tintColor,
}: {
  currencyCode: string;
  currentPrice: number;
  points: CardDetailRecord['marketHistory']['points'];
  tintColor: string;
}) {
  const theme = useSpotlightTheme();
  const width = 320;
  const height = 210;
  const paddingLeft = 56;
  const paddingRight = 16;
  const paddingTop = 16;
  const paddingBottom = 30;

  if (points.length === 0) {
    return (
      <View style={styles.lazyMarketBlock} testID="detail-scan-preview-market">
        <Text style={styles.previewMarketValue}>
          {formatCurrency(currentPrice, currencyCode)}
        </Text>
      </View>
    );
  }

  const rawValues = [...points.map((point) => point.value), currentPrice];
  const minValue = Math.max(0, Math.min(...rawValues));
  const maxValue = Math.max(...rawValues);
  const minimumVisiblePadding = maxValue >= 1 ? 0.1 : 0.02;
  const paddingValue = Math.max((maxValue - minValue) * 0.18, maxValue * 0.06, minimumVisiblePadding);
  const chartMin = Math.max(0, minValue - paddingValue);
  const chartMax = maxValue + paddingValue;
  const chartRange = Math.max(chartMax - chartMin, minimumVisiblePadding);
  const chartWidth = width - paddingLeft - paddingRight;
  const baseline = height - paddingBottom;
  const gridValues = Array.from({ length: 4 }, (_, index) => chartMax - (chartRange / 3) * index);

  const plottedPoints = points.map((point, index) => {
    const normalized = (point.value - chartMin) / chartRange;
    return {
      x: paddingLeft + (chartWidth * index) / Math.max(points.length - 1, 1),
      y: baseline - normalized * (baseline - paddingTop),
    };
  });

  const linePath = buildPath(plottedPoints);
  const areaPath = buildAreaPath(plottedPoints, baseline);
  const lastPoint = plottedPoints[plottedPoints.length - 1] ?? null;

  return (
    <View style={styles.chartContainer}>
      <View style={styles.chartFrame}>
        {gridValues.map((value, index) => (
          <View key={`${value}-${index}`} style={styles.chartGridRow}>
            <Text
              style={[theme.typography.micro, styles.chartGridLabel]}
              testID={`detail-market-grid-label-${index}`}
            >
              {compactCurrency(value, currencyCode)}
            </Text>
            <View style={styles.chartGridLine} />
          </View>
        ))}

        <Svg height="100%" style={styles.chartSvg} viewBox={`0 0 ${width} ${height}`} width="100%">
          <Defs>
            <LinearGradient id="detailChartFill" x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0" stopColor={tintColor} stopOpacity="0.34" />
              <Stop offset="1" stopColor={tintColor} stopOpacity="0.02" />
            </LinearGradient>
          </Defs>
          <Path d={areaPath} fill="url(#detailChartFill)" />
          <Path
            d={linePath}
            fill="none"
            stroke={tintColor}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.8}
          />
          {lastPoint ? <Circle cx={lastPoint.x} cy={lastPoint.y} fill={tintColor} r={4.5} /> : null}
        </Svg>
      </View>

      <View style={styles.chartAxisRow}>
        <Text style={[theme.typography.micro, styles.chartAxisText]}>{points[0]?.shortLabel}</Text>
        <Text style={[theme.typography.micro, styles.chartAxisText]}>{points[points.length - 1]?.shortLabel}</Text>
      </View>
    </View>
  );
}

export function CardDetailScreen({
  cardId,
  entryId,
  onBack,
  onOpenAddToCollection,
  onOpenScanCandidateReview,
  onOpenSell,
  previewId,
  scanReviewId,
}: CardDetailScreenProps) {
  const theme = useSpotlightTheme();
  const {
    spotlightRepository,
    dataVersion,
    refreshData,
    inventoryEntriesCache,
    portfolioDashboardCache,
  } = useAppServices();
  const [detail, setDetail] = useState<CardDetailRecord | null>(null);
  const [marketHistory, setMarketHistory] = useState<CardDetailRecord['marketHistory'] | null>(null);
  const [recentSalesState, setRecentSalesState] = useState<CardRecentSalesRecord | null>(null);
  const [recentSalesErrorMessage, setRecentSalesErrorMessage] = useState<string | null>(null);
  const [isRecentSalesLoading, setIsRecentSalesLoading] = useState(false);
  const [hasResolvedRecentSalesState, setHasResolvedRecentSalesState] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCollectionExpanded, setIsCollectionExpanded] = useState(true);
  const [selectedConditionId, setSelectedConditionId] = useState<string | null>(null);
  const [inventoryActionError, setInventoryActionError] = useState<string | null>(null);
  const [isAdjustingInventory, setIsAdjustingInventory] = useState(false);
  const [isFavoritePending, setIsFavoritePending] = useState(false);
  const scanReviewSession = useMemo(
    () => getScanCandidateReviewSession(scanReviewId),
    [scanReviewId],
  );
  const closestScanCandidate = useMemo(
    () => resolveActiveScanReviewCandidate(scanReviewSession, cardId),
    [cardId, scanReviewSession],
  );
  const similarScanCandidates = useMemo(
    () => resolveSimilarScanCandidates(scanReviewSession, closestScanCandidate?.cardId ?? cardId),
    [cardId, closestScanCandidate?.cardId, scanReviewSession],
  );
  const scanPreviewCandidate = useMemo(() => {
    return scanReviewSession?.candidates.find((candidate) => candidate.cardId === cardId) ?? null;
  }, [cardId, scanReviewSession]);
  const scanDetailPreview = useMemo(() => {
    return scanPreviewCandidate ? cardDetailPreviewFromCatalogResult(scanPreviewCandidate) : null;
  }, [scanPreviewCandidate]);
  const savedDetailPreview = useMemo(() => {
    const preview = getCardDetailPreview(previewId);
    return preview?.cardId === cardId ? preview : null;
  }, [cardId, previewId]);
  const dashboardDetailPreview = useMemo(() => {
    const inventoryEntry = (inventoryEntriesCache ?? portfolioDashboardCache?.inventoryItems)?.find((entry) => (
      entryId ? entry.id === entryId : entry.cardId === cardId
    ));

    return inventoryEntry ? cardDetailPreviewFromInventoryEntry(inventoryEntry) : null;
  }, [cardId, entryId, inventoryEntriesCache, portfolioDashboardCache]);
  const detailPreview = scanDetailPreview ?? savedDetailPreview ?? dashboardDetailPreview;

  useEffect(() => {
    let cancelled = false;
    setDetail((currentDetail) => (currentDetail?.cardId === cardId ? currentDetail : null));
    setErrorMessage(null);

    void spotlightRepository.getCardDetail({ cardId })
      .then((nextDetail) => {
        if (cancelled) {
          return;
        }

        if (!nextDetail) {
          setDetail(null);
          setSelectedConditionId(null);
          setErrorMessage('We could not find this card in the local catalog.');
          return;
        }

        setDetail(nextDetail);
        setInventoryActionError(null);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setErrorMessage('Could not load this card right now.');
      });

    return () => {
      cancelled = true;
    };
  }, [cardId, dataVersion, spotlightRepository]);

  useEffect(() => {
    setSelectedConditionId(null);
    setMarketHistory(null);
  }, [cardId]);

  const selectedEntry = useMemo(() => {
    if (!detail) {
      const previewEntry = detailPreview?.ownedEntry ?? null;
      if (!previewEntry) {
        return null;
      }

      return !entryId || previewEntry.id === entryId ? previewEntry : null;
    }

    return detail.ownedEntries.find((entry) => entry.id === entryId) ?? detail.ownedEntries[0] ?? null;
  }, [detail, detailPreview?.ownedEntry, entryId]);

  const ownedEntries = useMemo(() => {
    if (!detail) {
      return selectedEntry ? [selectedEntry] : [];
    }

    if (!selectedEntry) {
      return detail.ownedEntries;
    }

    return [
      selectedEntry,
      ...detail.ownedEntries.filter((entry) => entry.id !== selectedEntry.id),
    ];
  }, [detail, selectedEntry]);

  const selectedSlabContext = selectedEntry?.slabContext ?? scanReviewSession?.slabContext ?? null;
  const shouldShowRecentSales = selectedEntry?.kind === 'graded' || selectedSlabContext != null;
  const trackedRecentSalesSectionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedSlabContext != null || selectedConditionId != null) {
      return;
    }

    const nextConditionId = defaultMarketConditionId(detail?.marketHistory ?? null);
    if (nextConditionId) {
      setSelectedConditionId(nextConditionId);
    }
  }, [detail?.marketHistory, selectedConditionId, selectedSlabContext]);

  useEffect(() => {
    let cancelled = false;
    const requestedCondition = selectedSlabContext == null
      ? (
        selectedConditionId
        ?? defaultMarketConditionId(detail?.marketHistory ?? null)
        ?? 'near_mint'
      )
      : null;

    void spotlightRepository.getCardMarketHistory({
      cardId,
      days: 30,
      condition: requestedCondition,
      slabContext: selectedSlabContext,
      variant: selectedSlabContext?.variantName ?? undefined,
    })
      .then((nextHistory) => {
        if (!cancelled) {
          setMarketHistory(nextHistory);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMarketHistory(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cardId, dataVersion, detail?.marketHistory, selectedConditionId, selectedSlabContext, spotlightRepository]);

  const loadRecentSales = useCallback(async (requestMode: 'load' | 'refresh') => {
    if (!shouldShowRecentSales || !selectedSlabContext) {
      return;
    }
    const startedAt = Date.now();
    if (requestMode === 'refresh') {
      capturePostHogEvent('card_recent_sales_refresh_tapped', {
        cache_age_bucket: recentSalesAgeBucket(recentSalesState?.fetchedAt),
        detail_kind: 'slab',
        sale_count_bucket: recentSalesCountBucket(recentSalesState?.saleCount ?? recentSalesState?.sales.length ?? 0),
        sales_provider: 'scrydex',
        sales_source: 'ebay',
      });
    } else {
      capturePostHogEvent('card_recent_sales_load_tapped', {
        detail_kind: 'slab',
        sales_provider: 'scrydex',
        sales_source: 'ebay',
      });
    }
    setIsRecentSalesLoading(true);
    setRecentSalesErrorMessage(null);
    try {
      const nextRecentSales = await spotlightRepository.getCardRecentSales({
        cardId,
        limit: recentSalesPageSize,
        refresh: true,
        slabContext: selectedSlabContext,
        source: 'ebay',
      });
      setRecentSalesState(nextRecentSales);
      setHasResolvedRecentSalesState(true);
      capturePostHogEvent('card_recent_sales_request_completed', {
        can_refresh: Boolean(nextRecentSales?.canRefresh),
        detail_kind: 'slab',
        latency_ms_bucket: recentSalesLatencyBucket(Date.now() - startedAt),
        request_mode: requestMode,
        result: nextRecentSales?.status === 'available'
          ? 'available'
          : nextRecentSales?.statusReason === 'no_results'
            ? 'no_results'
            : 'unavailable',
        sale_count_bucket: recentSalesCountBucket(nextRecentSales?.saleCount ?? nextRecentSales?.sales.length ?? 0),
        sales_provider: 'scrydex',
        sales_source: 'ebay',
      });
    } catch {
      setRecentSalesErrorMessage('Could not load recent eBay sales right now.');
      setHasResolvedRecentSalesState(true);
      capturePostHogEvent('card_recent_sales_request_completed', {
        detail_kind: 'slab',
        latency_ms_bucket: recentSalesLatencyBucket(Date.now() - startedAt),
        request_mode: requestMode,
        result: 'failed',
        sales_provider: 'scrydex',
        sales_source: 'ebay',
      });
    } finally {
      setIsRecentSalesLoading(false);
    }
  }, [cardId, recentSalesState?.fetchedAt, recentSalesState?.saleCount, recentSalesState?.sales.length, recentSalesState?.canRefresh, selectedSlabContext, shouldShowRecentSales, spotlightRepository]);

  useEffect(() => {
    let cancelled = false;
    setRecentSalesState(null);
    setRecentSalesErrorMessage(null);
    setIsRecentSalesLoading(false);
    setHasResolvedRecentSalesState(false);

    if (!shouldShowRecentSales || !selectedSlabContext) {
      return () => {
        cancelled = true;
      };
    }

    setIsRecentSalesLoading(true);
    void spotlightRepository.getCardRecentSales({
      cardId,
      limit: recentSalesPageSize,
      slabContext: selectedSlabContext,
      source: 'ebay',
    })
      .then((nextRecentSales) => {
        if (!cancelled) {
          setRecentSalesState(nextRecentSales);
          setHasResolvedRecentSalesState(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecentSalesErrorMessage('Could not load recent eBay sales right now.');
          setHasResolvedRecentSalesState(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsRecentSalesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    cardId,
    dataVersion,
    selectedSlabContext,
    shouldShowRecentSales,
    spotlightRepository,
  ]);

  useEffect(() => {
    if (!shouldShowRecentSales || !selectedSlabContext) {
      trackedRecentSalesSectionKeyRef.current = null;
      return;
    }

    if (!hasResolvedRecentSalesState) {
      return;
    }

    const sectionKey = [
      cardId,
      selectedSlabContext.grader ?? '',
      selectedSlabContext.grade ?? '',
      selectedSlabContext.certNumber ?? '',
      selectedSlabContext.variantName ?? '',
    ].join(':');

    if (trackedRecentSalesSectionKeyRef.current === sectionKey) {
      return;
    }

    trackedRecentSalesSectionKeyRef.current = sectionKey;
    capturePostHogEvent('card_recent_sales_section_viewed', {
      can_refresh: Boolean(recentSalesState?.canRefresh),
      detail_kind: 'slab',
      sale_count_bucket: recentSalesCountBucket(recentSalesState?.saleCount ?? recentSalesState?.sales.length ?? 0),
      sales_provider: 'scrydex',
      sales_source: 'ebay',
      section_state: recentSalesSectionState(recentSalesState),
    });
  }, [cardId, hasResolvedRecentSalesState, recentSalesState, selectedSlabContext, shouldShowRecentSales]);

  const effectiveMarketHistory = marketHistory ?? detail?.marketHistory ?? null;
  const isSlabDetail = selectedSlabContext != null;
  const slabDisplayedPrice = isSlabDetail
    ? (
      selectedEntry?.kind === 'graded'
        ? (selectedEntry.hasMarketPrice ? selectedEntry.marketPrice : null)
        : (detailPreview?.marketPrice ?? null)
    )
    : null;

  useEffect(() => {
    if (isSlabDetail || !effectiveMarketHistory || selectedConditionId != null) {
      return;
    }

    const nextConditionId = defaultMarketConditionId(effectiveMarketHistory);
    if (nextConditionId) {
      setSelectedConditionId(nextConditionId);
    }
  }, [effectiveMarketHistory, isSlabDetail, selectedConditionId]);

  const marketConditionOptions = useMemo(() => {
    if (!effectiveMarketHistory) {
      return [];
    }

    return deckConditionOptions.map((option) => {
      const matchingCondition = effectiveMarketHistory.availableConditions.find((condition) => (
        normalizeMarketConditionId(condition.id) === option.code
        || normalizeMarketConditionId(condition.label) === option.code
      ));
      return {
        currentPrice: matchingCondition?.currentPrice ?? null,
        id: option.code,
        isAvailable: matchingCondition?.currentPrice != null,
        label: option.label,
        shortLabel: option.shortLabel,
      };
    });
  }, [effectiveMarketHistory]);

  const selectedCondition = useMemo(() => {
    if (!effectiveMarketHistory) {
      return null;
    }

    return marketConditionOptions.find((condition) => condition.id === selectedConditionId && condition.isAvailable)
      ?? marketConditionOptions.find((condition) => condition.isAvailable)
      ?? null;
  }, [effectiveMarketHistory, marketConditionOptions, selectedConditionId]);

  const marketTint = useMemo(() => {
    if (!effectiveMarketHistory) {
      return theme.colors.brand;
    }

    const monthInsight = effectiveMarketHistory.insights.find((insight) => insight.id === 'month');
    return (monthInsight?.deltaAmount ?? 0) >= 0 ? theme.colors.success : theme.colors.danger;
  }, [effectiveMarketHistory, theme.colors.brand, theme.colors.danger, theme.colors.success]);
  const recentSales = shouldShowRecentSales ? recentSalesState : null;
  const sortedRecentSales = useMemo(
    () => recentSales?.sales.slice().sort(compareRecentSalesBySoldDateDesc) ?? [],
    [recentSales?.sales],
  );

  const handleDecrementCollection = (entry: CardDetailRecord['ownedEntries'][number]) => {
    if (isAdjustingInventory) {
      return;
    }

    setIsAdjustingInventory(true);
    setInventoryActionError(null);

    void spotlightRepository.createPortfolioSale({
      deckEntryID: entry.id,
      cardID: entry.cardId,
      slabContext: entry.slabContext ?? null,
      quantity: 1,
      unitPrice: 0,
      currencyCode: entry.currencyCode,
      paymentMethod: null,
      soldAt: new Date().toISOString(),
      showSessionID: null,
      note: 'Inventory decrement from card detail trash control.',
      sourceScanID: null,
      saleSource: 'inventory_adjustment',
    })
      .then((sale) => {
        setDetail((currentDetail) => {
          if (!currentDetail) {
            return currentDetail;
          }

          return {
            ...currentDetail,
            ownedEntries: currentDetail.ownedEntries.flatMap((ownedEntry) => {
              if (ownedEntry.id !== sale.deckEntryID) {
                return [ownedEntry];
              }

              if (sale.remainingQuantity <= 0) {
                return [];
              }

              return [{
                ...ownedEntry,
                costBasisTotal: ownedEntry.costBasisPerUnit
                  ? Number((ownedEntry.costBasisPerUnit * sale.remainingQuantity).toFixed(2))
                  : ownedEntry.costBasisTotal,
                quantity: sale.remainingQuantity,
              }];
            }),
          };
        });
        refreshData();
      })
      .catch(() => {
        setInventoryActionError('Could not update this inventory row right now.');
      })
      .finally(() => {
        setIsAdjustingInventory(false);
      });
  };

  const handleToggleFavorite = useCallback(() => {
    if (isFavoritePending) {
      return;
    }

    setIsFavoritePending(true);
    const nextFavoriteState = !(detail?.isFavorite ?? false);

    void spotlightRepository.setCardFavorite(cardId, nextFavoriteState)
      .then((favoriteState) => {
        setDetail((currentDetail) => {
          if (!currentDetail) {
            return currentDetail;
          }

          return {
            ...currentDetail,
            favoritedAt: favoriteState.favoritedAt ?? null,
            isFavorite: favoriteState.isFavorite,
          };
        });
        refreshData();
      })
      .catch(() => {
        setErrorMessage('Could not update favorite right now.');
      })
      .finally(() => {
        setIsFavoritePending(false);
      });
  }, [cardId, detail?.isFavorite, isFavoritePending, refreshData, spotlightRepository]);

  const hasDisplayContent = detail != null || detailPreview != null;

  if (!hasDisplayContent && !errorMessage) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Loading card...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasDisplayContent) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Card unavailable</Text>
          <Text style={[theme.typography.body, styles.errorCopy]}>{errorMessage}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const displayName = detail?.name ?? detailPreview?.name ?? '';
  const displayImageUrl = detail?.largeImageUrl
    ?? detail?.imageUrl
    ?? detailPreview?.largeImageUrl
    ?? detailPreview?.imageUrl
    ?? null;
  const displayedPrice = isSlabDetail
    ? (slabDisplayedPrice ?? effectiveMarketHistory?.currentPrice)
    : (
      selectedCondition?.currentPrice
      ?? effectiveMarketHistory?.currentPrice
      ?? detail?.marketPrice
      ?? detailPreview?.marketPrice
      ?? 0
    );
  const displayCurrencyCode = isSlabDetail
    ? (effectiveMarketHistory?.currencyCode ?? selectedEntry?.currencyCode ?? detailPreview?.currencyCode ?? detail?.currencyCode ?? 'USD')
    : (detail?.currencyCode ?? detailPreview?.currencyCode ?? 'USD');
  const isOwned = selectedEntry != null;
  const heroMeta = detail
    ? `${displayNumber(detail.cardNumber)} • ${detail.setName}`
    : `${detailPreview ? displayNumber(detailPreview.cardNumber) : '#--'} • ${detailPreview?.setName ?? ''}`;
  const slabHeroSubtitle = slabGradeSummary(selectedSlabContext);
  const displayCardNumber = detail?.cardNumber ?? detailPreview?.cardNumber ?? '';
  const displaySetName = detail?.setName ?? detailPreview?.setName ?? '';
  const isFavorite = detail?.isFavorite ?? false;
  const recentSalesUpdatedLabel = formatRecentSalesAgeLabel(recentSales?.fetchedAt);
  const shouldShowRecentSalesLoad = recentSales == null || recentSales.statusReason === 'not_loaded';
  const shouldShowRecentSalesRefresh = Boolean(recentSales?.canRefresh);
  const ownedCopiesCount = ownedEntries.reduce((sum, entry) => sum + Math.max(0, entry.quantity), 0);
  const hasSingleOwnedEntry = ownedEntries.length === 1;
  const collectionTitle = ownedCopiesCount > 1
    ? `In your collection (${ownedCopiesCount})`
    : 'In your collection';
  const marketplaceUrl = detail?.marketplaceUrl ?? buildTcgPlayerSearchUrl({
    cardNumber: displayCardNumber,
    name: displayName,
    setName: displaySetName,
  });
  const marketplaceLabel = detail?.marketplaceLabel ?? 'TCGPLAYER BUYING OPTIONS';
  const sellEntryId = selectedEntry?.id ?? entryId;
  const hasMarketHistoryPoints = (effectiveMarketHistory?.points.length ?? 0) > 0;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <SellBackdrop imageUrl={displayImageUrl ?? undefined} variant="single" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ChromeBackButton
          onPress={onBack}
          style={styles.backPlate}
          testID="detail-back"
        />

        <View testID="detail-hero-card">
          <SurfaceCard padding={20} radius={28} style={styles.heroCard}>
            <View style={styles.heroCopy}>
              <Text style={[theme.typography.display, styles.heroName]}>{displayName}</Text>
              {slabHeroSubtitle ? (
                <Text
                  style={[theme.typography.bodyStrong, styles.heroSubtitle, { color: theme.colors.textSecondary }]}
                  testID="detail-hero-slab-meta"
                >
                  {slabHeroSubtitle}
                </Text>
              ) : null}
              <Text
                style={[theme.typography.bodyStrong, styles.heroSubtitle, { color: theme.colors.textSecondary }]}
                testID="detail-hero-meta"
              >
                {heroMeta}
              </Text>
            </View>

            <View style={styles.heroArtStage}>
              {displayImageUrl ? (
                <Image
                  source={{ uri: displayImageUrl }}
                  style={styles.heroArt}
                />
              ) : (
                <View style={styles.heroArtFallback}>
                  <Text style={[theme.typography.titleCompact, styles.heroArtFallbackText]}>{displayName}</Text>
                </View>
              )}
            </View>
          </SurfaceCard>
        </View>

        <View style={styles.actionStack} testID="detail-action-stack">
          {isOwned && hasSingleOwnedEntry ? (
            <Button
              contentStyle={styles.primaryButtonContent}
              disabled={!onOpenSell || !sellEntryId}
              label="SELL CARD"
              labelStyle={styles.primaryButtonLabel}
              onPress={() => {
                if (sellEntryId && onOpenSell) {
                  onOpenSell(sellEntryId);
                }
              }}
              size="lg"
              testID="detail-sell-card"
              variant="primary"
            />
          ) : !isOwned ? (
            <Button
              contentStyle={styles.primaryButtonContent}
              label="ADD TO COLLECTION"
              labelStyle={styles.primaryButtonLabel}
              onPress={() => onOpenAddToCollection(detail?.cardId ?? cardId)}
              size="lg"
              testID="detail-add-to-collection"
              variant="primary"
            />
          ) : null}

          <Button
            contentStyle={styles.marketplaceButtonContent}
            disabled={!marketplaceUrl}
            label={marketplaceLabel}
            labelStyle={styles.marketplaceButtonLabel}
            onPress={marketplaceUrl
              ? () => {
                  void Linking.openURL(marketplaceUrl);
                }
              : undefined}
            size="lg"
            style={styles.marketplaceAction}
            testID="detail-marketplace-cta"
            trailingAccessory={(
              <Image
                source={require('../../../../assets/images/tcgplayer-icon.png')}
                style={styles.marketplaceIcon}
                testID="detail-marketplace-icon"
              />
            )}
            variant="secondary"
          />

          <Button
            contentStyle={styles.favoriteButtonContent}
            disabled={isFavoritePending}
            label={isFavorite ? 'FAVORITED' : 'FAVORITE CARD'}
            labelStyle={styles.favoriteButtonLabel}
            leadingAccessory={isFavorite
              ? <IconHeartFilled color={favoriteHeartColor} size={18} />
              : <IconHeart color={favoriteHeartColor} size={18} strokeWidth={2} />}
            onPress={handleToggleFavorite}
            size="lg"
            testID="detail-favorite-card"
            variant="secondary"
          />

          {similarScanCandidates.length > 0 ? (
            <SimilarCardsButton
              count={similarScanCandidates.length}
              onPress={() => {
                if (scanReviewId) {
                  onOpenScanCandidateReview?.(scanReviewId);
                }
              }}
            />
          ) : null}
        </View>

        {selectedEntry ? (
          <View style={styles.section}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setIsCollectionExpanded((current) => !current)}
              style={styles.sectionHeader}
              testID="detail-collection-header-toggle"
            >
              <View style={styles.sectionHeaderButtonRow}>
                <Text style={[theme.typography.title, styles.sectionHeaderTitle]} testID="detail-collection-header-label">
                  {collectionTitle}
                </Text>
                <View style={styles.sectionHeaderChevronInline} testID="detail-collection-chevron-slot">
                  <ChevronIcon
                    collapsed={!isCollectionExpanded}
                    testID="detail-collection-chevron-glyph"
                  />
                </View>
              </View>
            </Pressable>

            {isCollectionExpanded ? (
              <View style={styles.collectionList} testID="detail-collection-card">
                {ownedEntries.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 ? (
                      <View
                        style={[
                          styles.collectionDivider,
                          { backgroundColor: theme.colors.outlineSubtle },
                        ]}
                        testID={`detail-collection-divider-${index}`}
                      />
                    ) : null}

                    <View style={styles.collectionRow} testID={`detail-collection-row-${entry.id}`}>
                      <View style={styles.collectionArtPlate}>
                        <Image
                          source={{ uri: entry.imageUrl }}
                          style={styles.collectionArt}
                          testID={`detail-collection-art-${entry.id}`}
                        />
                      </View>

                      <View style={styles.collectionBody}>
                        <View style={styles.collectionTopRow}>
                          <Text
                            numberOfLines={1}
                            style={[theme.typography.bodyStrong, styles.collectionSummary]}
                            testID={`detail-collection-summary-${entry.id}`}
                          >
                            {ownedCollectionLabel(entry)}
                          </Text>
                        </View>

                        <Text numberOfLines={2} style={[theme.typography.caption, styles.collectionMeta]}>
                          {entry.setName}
                        </Text>

                        <Text
                          style={[theme.typography.bodyStrong, styles.collectionPrice]}
                          testID={`detail-collection-price-${entry.id}`}
                        >
                          {formatOptionalCurrency(
                            entry.hasMarketPrice ? entry.marketPrice : null,
                            entry.currencyCode,
                          )}
                        </Text>
                      </View>

                      <View style={styles.collectionActionsRow}>
                        <View style={styles.collectionControlPill} testID={`detail-collection-controls-${entry.id}`}>
                          <Pressable
                            accessibilityLabel="Remove one from collection"
                            accessibilityRole="button"
                            disabled={isAdjustingInventory}
                            onPress={() => handleDecrementCollection(entry)}
                            style={({ pressed }) => [
                              styles.collectionControlIconButton,
                              {
                                opacity: isAdjustingInventory ? 0.42 : pressed ? 0.7 : 1,
                              },
                            ]}
                            testID={`detail-collection-decrement-${entry.id}`}
                          >
                            <TrashIcon />
                          </Pressable>

                          <Text
                            style={[theme.typography.bodyStrong, styles.collectionControlQuantity]}
                            testID={`detail-collection-quantity-${entry.id}`}
                          >
                            {entry.quantity}
                          </Text>

                          <Pressable
                            accessibilityLabel="Add to collection"
                            accessibilityRole="button"
                            onPress={() => onOpenAddToCollection(selectedEntry.cardId)}
                            style={({ pressed }) => [
                              styles.collectionControlIconButton,
                              {
                                opacity: pressed ? 0.7 : 1,
                              },
                            ]}
                          >
                            <PlusIcon />
                          </Pressable>
                        </View>

                        <View style={styles.collectionSecondaryActions}>
                          <Pressable
                            accessibilityLabel="Edit collection item"
                            accessibilityRole="button"
                            onPress={() => onOpenAddToCollection(selectedEntry.cardId, entry.id)}
                            style={({ pressed }) => [
                              styles.collectionEditButton,
                              {
                                opacity: pressed ? 0.72 : 1,
                              },
                            ]}
                            testID={`detail-collection-edit-${entry.id}`}
                          >
                            <EditIcon />
                          </Pressable>

                          <Pressable
                            accessibilityLabel="Sell collection item"
                            accessibilityRole="button"
                            disabled={!onOpenSell}
                            onPress={() => {
                              if (onOpenSell) {
                                onOpenSell(entry.id);
                              }
                            }}
                            style={({ pressed }) => [
                              styles.collectionSellButton,
                              {
                                opacity: !onOpenSell ? 0.42 : pressed ? 0.72 : 1,
                              },
                            ]}
                            testID={`detail-collection-sell-${entry.id}`}
                          >
                            <SellEntryIcon />
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  </View>
                ))}

                {inventoryActionError ? (
                  <Text style={[theme.typography.caption, styles.inventoryActionError, { color: theme.colors.danger }]}>
                    {inventoryActionError}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.section}>
          <View style={styles.marketHeader}>
            <Text style={[theme.typography.headline, styles.marketHeaderTitle]} testID="detail-market-header-label">
              Market value
            </Text>
          </View>

          <View testID="detail-market-card">
            <SurfaceCard padding={18} radius={24} style={styles.marketCard}>
              {hasMarketHistoryPoints && effectiveMarketHistory ? (
                <>
                  <Text
                    style={[theme.typography.display, styles.marketValueTitle]}
                    testID="detail-market-price"
                  >
                    {formatOptionalCurrency(displayedPrice, displayCurrencyCode)}
                  </Text>
                  <View style={styles.insightsRow}>
                    {effectiveMarketHistory.insights.map((insight) => (
                      <View key={insight.id} style={styles.insightBlock}>
                        {insight.deltaAmount != null ? (
                          <Text
                            style={[
                              theme.typography.caption,
                              { color: (insight.deltaAmount ?? 0) >= 0 ? theme.colors.success : theme.colors.danger },
                            ]}
                          >
                            {formatSignedCurrency(insight.deltaAmount, displayCurrencyCode)}
                            {' '}
                            ({formatPercent(insight.deltaPercent ?? 0)})
                          </Text>
                        ) : (
                          <Text style={[theme.typography.caption, styles.insightMuted]}>—</Text>
                        )}
                        <Text style={[theme.typography.micro, styles.insightLabel]}>{insight.label}</Text>
                      </View>
                    ))}
                  </View>

                  <HistoryChart
                    currencyCode={displayCurrencyCode}
                    currentPrice={displayedPrice ?? 0}
                    points={effectiveMarketHistory.points}
                    tintColor={marketTint}
                  />
                </>
              ) : (
                <View style={styles.lazyMarketBlock} testID="detail-scan-preview-market">
                  <Text style={styles.previewMarketValue} testID="detail-market-price">
                    {formatOptionalCurrency(displayedPrice, displayCurrencyCode)}
                  </Text>
                  {errorMessage ? (
                    <Text style={[theme.typography.caption, styles.lazyDetailCopy]}>
                      {errorMessage}
                    </Text>
                  ) : null}
                </View>
              )}

              {!isSlabDetail && marketConditionOptions.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.conditionChipRow}
                  testID="detail-condition-chip-scroll"
                >
                  {marketConditionOptions.map((condition) => {
                    const isSelected = condition.id === selectedCondition?.id;

                    return (
                      <Pressable
                        key={condition.id}
                        accessibilityRole="button"
                        disabled={!condition.isAvailable}
                        onPress={() => {
                          if (condition.isAvailable) {
                            setSelectedConditionId(condition.id);
                          }
                        }}
                        style={({ pressed }) => [
                          styles.conditionChip,
                          {
                            backgroundColor: isSelected ? theme.colors.surfaceMuted : '#F7F8FA',
                            borderColor: isSelected ? theme.colors.brand : 'rgba(15, 15, 18, 0.08)',
                            opacity: condition.isAvailable ? (pressed ? 0.92 : 1) : 0.56,
                          },
                        ]}
                        testID={`detail-condition-chip-${condition.id}`}
                      >
                        <Text style={[theme.typography.caption, styles.conditionLabel]}>
                          {condition.shortLabel}
                        </Text>
                        <Text style={[theme.typography.bodyStrong, styles.conditionPrice]}>
                          {condition.currentPrice != null
                            ? formatCurrency(condition.currentPrice, displayCurrencyCode)
                            : '—'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}
            </SurfaceCard>
          </View>
        </View>

        {shouldShowRecentSales ? (
          <View style={styles.section}>
            <View style={styles.marketHeader}>
              <Text style={[theme.typography.headline, styles.marketHeaderTitle]} testID="detail-recent-sales-header-label">
                Recent Sales
              </Text>
            </View>

            <View testID="detail-recent-sales-card">
              <SurfaceCard padding={18} radius={24} style={styles.marketCard}>
                {recentSalesUpdatedLabel ? (
                  <Text style={[theme.typography.caption, styles.marketTimestamp]} testID="detail-recent-sales-updated">
                    {recentSalesUpdatedLabel}
                  </Text>
                ) : null}

                {recentSales?.status === 'available' && sortedRecentSales.length > 0 ? (
                  <>
                    <ScrollView
                      contentContainerStyle={styles.ebayList}
                      nestedScrollEnabled
                      showsVerticalScrollIndicator={sortedRecentSales.length > 5}
                      style={styles.ebayListScroll}
                      testID="detail-recent-sales-list"
                    >
                      {sortedRecentSales.map((sale, index) => {
                        const soldDateLabel = formatListingDateLabel(sale.soldAt);

                        return (
                          <Pressable
                            key={sale.id}
                            accessibilityRole={sale.saleUrl ? 'button' : undefined}
                            disabled={!sale.saleUrl}
                            onPress={() => {
                              if (sale.saleUrl) {
                                capturePostHogEvent('card_recent_sales_row_opened', {
                                  detail_kind: 'slab',
                                  row_index: index,
                                  sale_count_bucket: recentSalesCountBucket(recentSales?.saleCount ?? recentSales?.sales.length ?? 0),
                                  sales_provider: 'scrydex',
                                  sales_source: 'ebay',
                                });
                                void Linking.openURL(sale.saleUrl);
                              }
                            }}
                            style={({ pressed }) => [
                              styles.ebayRow,
                              {
                                opacity: sale.saleUrl && pressed ? 0.9 : 1,
                              },
                            ]}
                            testID={`detail-recent-sales-row-${index}`}
                          >
                            <EbayWordmarkBadge />

                            <View style={styles.ebayRowBody}>
                              <Text numberOfLines={2} style={[theme.typography.bodyStrong, styles.ebayTitle]}>
                                {sale.title}
                              </Text>
                              {soldDateLabel ? (
                                <Text style={[theme.typography.caption, styles.ebayMeta]}>
                                  {soldDateLabel}
                                </Text>
                              ) : null}
                            </View>

                            <View style={styles.ebayPriceBlock}>
                              <Text style={[theme.typography.bodyStrong, styles.ebayPrice]}>
                                {sale.priceAmount != null
                                  ? formatCurrency(sale.priceAmount, sale.currencyCode)
                                  : '—'}
                              </Text>
                              <Text style={[theme.typography.micro, styles.ebayOpenCopy]}>
                                {sale.saleUrl ? 'Sold' : 'Unavailable'}
                              </Text>
                            </View>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  </>
                ) : isRecentSalesLoading && !recentSales ? (
                  <View style={styles.ebayEmptyState}>
                    <Text style={[theme.typography.bodyStrong, styles.ebayTitle]}>
                      Recent Sales
                    </Text>
                    <Text style={[theme.typography.caption, styles.ebayMeta]}>
                      Loading recent eBay sales...
                    </Text>
                  </View>
                ) : shouldShowRecentSalesLoad ? (
                  <View style={styles.ebayEmptyState}>
                    <Text style={[theme.typography.bodyStrong, styles.ebayTitle]}>
                      Recent Sales
                    </Text>
                    <Text style={[theme.typography.caption, styles.ebayMeta]}>
                      Load recent eBay sales for this slab when you need them.
                    </Text>
                    <Button
                      contentStyle={styles.ebayButtonContent}
                      disabled={isRecentSalesLoading}
                      label={isRecentSalesLoading ? 'Loading recent eBay sales...' : 'Load recent eBay sales'}
                      labelStyle={styles.marketplaceButtonLabel}
                      leadingAccessory={<EbayWordmarkBadge />}
                      onPress={() => {
                        void loadRecentSales('load');
                      }}
                      size="lg"
                      style={styles.ebayViewAllButton}
                      testID="detail-recent-sales-load"
                      variant="secondary"
                    />
                    {recentSalesErrorMessage ? (
                      <Text style={[theme.typography.caption, styles.ebayMeta]}>
                        {recentSalesErrorMessage}
                      </Text>
                    ) : null}
                  </View>
                ) : (
                  <View style={styles.ebayEmptyState}>
                    <Text style={[theme.typography.bodyStrong, styles.ebayTitle]}>
                      Recent eBay sales unavailable
                    </Text>
                    <Text style={[theme.typography.caption, styles.ebayMeta]}>
                      {recentSalesErrorMessage ?? recentSales?.unavailableReason ?? 'No recent sold sales were returned for this slab.'}
                    </Text>
                    {shouldShowRecentSalesRefresh ? (
                      <Button
                        contentStyle={styles.ebayButtonContent}
                        disabled={isRecentSalesLoading}
                        label={isRecentSalesLoading ? 'Refreshing...' : 'Refresh'}
                        labelStyle={styles.marketplaceButtonLabel}
                        leadingAccessory={<EbayWordmarkBadge />}
                        onPress={() => {
                          void loadRecentSales('refresh');
                        }}
                        size="lg"
                        style={styles.ebayViewAllButton}
                        testID="detail-recent-sales-refresh"
                        variant="secondary"
                      />
                    ) : null}
                  </View>
                )}

                {recentSales?.status === 'available' && shouldShowRecentSalesRefresh ? (
                  <Button
                    contentStyle={styles.ebayButtonContent}
                    disabled={isRecentSalesLoading}
                    label={isRecentSalesLoading ? 'Refreshing...' : 'Refresh'}
                    labelStyle={styles.marketplaceButtonLabel}
                    leadingAccessory={<EbayWordmarkBadge />}
                    onPress={() => {
                      void loadRecentSales('refresh');
                    }}
                    size="lg"
                    style={styles.ebayViewAllButton}
                    testID="detail-recent-sales-refresh"
                    variant="secondary"
                  />
                ) : null}
                {recentSales?.status === 'available' && recentSalesErrorMessage ? (
                  <Text style={[theme.typography.caption, styles.ebayMeta]}>
                    {recentSalesErrorMessage}
                  </Text>
                ) : null}
              </SurfaceCard>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionStack: {
    gap: 12,
  },
  backPlate: {
    alignSelf: 'flex-start',
  },
  chartAxisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingLeft: 56,
  },
  chartAxisText: {
    color: 'rgba(15, 15, 18, 0.42)',
  },
  chartContainer: {
    gap: 2,
  },
  chartEmptyCopy: {
    color: 'rgba(15, 15, 18, 0.52)',
    textAlign: 'center',
  },
  chartEmptyState: {
    alignItems: 'center',
    backgroundColor: '#F4F6F8',
    borderRadius: 18,
    gap: 8,
    minHeight: 210,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  chartEmptyTitle: {
    textAlign: 'center',
  },
  chartFrame: {
    backgroundColor: '#F7F8FA',
    borderRadius: 18,
    height: 210,
    overflow: 'hidden',
    paddingVertical: 14,
  },
  chartGridLabel: {
    color: 'rgba(15, 15, 18, 0.38)',
    width: 48,
  },
  chartGridLine: {
    borderTopColor: 'rgba(15, 15, 18, 0.08)',
    borderTopWidth: 1,
    flex: 1,
    marginLeft: 8,
  },
  chartGridRow: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    paddingHorizontal: 10,
  },
  chevronCollapsed: {
    transform: [{ rotate: '-90deg' }],
  },
  chevronIconFrame: {
    alignItems: 'center',
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  chevronIconInner: {
    height: 9,
    position: 'relative',
    width: 14,
  },
  chevronIconStem: {
    backgroundColor: 'rgba(15, 15, 18, 0.58)',
    borderRadius: 999,
    height: 2.2,
    position: 'absolute',
    top: 3,
    width: 8,
  },
  chevronIconStemLeft: {
    left: 0,
    transform: [{ rotate: '45deg' }],
  },
  chevronIconStemRight: {
    right: 0,
    transform: [{ rotate: '-45deg' }],
  },
  chartSvg: {
    ...StyleSheet.absoluteFillObject,
  },
  ebayBadge: {
    alignItems: 'center',
    backgroundColor: '#F7F8FA',
    borderColor: 'rgba(15, 15, 18, 0.08)',
    borderRadius: 12,
    borderWidth: 1,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  ebayBlue: {
    color: '#0064D2',
  },
  ebayEmptyState: {
    gap: 6,
  },
  ebayGreen: {
    color: '#86B817',
  },
  ebayList: {
    gap: 10,
  },
  ebayListScroll: {
    maxHeight: 392,
  },
  ebayMeta: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  ebayOpenCopy: {
    color: 'rgba(15, 15, 18, 0.44)',
  },
  ebayPrice: {
    color: '#0F0F12',
    textAlign: 'right',
  },
  ebayPriceBlock: {
    alignItems: 'flex-end',
    gap: 4,
    minWidth: 74,
  },
  ebayRed: {
    color: '#E53238',
  },
  ebayRow: {
    alignItems: 'center',
    backgroundColor: '#F7F8FA',
    borderColor: 'rgba(15, 15, 18, 0.08)',
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  ebayRowBody: {
    flex: 1,
    gap: 4,
  },
  ebayTitle: {
    color: '#0F0F12',
  },
  ebayViewAllButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(15, 15, 18, 0.08)',
  },
  ebayWordmark: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  ebayYellow: {
    color: '#F5AF02',
  },
  collectionArt: {
    height: '100%',
    resizeMode: 'cover',
    width: '100%',
  },
  collectionArtPlate: {
    backgroundColor: 'transparent',
    borderRadius: 14,
    height: 64,
    overflow: 'hidden',
    width: 48,
  },
  collectionActionsRow: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 8,
  },
  collectionBody: {
    flex: 1,
    gap: 6,
    minHeight: 64,
    minWidth: 0,
  },
  collectionDivider: {
    height: 1,
    marginVertical: 10,
    width: '100%',
  },
  collectionControlIconButton: {
    alignItems: 'center',
    borderRadius: 999,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  collectionControlPill: {
    alignItems: 'center',
    backgroundColor: '#F3F0E8',
    borderRadius: 999,
    flexDirection: 'row',
    flexShrink: 0,
    gap: 4,
    minHeight: 40,
    paddingHorizontal: 4,
  },
  collectionControlQuantity: {
    color: '#0F0F12',
    fontSize: 14,
    lineHeight: 16,
    minWidth: 20,
    textAlign: 'center',
  },
  collectionEditButton: {
    alignItems: 'center',
    backgroundColor: '#F7F8FA',
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  collectionSecondaryActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  collectionSellButton: {
    alignItems: 'center',
    backgroundColor: '#FFE24B',
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  collectionSellButtonLabel: {
    color: '#0F0F12',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 16,
    textAlign: 'center',
  },
  collectionList: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(15, 15, 18, 0.06)',
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  collectionMeta: {
    color: 'rgba(15, 15, 18, 0.5)',
  },
  collectionPrice: {
    color: '#0F0F12',
    fontSize: 16,
    lineHeight: 20,
  },
  collectionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 72,
  },
  collectionSummary: {
    color: '#0F0F12',
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 18,
  },
  collectionTopRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  conditionChip: {
    borderRadius: 18,
    borderWidth: 1,
    gap: 6,
    minWidth: 100,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  conditionChipRow: {
    gap: 8,
    paddingRight: 8,
    paddingTop: 4,
  },
  conditionLabel: {
    color: 'rgba(15, 15, 18, 0.72)',
  },
  conditionPrice: {
    color: '#0F0F12',
  },
  content: {
    gap: 20,
    paddingBottom: 40,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  errorCopy: {
    marginTop: 8,
    textAlign: 'center',
  },
  favoriteButtonContent: {
    justifyContent: 'flex-start',
    width: '100%',
  },
  favoriteButtonLabel: {
    flex: 1,
    textAlign: 'left',
  },
  heroArt: {
    height: 320,
    resizeMode: 'contain',
    width: 230,
  },
  heroArtFallback: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 26,
    height: 320,
    justifyContent: 'center',
    paddingHorizontal: 20,
    width: 230,
  },
  heroArtFallbackText: {
    color: 'rgba(15, 15, 18, 0.5)',
    textAlign: 'center',
  },
  heroArtStage: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderRadius: 32,
    height: 388,
    justifyContent: 'center',
    marginTop: 20,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 20,
  },
  heroCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(255, 255, 255, 0.62)',
    borderWidth: 1,
    gap: 10,
  },
  heroCopy: {
    alignItems: 'flex-start',
    gap: 6,
    width: '100%',
  },
  heroName: {
    marginTop: 2,
    width: '100%',
  },
  heroSubtitle: {
    width: '100%',
  },
  insightBlock: {
    flex: 1,
    gap: 4,
  },
  insightLabel: {
    color: 'rgba(15, 15, 18, 0.46)',
  },
  insightMuted: {
    color: 'rgba(15, 15, 18, 0.36)',
  },
  insightsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  inventoryActionError: {
    lineHeight: 16,
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  marketplaceAction: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(15, 15, 18, 0.08)',
  },
  marketplaceButtonContent: {
    justifyContent: 'space-between',
    width: '100%',
  },
  marketplaceButtonLabel: {
    color: '#0F0F12',
    flex: 1,
    textAlign: 'left',
  },
  marketplaceIcon: {
    borderRadius: 8,
    height: 26,
    width: 26,
  },
  lazyDetailCopy: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  lazyMarketBlock: {
    gap: 8,
  },
  ebayButtonContent: {
    justifyContent: 'flex-start',
    width: '100%',
  },
  marketCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    gap: 16,
  },
  marketHeader: {
    alignItems: 'flex-start',
  },
  marketHeaderTitle: {
    fontSize: 18,
    lineHeight: 22,
  },
  marketTimestamp: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  marketValueTitle: {
    color: '#0F0F12',
    marginBottom: 4,
  },
  primaryButtonContent: {
    justifyContent: 'flex-start',
    width: '100%',
  },
  primaryButtonLabel: {
    flex: 1,
    textAlign: 'left',
  },
  previewMarketValue: {
    color: '#0F0F12',
    fontSize: 48,
    fontWeight: '800',
    lineHeight: 56,
  },
  safeArea: {
    flex: 1,
  },
  section: {
    gap: 12,
  },
  sectionHeader: {
    alignSelf: 'flex-start',
  },
  sectionHeaderButtonRow: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
  },
  sectionHeaderChevronInline: {
    alignItems: 'center',
    height: 20,
    justifyContent: 'center',
    marginLeft: -2,
    width: 20,
  },
  sectionHeaderTitle: {
    paddingRight: 4,
  },
  similarCardsButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: '#F4D230',
    borderRadius: 999,
    borderWidth: 1.4,
    flexDirection: 'row',
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 10,
    width: '100%',
  },
  similarCardsButtonPressed: {
    opacity: 0.9,
  },
  similarCardsChevron: {
    color: 'rgba(15, 15, 18, 0.68)',
    fontSize: 28,
    fontWeight: '500',
    lineHeight: 28,
  },
  similarCardsTitle: {
    color: '#0F0F12',
    flex: 1,
    textAlign: 'left',
  },
});
