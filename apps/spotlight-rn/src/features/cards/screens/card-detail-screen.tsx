import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconChevronDown,
  IconChevronUp,
  IconDots,
  IconHeart,
  IconHeartFilled,
  IconPlus,
  IconRefresh,
  IconTrendingDown,
  IconTrendingUp,
} from '@tabler/icons-react-native';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
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
  type CardPricingTrendsPct,
  type CardRecentSalesRecord,
} from '@spotlight/api-client';
import { Button, SurfaceCard, colors, useSpotlightTheme } from '@spotlight/design-system';

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
} from '@/features/portfolio/components/portfolio-formatting';
import { useSuggestedDiscount } from '@/features/pricing/use-suggested-discount';
import { slabGradeSummary } from '@/features/sell/sell-order-helpers';
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
const slabLastSoldRowLimit = 2;

type TimeframeId = '7d' | '30d' | '90d' | '180d' | '1y' | 'all';

type TimeframeOption = {
  id: TimeframeId;
  label: string;
  days: number | null;
};

const timeframeOptions: readonly TimeframeOption[] = [
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: '180d', label: '180d', days: 180 },
  { id: '1y', label: '1y', days: 365 },
  { id: 'all', label: 'All', days: null },
] as const;

const defaultTimeframeId: TimeframeId = '90d';

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

function formatPricesFreshnessLabel(value?: string | null): string | null {
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
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'Prices · just now';
  }
  if (diffMs < 60_000) {
    return 'Prices · just now';
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `Prices · ${minutes}m ago`;
  }
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) {
    return `Prices · ${hours}h ago`;
  }
  const days = Math.floor(diffMs / 86_400_000);
  return `Prices · ${days}d ago`;
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

type ChartPoint = CardDetailRecord['marketHistory']['points'][number];

