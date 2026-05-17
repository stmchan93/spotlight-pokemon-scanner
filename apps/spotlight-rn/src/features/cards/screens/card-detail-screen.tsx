import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconBolt,
  IconCash,
  IconChevronDown,
  IconHeart,
  IconHeartFilled,
  IconMinus,
  IconPencil,
  IconPlus,
  IconTrash,
  IconTrendingDown,
  IconTrendingUp,
} from '@tabler/icons-react-native';
import {
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
  type CardRecentSalesRecord,
} from '@spotlight/api-client';
import { Button, IconButton, SurfaceCard, colors, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { CardHero } from '@/features/cards/components/card-hero';
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
const slabLastSoldRowLimit = 5;

type TimeframeId = '7d' | '30d';

type TimeframeOption = {
  id: TimeframeId;
  label: string;
  days: number;
};

const timeframeOptions: readonly TimeframeOption[] = [
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
] as const;

const defaultTimeframeId: TimeframeId = '30d';

const psaSlabGradeOptions: readonly { id: string; label: string }[] = [
  { id: '10', label: 'PSA 10' },
  { id: '9.5', label: 'PSA 9.5' },
  { id: '9', label: 'PSA 9' },
  { id: '8.5', label: 'PSA 8.5' },
  { id: '8', label: 'PSA 8' },
  { id: '7.5', label: 'PSA 7.5' },
  { id: '7', label: 'PSA 7' },
] as const;

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
  if (Math.abs(value) >= 1000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }
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
  if (!Number.isFinite(diffMs) || diffMs < 60_000) {
    return 'Refreshed just now';
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `Refreshed ${minutes}m ago`;
  }
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) {
    return `Refreshed ${hours}h ago`;
  }
  const days = Math.floor(diffMs / 86_400_000);
  return `Refreshed ${days}d ago`;
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
  const title = `${count} similar`;

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
      <IconBolt color="#9C7A12" size={14} strokeWidth={2.2} />
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
  showAxisLabels = false,
  showGridLabels = false,
  tintColor,
}: {
  currencyCode: string;
  currentPrice: number;
  points: ChartPoint[];
  showAxisLabels?: boolean;
  showGridLabels?: boolean;
  tintColor: string;
}) {
  const theme = useSpotlightTheme();
  const width = 320;
  const height = 210;
  const paddingLeft = 8;
  const paddingRight = 16;
  const paddingTop = 16;
  const paddingBottom = 24;

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
        {showGridLabels ? (
          <View pointerEvents="none" style={styles.chartLabelColumn}>
            {gridValues.map((value, index) => (
              <View key={`${value}-${index}`} style={styles.chartLabelCell}>
                <Text
                  style={[theme.typography.caption, styles.chartGridLabel]}
                  testID={`detail-market-grid-label-${index}`}
                >
                  {compactCurrency(value, currencyCode)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.chartPlotArea}>
          {gridValues.map((_, index) => (
            <View key={`gridline-${index}`} style={styles.chartGridLineCell}>
              <View style={styles.chartGridLineBar} />
            </View>
          ))}

          <View
            pointerEvents="none"
            style={[styles.chartAxisLineVertical, {
              bottom: paddingBottom,
              left: 0,
              top: paddingTop,
            }]}
          />
          <View
            pointerEvents="none"
            style={[styles.chartAxisLineHorizontal, {
              bottom: paddingBottom - 1,
              left: 0,
              right: paddingRight,
            }]}
          />

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
      </View>

      {showAxisLabels ? (
        <View style={[styles.chartAxisRow, showGridLabels ? styles.chartAxisRowWithLabels : null]}>
          <Text style={[theme.typography.caption, styles.chartAxisText]}>{points[0]?.shortLabel}</Text>
          <Text style={[theme.typography.caption, styles.chartAxisText]}>{points[points.length - 1]?.shortLabel}</Text>
        </View>
      ) : null}
    </View>
  );
}

function TrendLabel({
  testID,
  value,
}: {
  testID: string;
  value: number | null | undefined;
}) {
  const theme = useSpotlightTheme();

  if (value == null || !Number.isFinite(value)) {
    return (
      <View style={styles.trendInline} testID={testID}>
        <Text style={[theme.typography.bodyStrong, styles.trendInlineMuted]}>—</Text>
      </View>
    );
  }

  const isUp = value >= 0;
  const tone = isUp ? theme.colors.success : theme.colors.danger;
  const Icon = isUp ? IconTrendingUp : IconTrendingDown;
  const formatted = `${isUp ? '+' : '-'}${Math.abs(value).toFixed(1)}%`;

  return (
    <View style={styles.trendInline} testID={testID}>
      <Icon color={tone} size={14} strokeWidth={2.2} />
      <Text style={[theme.typography.bodyStrong, { color: tone }]}>{formatted}</Text>
    </View>
  );
}

function ConditionDropdown({
  disabled,
  hideOptionPrice = false,
  onSelect,
  options,
  selectedId,
  selectedLabel,
  testID,
}: {
  disabled?: boolean;
  hideOptionPrice?: boolean;
  onSelect: (id: string) => void;
  options: { id: string; label: string; shortLabel: string; isAvailable: boolean; currentPrice: number | null }[];
  selectedId: string | null;
  selectedLabel: string;
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
                  {hideOptionPrice ? null : (
                    <Text style={[theme.typography.bodyStrong, styles.dropdownOptionPrice]}>
                      {option.currentPrice != null
                        ? formatCurrency(option.currentPrice, 'USD')
                        : '—'}
                    </Text>
                  )}
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
  const [hasResolvedRecentSalesState, setHasResolvedRecentSalesState] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedConditionId, setSelectedConditionId] = useState<string | null>(null);
  const [isFavoritePending, setIsFavoritePending] = useState(false);
  const [favoriteState, setFavoriteState] = useState<{ isFavorite: boolean; favoritedAt: string | null }>({
    favoritedAt: null,
    isFavorite: false,
  });
  const [selectedTimeframeId, setSelectedTimeframeId] = useState<TimeframeId>(defaultTimeframeId);
  const [showAllSales, setShowAllSales] = useState(false);
  const [pricesFetchedAt, setPricesFetchedAt] = useState<string | null>(null);
  const [slabGradeOverride, setSlabGradeOverride] = useState<string | null>(null);
  const [isQuantityMutationPending, setIsQuantityMutationPending] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [hasUserRequestedSales, setHasUserRequestedSales] = useState(false);
  const [isLoadingRecentSales, setIsLoadingRecentSales] = useState(false);
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
    setSelectedTimeframeId(defaultTimeframeId);
    setShowAllSales(false);
    setFavoriteState({ favoritedAt: null, isFavorite: false });
    setPricesFetchedAt(null);
    setSlabGradeOverride(null);
    setHasUserRequestedSales(false);
    setIsLoadingRecentSales(false);
  }, [cardId]);

  useEffect(() => {
    if (!detail) {
      return;
    }
    setFavoriteState({
      favoritedAt: detail.favoritedAt ?? null,
      isFavorite: detail.isFavorite ?? false,
    });
  }, [detail]);

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
  const selectedSlabContextForPricing = useMemo(() => {
    if (!selectedSlabContext) {
      return null;
    }
    if (!slabGradeOverride || slabGradeOverride === selectedSlabContext.grade) {
      return selectedSlabContext;
    }
    return { ...selectedSlabContext, certNumber: null, grade: slabGradeOverride };
  }, [selectedSlabContext, slabGradeOverride]);
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
    const requestedCondition = selectedSlabContextForPricing == null
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
      slabContext: selectedSlabContextForPricing,
      variant: selectedSlabContextForPricing?.variantName ?? undefined,
    })
      .then((nextHistory) => {
        if (!cancelled) {
          setMarketHistory(nextHistory);
          setPricesFetchedAt(new Date().toISOString());
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
  }, [cardId, dataVersion, detail?.marketHistory, selectedConditionId, selectedSlabContextForPricing, spotlightRepository]);

  useEffect(() => {
    setRecentSalesState(null);
    setHasResolvedRecentSalesState(false);
    setHasUserRequestedSales(false);
    setIsLoadingRecentSales(false);
  }, [cardId, dataVersion, selectedSlabContextForPricing]);

  const handleLoadRecentSales = useCallback(() => {
    if (!shouldShowRecentSales || !selectedSlabContextForPricing || isLoadingRecentSales) {
      return;
    }
    setHasUserRequestedSales(true);
    setIsLoadingRecentSales(true);
    void spotlightRepository.getCardRecentSales({
      cardId,
      limit: recentSalesPageSize,
      refresh: true,
      slabContext: selectedSlabContextForPricing,
      source: 'ebay',
    })
      .then((nextRecentSales) => {
        setRecentSalesState(nextRecentSales);
        setHasResolvedRecentSalesState(true);
      })
      .catch(() => {
        setHasResolvedRecentSalesState(true);
      })
      .finally(() => {
        setIsLoadingRecentSales(false);
      });
  }, [
    cardId,
    isLoadingRecentSales,
    selectedSlabContextForPricing,
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
  const isGradeOverridden = Boolean(
    slabGradeOverride && slabGradeOverride !== selectedSlabContext?.grade,
  );
  const slabDisplayedPrice = isSlabDetail && !isGradeOverridden
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

    return deckConditionOptions
      .map((option) => {
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
      })
      .filter((option) => option.isAvailable);
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
  const volumeLevel = effectiveMarketHistory?.volumeLevel ?? null;
  const shouldShowConditionPicker = (effectiveMarketHistory?.availableConditions.length ?? 0) > 1;
  const volumeLevelLabel = (() => {
    if (volumeLevel === 'low') {
      return 'Limited pricing data';
    }
    if (volumeLevel === 'unknown') {
      return 'Pricing data unavailable';
    }
    return null;
  })();
  const recentSales = shouldShowRecentSales ? recentSalesState : null;
  const sortedRecentSales = useMemo(
    () => recentSales?.sales.slice().sort(compareRecentSalesBySoldDateDesc) ?? [],
    [recentSales?.sales],
  );
  const visibleSales = useMemo(
    () => (showAllSales ? sortedRecentSales : sortedRecentSales.slice(0, slabLastSoldRowLimit)),
    [showAllSales, sortedRecentSales],
  );
  const hasMoreSales = sortedRecentSales.length > slabLastSoldRowLimit && !showAllSales;
  const salesEmptyCopy = useMemo(() => {
    if (!hasResolvedRecentSalesState) {
      return 'Loading recent sales…';
    }
    const state = recentSalesSectionState(recentSales);
    if (state === 'unavailable') {
      return 'eBay sales are unavailable for this slab right now.';
    }
    return 'No recent eBay sales found for this slab yet.';
  }, [hasResolvedRecentSalesState, recentSales]);

  const handleToggleFavorite = useCallback(() => {
    if (isFavoritePending) {
      return;
    }

    const previousFavoriteState = favoriteState;
    const nextIsFavorite = !favoriteState.isFavorite;
    setFavoriteState((current) => ({ ...current, isFavorite: nextIsFavorite }));
    setIsFavoritePending(true);

    void spotlightRepository.setCardFavorite(cardId, nextIsFavorite)
      .then((result) => {
        setFavoriteState({
          favoritedAt: result.favoritedAt ?? null,
          isFavorite: result.isFavorite,
        });
        setIsFavoritePending(false);
      })
      .catch(() => {
        setFavoriteState(previousFavoriteState);
        setErrorMessage('Could not update favorite right now.');
        setIsFavoritePending(false);
      });
  }, [cardId, favoriteState, isFavoritePending, spotlightRepository]);

  const handleDecrementQuantity = useCallback(() => {
    if (isQuantityMutationPending || !selectedEntry || selectedEntry.quantity <= 1) {
      return;
    }
    setIsQuantityMutationPending(true);
    void spotlightRepository.replacePortfolioEntry({
      cardID: selectedEntry.cardId,
      condition: selectedEntry.conditionCode ?? null,
      currencyCode: selectedEntry.currencyCode,
      deckEntryID: selectedEntry.id,
      quantity: selectedEntry.quantity - 1,
      slabContext: selectedEntry.slabContext ?? null,
      unitPrice: selectedEntry.costBasisPerUnit ?? 0,
      updatedAt: new Date().toISOString(),
      variantName: selectedEntry.variantName ?? null,
    })
      .then(() => {
        refreshData();
      })
      .catch(() => {
        setErrorMessage('Could not update quantity right now.');
      })
      .finally(() => {
        setIsQuantityMutationPending(false);
      });
  }, [isQuantityMutationPending, refreshData, selectedEntry, spotlightRepository]);

  const handleConfirmDelete = useCallback(() => {
    if (isQuantityMutationPending || !selectedEntry) {
      return;
    }
    setIsQuantityMutationPending(true);
    void spotlightRepository.deletePortfolioEntry({ deckEntryID: selectedEntry.id })
      .then(() => {
        refreshData();
        setIsDeleteConfirmOpen(false);
        onBack();
      })
      .catch(() => {
        setErrorMessage('Could not delete this card right now.');
        setIsDeleteConfirmOpen(false);
      })
      .finally(() => {
        setIsQuantityMutationPending(false);
      });
  }, [isQuantityMutationPending, onBack, refreshData, selectedEntry, spotlightRepository]);

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

  const timeframeDropdownOptions = useMemo(() => (
    timeframeOptions.map((option) => ({
      currentPrice: null,
      id: option.id,
      isAvailable: true,
      label: option.label,
      shortLabel: option.label,
    }))
  ), []);

  const selectedTimeframeLabel = useMemo(() => (
    timeframeOptions.find((option) => option.id === selectedTimeframeId)?.label ?? defaultTimeframeId
  ), [selectedTimeframeId]);

  const effectiveSlabGrade = (slabGradeOverride ?? selectedSlabContext?.grade ?? '').trim();
  const slabGradeDropdownOptions = useMemo(() => {
    const grader = selectedSlabContext?.grader?.toUpperCase() ?? 'PSA';
    const baseOptions = grader === 'PSA'
      ? psaSlabGradeOptions
      : [{ id: effectiveSlabGrade || '10', label: `${grader} ${effectiveSlabGrade || '10'}` }];
    const includesActive = baseOptions.some((option) => option.id === effectiveSlabGrade);
    const withActive = !effectiveSlabGrade || includesActive
      ? baseOptions
      : [...baseOptions, { id: effectiveSlabGrade, label: `${grader} ${effectiveSlabGrade}` }];
    return withActive.map((option) => ({
      currentPrice: null,
      id: option.id,
      isAvailable: true,
      label: option.label,
      shortLabel: option.id,
    }));
  }, [effectiveSlabGrade, selectedSlabContext?.grader]);
  const slabDropdownLabel = slabGradeDropdownOptions.find((option) => option.id === effectiveSlabGrade)?.label
    ?? slabGradeSummary(selectedSlabContext);

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
  const isFavorite = favoriteState.isFavorite;
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
    ? (slabDropdownLabel ?? 'Slab')
    : (selectedCondition?.label ?? 'Condition');

  const pricesFreshnessLabel = formatPricesFreshnessLabel(pricesFetchedAt ?? recentSales?.fetchedAt ?? null);

  const apiTrendValue = selectedTimeframeId === '7d'
    ? detail?.trendsPct?.days7
    : detail?.trendsPct?.days30;
  const trendValue = (() => {
    if (typeof apiTrendValue === 'number' && Number.isFinite(apiTrendValue)) {
      return apiTrendValue;
    }
    if (timeframeFilteredPoints.length < 2) {
      return null;
    }
    const first = timeframeFilteredPoints[0];
    const last = timeframeFilteredPoints[timeframeFilteredPoints.length - 1];
    if (!first || !last || first.value <= 0) {
      return null;
    }
    return ((last.value - first.value) / first.value) * 100;
  })();

  const inventoryQuantityLabel = selectedEntry ? `Qty ${selectedEntry.quantity}` : null;
  const slabCertNumber = (selectedSlabContext?.certNumber ?? selectedEntry?.slabContext?.certNumber ?? '').trim();
  const slabCertAndQuantityLine = isSlabDetail && slabCertNumber
    ? [`Cert #${slabCertNumber}`, inventoryQuantityLabel].filter(Boolean).join('  ·  ')
    : '';
  const slabHeroSubtitleDisplay = (() => {
    if (!slabHeroSubtitle) {
      return null;
    }
    if (isSlabDetail && !slabCertNumber && inventoryQuantityLabel) {
      return `${slabHeroSubtitle}  ·  ${inventoryQuantityLabel}`;
    }
    return slabHeroSubtitle;
  })();
  const hasMultipleVariants = (detail?.variantOptions?.length ?? 0) > 1;
  const rawInventoryLine = !isSlabDetail && selectedEntry?.kind === 'raw'
    ? [
      selectedEntry.conditionLabel?.trim() || null,
      hasMultipleVariants ? (selectedEntry.variantName?.trim() || null) : null,
      inventoryQuantityLabel,
    ].filter(Boolean).join('  ·  ')
    : '';

  const hasMarketHistoryPoints = timeframeFilteredPoints.length > 0;

  const safeNumericDisplayedPrice = typeof displayedPrice === 'number' && Number.isFinite(displayedPrice)
    ? displayedPrice
    : 0;

  const canShowSellAction = isOwned && Boolean(sellEntryId) && Boolean(onOpenSell);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <SellBackdrop imageUrl={displayImageUrl ?? undefined} variant="single" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <ChromeBackButton
            onPress={onBack}
            testID="detail-back"
          />
          {scanReviewId && similarScanCandidates.length > 0 ? (
            <SimilarCardsButton
              count={similarScanCandidates.length}
              onPress={() => {
                onOpenScanCandidateReview?.(scanReviewId);
              }}
            />
          ) : null}
        </View>

        <CardHero
          imageUrl={displayImageUrl}
          imageFallbackText={displayName}
          name={displayName}
          metaLines={[
            `${displayNumber(displayCardNumber)} • ${displaySetName}`,
            slabHeroSubtitleDisplay ?? '',
            slabCertAndQuantityLine,
          ]}
          favorite={{
            isFavorite,
            isPending: isFavoritePending,
            onToggle: handleToggleFavorite,
            color: favoriteHeartColor,
            testID: 'detail-favorite-card',
          }}
          belowMeta={
            isOwned && selectedEntry ? (
              <View style={styles.heroStepperRow} testID="detail-quantity-stepper">
                {selectedEntry.quantity <= 1 ? (
                  <IconButton
                    accessibilityLabel="Delete this card from your collection"
                    disabled={isQuantityMutationPending}
                    onPress={() => setIsDeleteConfirmOpen(true)}
                    testID="detail-quantity-delete"
                    variant="elevated"
                  >
                    <IconTrash color={theme.colors.danger} size={18} strokeWidth={2.1} />
                  </IconButton>
                ) : (
                  <IconButton
                    accessibilityLabel="Decrease quantity"
                    disabled={isQuantityMutationPending}
                    onPress={handleDecrementQuantity}
                    testID="detail-quantity-decrement"
                    variant="elevated"
                  >
                    <IconMinus color={theme.colors.textPrimary} size={18} strokeWidth={2.2} />
                  </IconButton>
                )}
                <Text
                  style={[theme.typography.bodyStrong, styles.heroStepperValue]}
                  testID="detail-quantity-value"
                >
                  {`Qty ${selectedEntry.quantity}`}
                </Text>
                <IconButton
                  accessibilityLabel="Add another copy"
                  onPress={() => onOpenAddToCollection(detail?.cardId ?? cardId, undefined)}
                  testID="detail-quantity-increment"
                  variant="elevated"
                >
                  <IconPlus color={theme.colors.textPrimary} size={18} strokeWidth={2.1} />
                </IconButton>
                {sellEntryId ? (
                  <IconButton
                    accessibilityLabel="Edit collection entry"
                    onPress={() => onOpenAddToCollection(detail?.cardId ?? cardId, sellEntryId)}
                    testID="detail-edit-collection-entry"
                    variant="elevated"
                  >
                    <IconPencil color={theme.colors.textPrimary} size={18} strokeWidth={2.1} />
                  </IconButton>
                ) : null}
              </View>
            ) : (
              <View style={styles.heroAddRow}>
                <IconButton
                  accessibilityLabel="Add to collection"
                  onPress={() => onOpenAddToCollection(detail?.cardId ?? cardId, undefined)}
                  testID="detail-add-to-collection"
                  variant="elevated"
                >
                  <IconPlus color={theme.colors.textPrimary} size={18} strokeWidth={2.1} />
                </IconButton>
                <Text style={[theme.typography.bodyStrong, styles.heroAddRowLabel]}>Add to collection</Text>
              </View>
            )
          }
          testID="detail-hero-card"
        />

        <View testID="detail-market-card">
          <SurfaceCard padding={18} radius={24} style={styles.marketCard}>
            <View style={styles.pricingTopRow}>
              {isSlabDetail ? (
                <ConditionDropdown
                  hideOptionPrice
                  onSelect={(id) => setSlabGradeOverride(id)}
                  options={slabGradeDropdownOptions}
                  selectedId={effectiveSlabGrade || null}
                  selectedLabel={conditionDropdownLabel}
                  testID="detail-condition-dropdown"
                />
              ) : null}
              {pricesFreshnessLabel ? (
                <Text
                  style={[theme.typography.caption, styles.priceFreshnessLabel]}
                  testID="detail-prices-freshness"
                >
                  {pricesFreshnessLabel}
                </Text>
              ) : null}
            </View>

            <View style={styles.pricingPriceBlockCentered}>
              <Text
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                numberOfLines={1}
                style={[theme.typography.display, styles.marketValueCentered]}
                testID="detail-market-price"
              >
                {formatOptionalCurrency(displayedPrice, displayCurrencyCode)}
              </Text>
              <Text style={[theme.typography.caption, styles.priceColumnLabelCentered]}>
                Market avg.
              </Text>
              <View style={styles.trendCenteredRow}>
                {Number.isFinite(displayedPrice) && (displayedPrice ?? 0) > 0 ? (
                  <TrendLabel testID="detail-market-trend" value={trendValue} />
                ) : null}
                <ConditionDropdown
                  hideOptionPrice
                  onSelect={(id) => setSelectedTimeframeId(id as TimeframeId)}
                  options={timeframeDropdownOptions}
                  selectedId={selectedTimeframeId}
                  selectedLabel={selectedTimeframeLabel}
                  testID="detail-timeframe-dropdown"
                />
              </View>
              {!isSlabDetail && volumeLevelLabel ? (
                <Text
                  style={[theme.typography.caption, styles.priceColumnLabelCentered]}
                  testID="detail-volume-level-label"
                >
                  {volumeLevelLabel}
                </Text>
              ) : null}
            </View>

            {!isSlabDetail && shouldShowConditionPicker && marketConditionOptions.length > 0 ? (
              <View style={styles.conditionChipsRow} testID="detail-condition-chips">
                {marketConditionOptions.map((option) => {
                  const isSelected = option.id === (selectedCondition?.id ?? null);
                  return (
                    <Pressable
                      accessibilityLabel={`Show ${option.label} price`}
                      accessibilityRole="button"
                      key={option.id}
                      onPress={() => setSelectedConditionId(option.id)}
                      style={({ pressed }) => [
                        styles.conditionChip,
                        isSelected ? styles.conditionChipSelected : null,
                        pressed ? styles.conditionChipPressed : null,
                      ]}
                      testID={`detail-condition-chip-${option.id}`}
                    >
                      <Text
                        style={[
                          theme.typography.caption,
                          styles.conditionChipShort,
                          isSelected ? styles.conditionChipShortSelected : null,
                        ]}
                      >
                        {option.shortLabel}
                      </Text>
                      <Text
                        style={[
                          theme.typography.bodyStrong,
                          styles.conditionChipPrice,
                          isSelected ? styles.conditionChipPriceSelected : null,
                        ]}
                      >
                        {option.currentPrice != null
                          ? formatCurrency(option.currentPrice, displayCurrencyCode)
                          : '—'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {hasMarketHistoryPoints ? (
              <View style={styles.pricingChartWrap} testID="detail-history-chart">
                <HistoryChart
                  currencyCode={displayCurrencyCode}
                  currentPrice={safeNumericDisplayedPrice}
                  points={timeframeFilteredPoints}
                  showAxisLabels
                  showGridLabels
                  tintColor={marketTint}
                />
              </View>
            ) : null}

            {isSlabDetail ? (
              <View style={styles.latestSalesSection} testID="detail-slab-last-sold">
                <Text style={[theme.typography.caption, styles.latestSalesHeader]}>
                  Latest sales from eBay
                </Text>
                {!hasUserRequestedSales ? (
                  <Button
                    disabled={isLoadingRecentSales}
                    label={isLoadingRecentSales ? 'Loading…' : 'Load eBay sales'}
                    onPress={handleLoadRecentSales}
                    size="lg"
                    style={styles.loadEbaySalesButton}
                    testID="detail-slab-load-ebay-sales"
                    variant="secondary"
                  />
                ) : null}
                {hasUserRequestedSales && hasResolvedRecentSalesState && visibleSales.length === 0 ? (
                  <View style={styles.latestSalesEmpty} testID="detail-slab-last-sold-empty">
                    <Text style={[theme.typography.body, styles.latestSalesEmptyText]}>
                      {salesEmptyCopy}
                    </Text>
                  </View>
                ) : null}
                {hasUserRequestedSales && visibleSales.length > 0 ? (
                  <>
                    {visibleSales.map((sale, index) => {
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
                    {hasMoreSales ? (
                      <Button
                        label="Load more sales"
                        onPress={() => setShowAllSales(true)}
                        size="lg"
                        style={styles.loadMoreButton}
                        testID="detail-slab-load-more-sales"
                        variant="secondary"
                      />
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={!marketplaceUrl}
                onPress={marketplaceUrl
                  ? () => {
                      void Linking.openURL(marketplaceUrl);
                    }
                  : undefined}
                style={({ pressed }) => [
                  styles.inlineMarketplaceRow,
                  { opacity: marketplaceUrl ? (pressed ? 0.72 : 1) : 0.5 },
                ]}
                testID="detail-marketplace-cta"
              >
                <View style={styles.inlineMarketplaceDivider} />
                <View style={styles.inlineMarketplaceContent}>
                  <Text style={[theme.typography.bodyStrong, styles.inlineMarketplaceLabel]}>
                    View on TCGplayer
                  </Text>
                  <Image
                    source={require('../../../../assets/images/tcgplayer-icon.png')}
                    style={styles.marketplaceIcon}
                    testID="detail-marketplace-icon"
                  />
                </View>
              </Pressable>
            )}
          </SurfaceCard>
        </View>

      </ScrollView>

      {canShowSellAction ? (
        <View style={styles.stickySellFooter} testID="detail-sticky-sell-footer">
          <Button
            contentStyle={styles.sellButtonContent}
            label={
              Number.isFinite(safeNumericDisplayedPrice) && safeNumericDisplayedPrice > 0
                ? `Sell · ${formatCurrency(safeNumericDisplayedPrice, displayCurrencyCode)}`
                : 'Sell card'
            }
            labelStyle={styles.sellButtonLabel}
            leadingAccessory={<IconCash color="#1A1A1A" size={20} strokeWidth={2.2} />}
            onPress={() => {
              if (sellEntryId && onOpenSell) {
                onOpenSell(sellEntryId);
              }
            }}
            size="lg"
            style={styles.sellButton}
            testID="detail-sell-card"
            variant="primary"
          />
        </View>
      ) : null}

      <Modal
        animationType="fade"
        onRequestClose={() => setIsDeleteConfirmOpen(false)}
        transparent
        visible={isDeleteConfirmOpen}
      >
        <Pressable
          accessibilityLabel="Cancel delete"
          onPress={() => setIsDeleteConfirmOpen(false)}
          style={styles.dropdownBackdrop}
          testID="detail-delete-confirm-backdrop"
        >
          <Pressable onPress={() => undefined} style={styles.deleteConfirmSheet}>
            <Text style={[theme.typography.titleCompact, styles.deleteConfirmTitle]}>
              Delete this card?
            </Text>
            <Text style={[theme.typography.body, styles.deleteConfirmBody]}>
              {`This removes ${displayName || 'this card'} from your collection. You can’t undo this.`}
            </Text>
            <View style={styles.deleteConfirmActions}>
              <Button
                label="Cancel"
                onPress={() => setIsDeleteConfirmOpen(false)}
                size="lg"
                style={styles.deleteConfirmCancel}
                testID="detail-delete-confirm-cancel"
                variant="secondary"
              />
              <Button
                disabled={isQuantityMutationPending}
                label="Delete"
                labelStyle={styles.deleteConfirmDeleteLabel}
                onPress={handleConfirmDelete}
                size="lg"
                style={styles.deleteConfirmDelete}
                testID="detail-delete-confirm-confirm"
                variant="primary"
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  chartAxisLineHorizontal: {
    backgroundColor: 'rgba(15, 15, 18, 0.18)',
    height: 1,
    position: 'absolute',
  },
  chartAxisLineVertical: {
    backgroundColor: 'rgba(15, 15, 18, 0.18)',
    position: 'absolute',
    width: 1,
  },
  chartAxisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  chartAxisRowWithLabels: {
    paddingLeft: 72,
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
    flexDirection: 'row',
    height: 200,
    overflow: 'hidden',
    paddingVertical: 14,
  },
  chartGridLabel: {
    color: 'rgba(15, 15, 18, 0.38)',
  },
  chartGridLineBar: {
    backgroundColor: 'rgba(15, 15, 18, 0.08)',
    height: 1,
    width: '100%',
  },
  chartGridLineCell: {
    flex: 1,
    justifyContent: 'center',
  },
  chartLabelCell: {
    flex: 1,
    justifyContent: 'center',
  },
  chartLabelColumn: {
    paddingLeft: 12,
    paddingRight: 6,
    width: 72,
  },
  chartPlotArea: {
    flex: 1,
    position: 'relative',
  },
  chartSvg: {
    ...StyleSheet.absoluteFillObject,
  },
  content: {
    gap: 16,
    paddingBottom: 120,
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
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
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
  heroAddRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  heroAddRowLabel: {
    color: '#0F0F12',
  },
  heroCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(255, 255, 255, 0.62)',
    borderWidth: 1,
    gap: 14,
    position: 'relative',
  },
  heroCopy: {
    alignItems: 'flex-start',
    flex: 1,
    gap: 6,
    minWidth: 0,
  },
  heroFavoriteButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    position: 'absolute',
    right: 12,
    top: 12,
    width: 36,
    zIndex: 2,
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
  heroInventoryLine: {
    color: 'rgba(15, 15, 18, 0.62)',
    width: '100%',
  },
  heroSubtitle: {
    width: '100%',
  },
  heroBlock: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  heroStepperRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
  },
  heroStepperValue: {
    color: '#0F0F12',
  },
  heroImageStage: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroImageLarge: {
    height: 320,
    resizeMode: 'contain',
    width: 224,
  },
  heroImageFallback: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    height: 320,
    justifyContent: 'center',
    paddingHorizontal: 16,
    width: 224,
  },
  heroTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 4,
    paddingHorizontal: 16,
  },
  heroTitleCentered: {
    flexShrink: 1,
    textAlign: 'center',
  },
  heroFavoriteInline: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  heroMetaCentered: {
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  inventorySection: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(15, 15, 18, 0.08)',
    borderRadius: 24,
    borderWidth: 1,
    gap: 10,
    padding: 18,
  },
  inventoryHeading: {
    color: '#0F0F12',
  },
  inventoryActionsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  inlineMarketplaceContent: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
  },
  inlineMarketplaceDivider: {
    backgroundColor: 'rgba(15, 15, 18, 0.08)',
    height: 1,
    width: '100%',
  },
  inlineMarketplaceLabel: {
    color: '#0F0F12',
    flex: 1,
    textAlign: 'left',
  },
  inlineMarketplaceRow: {
    gap: 0,
  },
  latestSalesEmpty: {
    backgroundColor: '#F7F8FA',
    borderColor: 'rgba(15, 15, 18, 0.08)',
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  latestSalesEmptyText: {
    color: 'rgba(15, 15, 18, 0.62)',
  },
  latestSalesHeader: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  latestSalesSection: {
    gap: 8,
  },
  lazyDetailCopy: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  lazyMarketBlock: {
    gap: 8,
  },
  loadEbaySalesButton: {
    marginTop: 4,
  },
  loadMoreButton: {
    marginTop: 4,
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
  },
  marketplaceIcon: {
    borderRadius: 8,
    height: 26,
    width: 26,
  },
  previewMarketValue: {
    color: '#0F0F12',
    fontSize: 48,
    fontWeight: '800',
    lineHeight: 56,
  },
  priceColumnLabel: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  priceFreshnessLabel: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  conditionChip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  conditionChipPressed: {
    opacity: 0.86,
  },
  conditionChipPrice: {
    color: colors.textPrimary,
  },
  conditionChipPriceSelected: {
    color: '#000000',
  },
  conditionChipSelected: {
    backgroundColor: colors.brand,
  },
  conditionChipShort: {
    color: colors.textSecondary,
    marginBottom: 2,
  },
  conditionChipShortSelected: {
    color: '#000000',
  },
  conditionChipsRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 12,
  },
  pricingChartWrap: {
    width: '100%',
  },
  pricingPriceBlockCentered: {
    alignItems: 'center',
    gap: 4,
    width: '100%',
  },
  marketValueCentered: {
    textAlign: 'center',
  },
  priceColumnLabelCentered: {
    color: 'rgba(15, 15, 18, 0.62)',
    textAlign: 'center',
  },
  trendCenteredRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 2,
  },
  pricingPriceBlock: {
    gap: 2,
  },
  pricingPriceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    width: '100%',
  },
  quantityStepperRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  quantityValue: {
    color: '#0F0F12',
    minWidth: 48,
    textAlign: 'center',
  },
  sellButton: {
    width: '100%',
  },
  stickySellFooter: {
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderTopColor: colors.outlineSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 12,
    position: 'absolute',
    right: 0,
  },
  sellButtonContent: {
    justifyContent: 'center',
  },
  sellButtonLabel: {
    color: '#1A1A1A',
    letterSpacing: 0.6,
  },
  deleteConfirmActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  deleteConfirmBody: {
    color: 'rgba(15, 15, 18, 0.72)',
  },
  deleteConfirmCancel: {
    flex: 1,
  },
  deleteConfirmDelete: {
    backgroundColor: '#E5484D',
    borderColor: '#E5484D',
    flex: 1,
  },
  deleteConfirmDeleteLabel: {
    color: '#FFFFFF',
  },
  deleteConfirmSheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    gap: 12,
    padding: 20,
    width: '100%',
  },
  deleteConfirmTitle: {
    color: '#0F0F12',
  },
  pricingTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  safeArea: {
    flex: 1,
  },
  similarCardsButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: '#F4D230',
    borderRadius: 999,
    borderWidth: 1.4,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  similarCardsButtonPressed: {
    opacity: 0.9,
  },
  similarCardsChevron: {
    color: 'rgba(15, 15, 18, 0.68)',
    fontSize: 18,
    fontWeight: '500',
    lineHeight: 20,
  },
  similarCardsTitle: {
    color: '#0F0F12',
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
  trendAndPickerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  trendInline: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  trendInlineMuted: {
    color: 'rgba(15, 15, 18, 0.42)',
  },
});