function HistoryChart({
  currencyCode,
  currentPrice,
  points,
  tintColor,
}: {
  currencyCode: string;
  currentPrice: number;
  points: ChartPoint[];
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

  const valuePool = [
    ...points.map((point) => point.value),
    currentPrice,
  ];
  const minValue = Math.max(0, Math.min(...valuePool));
  const maxValue = Math.max(...valuePool);
  const minimumVisiblePadding = maxValue >= 1 ? 0.1 : 0.02;
  const paddingValue = Math.max((maxValue - minValue) * 0.18, maxValue * 0.06, minimumVisiblePadding);
  const chartMin = Math.max(0, minValue - paddingValue);
  const chartMax = maxValue + paddingValue;
  const chartRange = Math.max(chartMax - chartMin, minimumVisiblePadding);
  const chartWidth = width - paddingLeft - paddingRight;
  const baseline = height - paddingBottom;
  const gridValues = Array.from({ length: 4 }, (_, index) => chartMax - (chartRange / 3) * index);

  const project = (value: number, index: number) => {
    const normalized = (value - chartMin) / chartRange;
    return {
      x: paddingLeft + (chartWidth * index) / Math.max(points.length - 1, 1),
      y: baseline - normalized * (baseline - paddingTop),
    };
  };

  const plottedPoints = points.map((point, index) => project(point.value, index));

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

function TrendChip({
  days,
  value,
  testID,
}: {
  days: 7 | 30 | 90;
  value: number | null | undefined;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  const label = `${days}d`;

  if (value == null || !Number.isFinite(value)) {
    return (
      <View style={styles.trendChip} testID={testID}>
        <Text style={[theme.typography.micro, styles.trendChipLabel]}>{label}</Text>
        <Text style={[theme.typography.bodyStrong, styles.trendChipValueMuted]}>—</Text>
      </View>
    );
  }

  const isUp = value >= 0;
  const tone = isUp ? theme.colors.success : theme.colors.danger;
  const Icon = isUp ? IconTrendingUp : IconTrendingDown;
  const formatted = `${isUp ? '+' : '-'}${Math.abs(value).toFixed(1)}%`;

  return (
    <View style={styles.trendChip} testID={testID}>
      <Text style={[theme.typography.micro, styles.trendChipLabel]}>{label}</Text>
      <View style={styles.trendChipValueRow}>
        <Icon color={tone} size={14} strokeWidth={2.2} />
        <Text style={[theme.typography.bodyStrong, { color: tone }]}>{formatted}</Text>
      </View>
    </View>
  );
}

function ConditionDropdown({
  options,
  selectedId,
  selectedLabel,
  disabled,
  onSelect,
  testID,
}: {
  options: { id: string; label: string; shortLabel: string; isAvailable: boolean; currentPrice: number | null }[];
  selectedId: string | null;
  selectedLabel: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const [isOpen, setIsOpen] = useState(false);

  const close = () => setIsOpen(false);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => setIsOpen(true)}
        style={({ pressed }) => [
          styles.dropdownTrigger,
          {
            borderColor: theme.colors.outlineSubtle,
            opacity: disabled ? 0.5 : pressed ? 0.88 : 1,
          },
        ]}
        testID={testID}
      >
        <Text
          style={[theme.typography.control, styles.dropdownTriggerLabel]}
          testID={testID ? `${testID}-label` : undefined}
        >
          {selectedLabel}
        </Text>
        <IconChevronDown color={theme.colors.textPrimary} size={16} strokeWidth={2.2} />
      </Pressable>

      <Modal
        animationType="fade"
        onRequestClose={close}
        transparent
        visible={isOpen}
      >
        <Pressable
          accessibilityLabel="Close condition picker"
          onPress={close}
          style={styles.dropdownBackdrop}
          testID={testID ? `${testID}-backdrop` : undefined}
        >
          <Pressable onPress={() => undefined} style={styles.dropdownSheet}>
            {options.map((option) => {
              const isSelected = option.id === selectedId;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  disabled={!option.isAvailable}
                  onPress={() => {
                    onSelect(option.id);
                    close();
                  }}
                  style={({ pressed }) => [
                    styles.dropdownOption,
                    {
                      backgroundColor: isSelected ? theme.colors.surfaceMuted : 'transparent',
                      opacity: option.isAvailable ? (pressed ? 0.84 : 1) : 0.42,
                    },
                  ]}
                  testID={testID ? `${testID}-option-${option.id}` : undefined}
                >
                  <Text style={[theme.typography.body, styles.dropdownOptionLabel]}>
                    {option.label}
                  </Text>
                  <Text style={[theme.typography.bodyStrong, styles.dropdownOptionPrice]}>
                    {option.currentPrice != null
                      ? formatCurrency(option.currentPrice, 'USD')
                      : '—'}
                  </Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
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
  const [isRecentSalesLoading, setIsRecentSalesLoading] = useState(false);
  const [hasResolvedRecentSalesState, setHasResolvedRecentSalesState] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedConditionId, setSelectedConditionId] = useState<string | null>(null);
  const [isFavoritePending, setIsFavoritePending] = useState(false);
  const [isPriceDetailsExpanded, setIsPriceDetailsExpanded] = useState(false);
  const [selectedTimeframeId, setSelectedTimeframeId] = useState<TimeframeId>(defaultTimeframeId);
  const [isOverflowMenuOpen, setIsOverflowMenuOpen] = useState(false);
  const { discountPct } = useSuggestedDiscount();
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
    setIsPriceDetailsExpanded(false);
    setSelectedTimeframeId(defaultTimeframeId);
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
      days: 90,
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
  }, [cardId, recentSalesState?.fetchedAt, recentSalesState?.saleCount, recentSalesState?.sales.length, selectedSlabContext, shouldShowRecentSales, spotlightRepository]);

  useEffect(() => {
    let cancelled = false;
    setRecentSalesState(null);
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
  const slabLastSoldRows = useMemo(
    () => sortedRecentSales.slice(0, slabLastSoldRowLimit),
    [sortedRecentSales],
  );

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

  const timeframeFilteredPoints = useMemo<ChartPoint[]>(() => {
    const allPoints = (effectiveMarketHistory?.points ?? []) as ChartPoint[];
    if (allPoints.length === 0) {
      return [];
    }
    const option = timeframeOptions.find((entry) => entry.id === selectedTimeframeId);
    const days = option?.days ?? null;
    if (days == null) {
      return allPoints;
    }
    const cutoffMs = Date.now() - days * 86_400_000;
    const filtered = allPoints.filter((point) => {
      const parsed = Date.parse(point.isoDate);
      if (!Number.isFinite(parsed)) {
        return true;
      }
      return parsed >= cutoffMs;
    });
    return filtered.length > 0 ? filtered : allPoints;
  }, [effectiveMarketHistory?.points, selectedTimeframeId]);

  const hasDisplayContent = detail != null || detailPreview != null;

  if (!hasDisplayContent && !errorMessage) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Loading card...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasDisplayContent) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
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
    ? (slabDisplayedPrice ?? effectiveMarketHistory?.currentPrice ?? null)
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
  const isFavorite = detail?.isFavorite ?? false;
  const isOwned = selectedEntry != null;
  const slabHeroSubtitle = slabGradeSummary(selectedSlabContext);
  const displayCardNumber = detail?.cardNumber ?? detailPreview?.cardNumber ?? '';
  const displaySetName = detail?.setName ?? detailPreview?.setName ?? '';
  const marketplaceUrl = detail?.marketplaceUrl ?? buildTcgPlayerSearchUrl({
    cardNumber: displayCardNumber,
    name: displayName,
    setName: displaySetName,
  });
  const sellEntryId = selectedEntry?.id ?? entryId;

  const conditionDropdownLabel = isSlabDetail
    ? (slabHeroSubtitle ?? 'Slab')
    : (selectedCondition?.label ?? 'Condition');

  const pricesFreshnessLabel = formatPricesFreshnessLabel(recentSales?.fetchedAt);
  const shouldShowRecentSalesRefresh = Boolean(recentSales?.canRefresh);

  const suggestedDisplayPrice = (
    discountPct != null
    && typeof displayedPrice === 'number'
    && Number.isFinite(displayedPrice)
    && displayedPrice > 0
  )
    ? Number((displayedPrice * (1 - discountPct / 100)).toFixed(2))
    : null;

  const activeTrendsPct: CardPricingTrendsPct | null = detail?.trendsPct ?? null;

  const hasMarketHistoryPoints = timeframeFilteredPoints.length > 0;

  const safeNumericDisplayedPrice = typeof displayedPrice === 'number' && Number.isFinite(displayedPrice)
    ? displayedPrice
    : 0;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
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
            <View style={styles.heroRow}>
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

              <View style={styles.heroCopy}>
                <Text
                  numberOfLines={2}
                  style={[theme.typography.title, styles.heroName]}
                >
                  {displayName}
                </Text>

                <Text
                  style={[theme.typography.bodyStrong, styles.heroSubtitle, { color: theme.colors.textSecondary }]}
                  testID="detail-hero-meta"
                >
                  {displayNumber(displayCardNumber)} • {displaySetName}
                </Text>

                {slabHeroSubtitle ? (
                  <Text
                    style={[theme.typography.bodyStrong, styles.heroSubtitle, { color: theme.colors.textSecondary }]}
                    testID="detail-hero-slab-meta"
                  >
                    {slabHeroSubtitle}
                  </Text>
                ) : null}

                <View style={styles.heroIconRow} testID="detail-action-stack">
                  <Pressable
                    accessibilityLabel={isFavorite ? 'Remove from favorites' : 'Favorite card'}
                    accessibilityRole="button"
                    disabled={isFavoritePending}
                    onPress={handleToggleFavorite}
                    style={({ pressed }) => [
                      styles.heroIconButton,
                      {
                        borderColor: theme.colors.outlineSubtle,
                        opacity: isFavoritePending ? 0.45 : pressed ? 0.84 : 1,
                      },
                    ]}
                    testID="detail-favorite-card"
                  >
                    {isFavorite ? (
                      <IconHeartFilled color={favoriteHeartColor} size={18} />
                    ) : (
                      <IconHeart color={favoriteHeartColor} size={18} strokeWidth={2} />
                    )}
                  </Pressable>

                  <Pressable
                    accessibilityLabel={isOwned ? 'Add another copy to collection' : 'Add to collection'}
                    accessibilityRole="button"
                    onPress={() => onOpenAddToCollection(detail?.cardId ?? cardId, isOwned ? sellEntryId : undefined)}
                    style={({ pressed }) => [
                      styles.heroIconButton,
                      {
                        borderColor: theme.colors.outlineSubtle,
                        opacity: pressed ? 0.84 : 1,
                      },
                    ]}
                    testID="detail-add-to-collection"
                  >
                    <IconPlus color={theme.colors.textPrimary} size={18} strokeWidth={2.1} />
                  </Pressable>

                  <Pressable
                    accessibilityLabel="More actions"
                    accessibilityRole="button"
                    onPress={() => setIsOverflowMenuOpen(true)}
                    style={({ pressed }) => [
                      styles.heroIconButton,
                      {
                        borderColor: theme.colors.outlineSubtle,
                        opacity: pressed ? 0.84 : 1,
                      },
                    ]}
                    testID="detail-overflow-menu"
                  >
                    <IconDots color={theme.colors.textPrimary} size={18} strokeWidth={2.1} />
                  </Pressable>
                </View>
              </View>
            </View>
          </SurfaceCard>
        </View>

        {isOwned && sellEntryId && onOpenSell ? (
          <Button
            contentStyle={styles.primaryButtonContent}
            label="SELL CARD"
            labelStyle={styles.primaryButtonLabel}
            onPress={() => {
              onOpenSell(sellEntryId);
            }}
            size="lg"
            testID="detail-sell-card"
            variant="primary"
          />
        ) : null}

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

        <View style={styles.section}>
          <View testID="detail-market-card">
            <SurfaceCard padding={18} radius={24} style={styles.marketCard}>
              <View style={styles.priceHeaderRow}>
                <ConditionDropdown
                  disabled={isSlabDetail || marketConditionOptions.length === 0}
                  onSelect={(id) => setSelectedConditionId(id)}
                  options={marketConditionOptions}
                  selectedId={selectedCondition?.id ?? null}
                  selectedLabel={conditionDropdownLabel}
                  testID="detail-condition-dropdown"
                />
                {pricesFreshnessLabel ? (
                  <View style={styles.freshnessRow}>
                    <Text
                      style={[theme.typography.caption, styles.priceFreshnessLabel]}
                      testID="detail-prices-freshness"
                    >
                      {pricesFreshnessLabel}
                    </Text>
                    {shouldShowRecentSalesRefresh ? (
                      isRecentSalesLoading && recentSales ? (
                        <ActivityIndicator color="rgba(15, 15, 18, 0.52)" size="small" testID="detail-recent-sales-loading-inline" />
                      ) : (
                        <Pressable
                          accessibilityLabel="Refresh recent eBay sales"
                          accessibilityRole="button"
                          onPress={() => {
                            void loadRecentSales('refresh');
                          }}
                          style={({ pressed }) => [
                            styles.freshnessRefreshButton,
                            { opacity: pressed ? 0.72 : 1 },
                          ]}
                          testID="detail-recent-sales-refresh"
                        >
                          <IconRefresh color="rgba(15, 15, 18, 0.58)" size={14} strokeWidth={1.9} />
                        </Pressable>
                      )
                    ) : null}
                  </View>
                ) : null}
              </View>

              <View style={styles.priceRow}>
                <View style={styles.priceColumn}>
                  <Text
                    style={[theme.typography.display, styles.marketValueTitle]}
                    testID="detail-market-price"
                  >
                    {formatOptionalCurrency(displayedPrice, displayCurrencyCode)}
                  </Text>
                  <Text style={[theme.typography.caption, styles.priceColumnLabel]}>Market price</Text>
                </View>

                {suggestedDisplayPrice != null ? (
                  <View style={styles.priceColumn} testID="detail-suggested-price-column">
                    <Text
                      style={[theme.typography.display, styles.suggestedValueTitle]}
                      testID="detail-suggested-price"
                    >
                      {formatCurrency(suggestedDisplayPrice, displayCurrencyCode)}
                    </Text>
                    <Text
                      style={[theme.typography.caption, styles.priceColumnLabel]}
                      testID="detail-suggested-price-label"
                    >
                      {`Suggested (−${discountPct ?? 0}%)`}
                    </Text>
                  </View>
                ) : null}
              </View>

              {isSlabDetail && slabLastSoldRows.length > 0 ? (
                <View style={styles.slabLastSoldBlock} testID="detail-slab-last-sold">
                  <Text style={[theme.typography.caption, styles.slabLastSoldHeader]}>
                    Last sold · eBay
                  </Text>
                  {slabLastSoldRows.map((sale, index) => {
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
                          styles.slabLastSoldRow,
                          { opacity: sale.saleUrl && pressed ? 0.9 : 1 },
                        ]}
                        testID={`detail-slab-last-sold-row-${index}`}
                      >
                        <View style={styles.slabLastSoldRowMain}>
                          <Text
                            numberOfLines={1}
                            style={[theme.typography.bodyStrong, styles.slabLastSoldTitle]}
                          >
                            {sale.title}
                          </Text>
                          {soldDateLabel ? (
                            <Text style={[theme.typography.micro, styles.slabLastSoldMeta]}>
                              {soldDateLabel}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={[theme.typography.bodyStrong, styles.slabLastSoldPrice]}>
                          {sale.priceAmount != null
                            ? formatCurrency(sale.priceAmount, sale.currencyCode)
                            : '—'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              <Pressable
                accessibilityRole="button"
                onPress={() => setIsPriceDetailsExpanded((current) => !current)}
                style={({ pressed }) => [
                  styles.priceDetailsToggle,
                  { opacity: pressed ? 0.72 : 1 },
                ]}
                testID="detail-price-details-toggle"
              >
                <Text style={[theme.typography.control, styles.priceDetailsToggleLabel]}>
                  {isPriceDetailsExpanded ? 'Show less' : 'Show more'}
                </Text>
                {isPriceDetailsExpanded ? (
                  <IconChevronUp color={theme.colors.textPrimary} size={16} strokeWidth={2.2} />
                ) : (
                  <IconChevronDown color={theme.colors.textPrimary} size={16} strokeWidth={2.2} />
                )}
              </Pressable>

              {isPriceDetailsExpanded ? (
                <View style={styles.priceDetailsBody} testID="detail-price-details-body">
                  <View style={styles.trendChipRow} testID="detail-trend-chip-row">
                    <TrendChip days={7} testID="detail-trend-chip-7d" value={activeTrendsPct?.days7 ?? null} />
                    <TrendChip days={30} testID="detail-trend-chip-30d" value={activeTrendsPct?.days30 ?? null} />
                    <TrendChip days={90} testID="detail-trend-chip-90d" value={activeTrendsPct?.days90 ?? null} />
                  </View>
                </View>
              ) : null}
            </SurfaceCard>
          </View>
        </View>

        <View style={styles.section}>
          <View testID="detail-history-card">
            <SurfaceCard padding={18} radius={24} style={styles.marketCard}>
              {hasMarketHistoryPoints ? (
                <HistoryChart
                  currencyCode={displayCurrencyCode}
                  currentPrice={safeNumericDisplayedPrice}
                  points={timeframeFilteredPoints}
                  tintColor={marketTint}
                />
              ) : (
                <View style={styles.lazyMarketBlock} testID="detail-history-empty">
                  <Text style={[theme.typography.caption, styles.lazyDetailCopy]}>
                    Price history is still populating.
                  </Text>
                </View>
              )}

              <View style={styles.timeframeRow} testID="detail-timeframe-row">
                {timeframeOptions.map((option) => {
                  const isSelected = option.id === selectedTimeframeId;
                  return (
                    <Pressable
                      key={option.id}
                      accessibilityRole="button"
                      onPress={() => setSelectedTimeframeId(option.id)}
                      style={({ pressed }) => [
                        styles.timeframeChip,
                        {
                          backgroundColor: isSelected ? theme.colors.surfaceMuted : '#F7F8FA',
                          borderColor: isSelected ? theme.colors.brand : 'rgba(15, 15, 18, 0.08)',
                          opacity: pressed ? 0.92 : 1,
                        },
                      ]}
                      testID={`detail-timeframe-${option.id}`}
                    >
                      <Text style={[theme.typography.caption, styles.timeframeChipLabel]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </SurfaceCard>
          </View>
        </View>

        <Button
          contentStyle={styles.marketplaceButtonContent}
          disabled={!marketplaceUrl}
          label="View on TCGplayer"
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
      </ScrollView>

      <Modal
        animationType="fade"
        onRequestClose={() => setIsOverflowMenuOpen(false)}
        transparent
        visible={isOverflowMenuOpen}
      >
        <Pressable
          accessibilityLabel="Close menu"
          onPress={() => setIsOverflowMenuOpen(false)}
          style={styles.dropdownBackdrop}
          testID="detail-overflow-backdrop"
        >
          <Pressable onPress={() => undefined} style={styles.dropdownSheet}>
            {sellEntryId && onOpenSell ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setIsOverflowMenuOpen(false);
                  onOpenSell(sellEntryId);
                }}
                style={({ pressed }) => [
                  styles.dropdownOption,
                  { opacity: pressed ? 0.84 : 1 },
                ]}
                testID="detail-overflow-sell"
              >
                <Text style={[theme.typography.body, styles.dropdownOptionLabel]}>
                  Sell card
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setIsOverflowMenuOpen(false);
                onOpenAddToCollection(detail?.cardId ?? cardId, isOwned ? sellEntryId : undefined);
              }}
              style={({ pressed }) => [
                styles.dropdownOption,
                { opacity: pressed ? 0.84 : 1 },
              ]}
              testID="detail-overflow-edit-collection"
            >
              <Text style={[theme.typography.body, styles.dropdownOptionLabel]}>
                {isOwned ? 'Edit collection entry' : 'Add to collection'}
              </Text>
            </Pressable>
            {marketplaceUrl ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setIsOverflowMenuOpen(false);
                  void Linking.openURL(marketplaceUrl);
                }}
                style={({ pressed }) => [
                  styles.dropdownOption,
                  { opacity: pressed ? 0.84 : 1 },
                ]}
                testID="detail-overflow-tcgplayer"
              >
                <Text style={[theme.typography.body, styles.dropdownOptionLabel]}>
                  View on TCGplayer
                </Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
  chartSvg: {
    ...StyleSheet.absoluteFillObject,
  },
  content: {
    gap: 20,
    paddingBottom: 40,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  dropdownBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  dropdownOption: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  dropdownOptionLabel: {
    flex: 1,
  },
  dropdownOptionPrice: {
    textAlign: 'right',
  },
  dropdownSheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 8,
    width: '100%',
  },
  dropdownTrigger: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  dropdownTriggerLabel: {
    color: '#0F0F12',
  },
  errorCopy: {
    marginTop: 8,
    textAlign: 'center',
  },
  freshnessRefreshButton: {
    alignItems: 'center',
    borderRadius: 999,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  freshnessRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  heroArt: {
    height: 160,
    resizeMode: 'contain',
    width: 112,
  },
  heroArtFallback: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    height: 160,
    justifyContent: 'center',
    paddingHorizontal: 10,
    width: 112,
  },
  heroArtFallbackText: {
    color: 'rgba(15, 15, 18, 0.5)',
    textAlign: 'center',
  },
  heroArtStage: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderRadius: 18,
    flexShrink: 0,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  heroCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(255, 255, 255, 0.62)',
    borderWidth: 1,
    gap: 10,
  },
  heroCopy: {
    alignItems: 'flex-start',
    flex: 1,
    gap: 6,
    minWidth: 0,
  },
  heroIconButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderRadius: 999,
    borderWidth: 1,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  heroIconRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  heroName: {
    width: '100%',
  },
  heroRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 16,
    width: '100%',
  },
  heroSubtitle: {
    width: '100%',
  },
  lazyDetailCopy: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  lazyMarketBlock: {
    gap: 8,
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  marketCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    gap: 16,
  },
  marketValueTitle: {
    color: '#0F0F12',
    marginBottom: 4,
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
  priceColumn: {
    flex: 1,
    gap: 2,
  },
  priceColumnLabel: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  priceDetailsBody: {
    gap: 14,
  },
  priceDetailsToggle: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 4,
    paddingVertical: 4,
  },
  priceDetailsToggleLabel: {
    color: '#0F0F12',
  },
  priceFreshnessLabel: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  priceHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  priceRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 16,
  },
  previewMarketValue: {
    color: '#0F0F12',
    fontSize: 48,
    fontWeight: '800',
    lineHeight: 56,
  },
  primaryButtonContent: {
    justifyContent: 'flex-start',
    width: '100%',
  },
  primaryButtonLabel: {
    flex: 1,
    textAlign: 'left',
  },
  safeArea: {
    flex: 1,
  },
  section: {
    gap: 12,
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
  slabLastSoldBlock: {
    gap: 6,
  },
  slabLastSoldHeader: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  slabLastSoldMeta: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  slabLastSoldPrice: {
    color: '#0F0F12',
    minWidth: 70,
    textAlign: 'right',
  },
  slabLastSoldRow: {
    alignItems: 'center',
    backgroundColor: '#F7F8FA',
    borderColor: 'rgba(15, 15, 18, 0.08)',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  slabLastSoldRowMain: {
    flex: 1,
    gap: 2,
  },
  slabLastSoldTitle: {
    color: '#0F0F12',
  },
  suggestedValueTitle: {
    color: '#0F0F12',
    marginBottom: 4,
  },
  timeframeChip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  timeframeChipLabel: {
    color: 'rgba(15, 15, 18, 0.72)',
  },
  timeframeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  trendChip: {
    alignItems: 'flex-start',
    backgroundColor: '#F7F8FA',
    borderColor: 'rgba(15, 15, 18, 0.08)',
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  trendChipLabel: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  trendChipRow: {
    flexDirection: 'row',
    gap: 8,
  },
  trendChipValueMuted: {
    color: 'rgba(15, 15, 18, 0.42)',
  },
  trendChipValueRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
});
