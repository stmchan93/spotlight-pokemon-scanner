import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type {
  CatalogSearchResult,
  PortfolioImportCommitResponsePayload,
  PortfolioImportJobRecord,
  PortfolioImportRowFilter,
  PortfolioImportRowRecord,
  PortfolioImportSummary,
} from '@spotlight/api-client';
import {
  Button,
  PillButton,
  SearchField,
  SheetHeader,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

import {
  type PortfolioImportSelectedFile,
  portfolioImportSourceCopy,
} from '../portfolio-import-file';
import { takePendingPortfolioImportFile } from '../portfolio-import-session';

const filterOrder: readonly PortfolioImportRowFilter[] = [
  'all',
  'ready',
  'review',
  'unresolved',
  'unsupported',
  'committed',
] as const;

function emptySummary(): PortfolioImportSummary {
  return {
    totalRowCount: 0,
    matchedCount: 0,
    reviewCount: 0,
    unresolvedCount: 0,
    unsupportedCount: 0,
    readyToCommitCount: 0,
    committedCount: 0,
    skippedCount: 0,
  };
}

function isReadyToCommit(row: PortfolioImportRowRecord) {
  return row.matchState === 'matched' || row.matchState === 'ready';
}

function needsResolution(row: PortfolioImportRowRecord) {
  return row.matchState === 'review'
    || row.matchState === 'unresolved'
    || row.matchState === 'failed'
    || row.matchState === 'unknown';
}

function canResolveRow(row: PortfolioImportRowRecord) {
  return needsResolution(row) || isReadyToCommit(row);
}

function rowStateTitle(row: PortfolioImportRowRecord) {
  switch (row.matchState) {
    case 'matched':
      return 'Matched';
    case 'review':
      return 'Review';
    case 'unresolved':
      return 'Missing';
    case 'unsupported':
      return 'Unsupported';
    case 'skipped':
      return 'Skipped';
    case 'ready':
      return 'Ready';
    case 'committed':
      return 'Imported';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
}

function filterTitle(filter: PortfolioImportRowFilter) {
  switch (filter) {
    case 'all':
      return 'All';
    case 'ready':
      return 'Ready';
    case 'review':
      return 'Review';
    case 'unresolved':
      return 'Missing';
    case 'unsupported':
      return 'Unsupported';
    case 'committed':
      return 'Imported';
  }
}

function detailLine(row: PortfolioImportRowRecord) {
  return [row.setName, row.collectorNumber, row.conditionLabel]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(' • ');
}

function priceLine(row: PortfolioImportRowRecord) {
  if (typeof row.acquisitionUnitPrice === 'number') {
    return `Cost ${formatCurrency(row.acquisitionUnitPrice, row.currencyCode ?? 'USD')}`;
  }

  if (typeof row.marketUnitPrice === 'number') {
    return `Market ${formatCurrency(row.marketUnitPrice, row.currencyCode ?? 'USD')}`;
  }

  return null;
}

function summaryForRows(rows: PortfolioImportRowRecord[]): PortfolioImportSummary {
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
  }, emptySummary());
}

function defaultFilterForJob(job: PortfolioImportJobRecord): PortfolioImportRowFilter {
  if (job.summary.reviewCount > 0) {
    return 'review';
  }

  if (job.summary.unresolvedCount > 0) {
    return 'unresolved';
  }

  if (job.summary.readyToCommitCount > 0) {
    return 'ready';
  }

  if (job.summary.unsupportedCount > 0) {
    return 'unsupported';
  }

  if (job.summary.committedCount > 0) {
    return 'committed';
  }

  return 'all';
}

function filterRows(rows: PortfolioImportJobRecord['rows'], filter: PortfolioImportRowFilter) {
  switch (filter) {
    case 'all':
      return rows;
    case 'ready':
      return rows.filter(isReadyToCommit);
    case 'review':
      return rows.filter((row) => row.matchState === 'review');
    case 'unresolved':
      return rows.filter((row) => row.matchState === 'unresolved' || row.matchState === 'failed' || row.matchState === 'unknown');
    case 'unsupported':
      return rows.filter((row) => row.matchState === 'unsupported' || row.matchState === 'skipped');
    case 'committed':
      return rows.filter((row) => row.matchState === 'committed');
  }
}

function statusTitle(job: PortfolioImportJobRecord | null) {
  switch (job?.status) {
    case 'previewing':
      return 'Previewing';
    case 'needs_review':
      return 'Needs review';
    case 'ready':
      return 'Ready';
    case 'committing':
      return 'Importing';
    case 'completed':
      return 'Imported';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
}

function errorMessageFromUnknown(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

type PortfolioImportScreenProps = {
  onClose: () => void;
};

type ResolveRowModalProps = {
  visible: boolean;
  row: PortfolioImportRowRecord | null;
  onClose: () => void;
  onResolve: (row: PortfolioImportRowRecord, candidate: CatalogSearchResult) => Promise<boolean>;
  onSearch: (query: string, limit: number) => Promise<CatalogSearchResult[]>;
  onSkip: (row: PortfolioImportRowRecord) => Promise<boolean>;
};

function ResolveRowModal({
  visible,
  row,
  onClose,
  onResolve,
  onSearch,
  onSkip,
}: ResolveRowModalProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !row) {
      setQuery('');
      setResults([]);
      setLocalErrorMessage(null);
      setIsSubmitting(false);
      return;
    }

    setQuery(row.sourceCardName);
    setLocalErrorMessage(null);
  }, [row, visible]);

  useEffect(() => {
    if (!visible || !row) {
      return;
    }

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(async () => {
      setIsSearching(true);
      setLocalErrorMessage(null);

      try {
        const searchResults = await onSearch(trimmed, 16);
        if (!cancelled) {
          setResults(searchResults);
        }
      } catch (error) {
        if (!cancelled) {
          setLocalErrorMessage(errorMessageFromUnknown(error, 'Search is unavailable right now.'));
        }
      } finally {
        if (!cancelled) {
          setIsSearching(false);
        }
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [onSearch, query, row, visible]);

  const suggestedCandidates = row?.candidateCards ?? [];

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      transparent={false}
      visible={visible}
    >
      <SafeAreaView
        edges={['top', 'left', 'right']}
        style={[
          styles.safeArea,
          {
            backgroundColor: theme.colors.canvas,
          },
        ]}
      >
        <View style={styles.resolveScreen}>
          <View style={styles.resolveHeader}>
            <SheetHeader
              align="center"
              leadingAccessory={(
                <Button
                  label="Close"
                  onPress={onClose}
                  size="md"
                  testID="portfolio-import-resolve-close"
                  variant="secondary"
                />
              )}
              rightAccessory={<View style={styles.resolveHeaderSpacer} />}
              title="Resolve Row"
            />
          </View>

          <ScrollView
            contentContainerStyle={[
              styles.resolveContent,
              {
                paddingBottom: Math.max(insets.bottom + 20, 28),
              },
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {row ? (
              <>
                <SurfaceCard padding={18} radius={28}>
                  <View style={styles.resolveRowCard}>
                    <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                      {row.sourceCardName.trim() || `Row ${Math.max(1, row.rowIndex)}`}
                    </Text>
                    {detailLine(row) ? (
                      <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                        {detailLine(row)}
                      </Text>
                    ) : null}

                    <View style={styles.rowPillWrap}>
                      <View style={[styles.inlinePill, { backgroundColor: theme.colors.field }]}>
                        <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                          Qty {Math.max(1, row.quantity)}
                        </Text>
                      </View>
                      {row.sourceCollectionName ? (
                        <View style={[styles.inlinePill, { backgroundColor: theme.colors.field }]}>
                          <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                            {row.sourceCollectionName}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </SurfaceCard>

                <SearchField
                  autoCapitalize="none"
                  autoCorrect={false}
                  containerStyle={styles.resolveSearchField}
                  containerTestID="portfolio-import-search-shell"
                  onChangeText={setQuery}
                  placeholder="Search by name, set, or number"
                  testID="portfolio-import-search-input"
                  value={query}
                />

                {localErrorMessage ? (
                  <SurfaceCard padding={16} radius={24} variant="muted">
                    <Text style={[theme.typography.body, { color: theme.colors.danger }]}>
                      {localErrorMessage}
                    </Text>
                  </SurfaceCard>
                ) : null}

                {!query.trim() || query.trim().length < 2 ? (
                  suggestedCandidates.length > 0 ? (
                    <View style={styles.resolveSection}>
                      <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
                        Suggested Matches
                      </Text>
                      <View style={styles.resolveCandidates}>
                        {suggestedCandidates.map((candidate) => (
                          <CandidateButton
                            candidate={candidate}
                            isSubmitting={isSubmitting}
                            key={candidate.id}
                            onPress={async () => {
                              if (!row || isSubmitting) {
                                return;
                              }

                              setIsSubmitting(true);
                              setLocalErrorMessage(null);

                              const didResolve = await onResolve(row, candidate);
                              if (didResolve) {
                                onClose();
                              } else {
                                setLocalErrorMessage('That card could not be applied to this row.');
                              }

                              setIsSubmitting(false);
                            }}
                          />
                        ))}
                      </View>
                    </View>
                  ) : null
                ) : isSearching ? (
                  <View style={styles.resolveLoadingWrap}>
                    <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>Searching…</Text>
                  </View>
                ) : results.length > 0 ? (
                  <View style={styles.resolveSection}>
                    <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
                      Search Results
                    </Text>
                    <View style={styles.resolveCandidates}>
                      {results.map((candidate) => (
                        <CandidateButton
                          candidate={candidate}
                          isSubmitting={isSubmitting}
                          key={candidate.id}
                          onPress={async () => {
                            if (!row || isSubmitting) {
                              return;
                            }

                            setIsSubmitting(true);
                            setLocalErrorMessage(null);

                            const didResolve = await onResolve(row, candidate);
                            if (didResolve) {
                              onClose();
                            } else {
                              setLocalErrorMessage('That card could not be applied to this row.');
                            }

                            setIsSubmitting(false);
                          }}
                        />
                      ))}
                    </View>
                  </View>
                ) : (
                  <SurfaceCard padding={16} radius={24} variant="muted">
                    <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                      No cards match that search yet.
                    </Text>
                  </SurfaceCard>
                )}

                <Button
                  disabled={isSubmitting}
                  label="Skip This Row"
                  onPress={async () => {
                    if (!row || isSubmitting) {
                      return;
                    }

                    setIsSubmitting(true);
                    setLocalErrorMessage(null);

                    const didSkip = await onSkip(row);
                    if (didSkip) {
                      onClose();
                    } else {
                      setLocalErrorMessage('This row could not be skipped right now.');
                    }

                    setIsSubmitting(false);
                  }}
                  size="lg"
                  style={styles.skipButton}
                  testID="portfolio-import-skip-row"
                  variant="secondary"
                />
              </>
            ) : null}
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

type CandidateButtonProps = {
  candidate: CatalogSearchResult;
  isSubmitting: boolean;
  onPress: () => void;
};

function CandidateButton({ candidate, isSubmitting, onPress }: CandidateButtonProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityRole="button"
      disabled={isSubmitting}
      onPress={onPress}
      style={({ pressed }) => [
        styles.candidateButton,
        {
          backgroundColor: theme.colors.canvasElevated,
          borderColor: theme.colors.outlineSubtle,
          opacity: isSubmitting ? 0.72 : pressed ? 0.88 : 1,
        },
      ]}
    >
      {candidate.imageUrl ? (
        <Image source={{ uri: candidate.imageUrl }} style={styles.candidateArt} />
      ) : (
        <View style={[styles.candidateArtFallback, { backgroundColor: theme.colors.field }]}>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>Card</Text>
        </View>
      )}

      <View style={styles.candidateCopy}>
        <Text numberOfLines={2} style={[theme.typography.bodyStrong, { color: theme.colors.textPrimary }]}>
          {candidate.name}
        </Text>
        <Text numberOfLines={2} style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {[candidate.setName, candidate.cardNumber].filter(Boolean).join(' • ')}
        </Text>
        {candidate.ownedQuantity ? (
          <Text style={[theme.typography.caption, { color: theme.colors.brand }]}>
            Owned {candidate.ownedQuantity}
          </Text>
        ) : null}
      </View>

      <Text style={[theme.typography.control, styles.candidateUseLabel, { color: theme.colors.brand }]}>
        Use
      </Text>
    </Pressable>
  );
}

export function PortfolioImportScreen({ onClose }: PortfolioImportScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { refreshData, spotlightRepository } = useAppServices();
  const [selectedFile] = useState<PortfolioImportSelectedFile | null>(() => takePendingPortfolioImportFile());
  const [job, setJob] = useState<PortfolioImportJobRecord | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<PortfolioImportRowFilter>('all');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<PortfolioImportRowRecord | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const hasLoaded = useRef(false);

  const applyJob = useCallback((nextJob: PortfolioImportJobRecord, preserveFilter = false) => {
    setJob(nextJob);
    setErrorMessage(null);
    setSelectedFilter((currentFilter) => {
      if (preserveFilter && filterRows(nextJob.rows, currentFilter).length > 0) {
        return currentFilter;
      }

      return defaultFilterForJob(nextJob);
    });
  }, []);

  const loadPreview = useCallback(async () => {
    if (!selectedFile) {
      setErrorMessage('Pick a CSV file from Account before opening import review.');
      return;
    }

    setIsLoadingPreview(true);
    setBannerMessage(null);
    setErrorMessage(null);

    try {
      const previewJob = await spotlightRepository.previewPortfolioImport({
        sourceType: selectedFile.sourceType,
        fileName: selectedFile.fileName,
        csvText: selectedFile.csvText,
      });
      applyJob(previewJob);
      capturePostHogEvent('portfolio_import_preview_succeeded', {
        row_count: previewJob.summary.totalRowCount,
      });
    } catch (error) {
      setErrorMessage(errorMessageFromUnknown(error, 'Import preview failed.'));
    } finally {
      setIsLoadingPreview(false);
    }
  }, [applyJob, selectedFile, spotlightRepository]);

  useEffect(() => {
    if (hasLoaded.current) {
      return;
    }

    hasLoaded.current = true;
    void loadPreview();
  }, [loadPreview]);

  const readyRowCount = job?.summary.readyToCommitCount
    ?? summaryForRows(job?.rows ?? []).readyToCommitCount;
  const filteredRows = useMemo(() => filterRows(job?.rows ?? [], selectedFilter), [job?.rows, selectedFilter]);
  const fileCopy = selectedFile ? portfolioImportSourceCopy[selectedFile.sourceType] : null;
  const canCommit = readyRowCount > 0 && !isCommitting;

  const refreshJob = useCallback(async () => {
    if (!job?.id) {
      await loadPreview();
      return;
    }

    setIsRefreshing(true);
    setErrorMessage(null);

    try {
      const refreshedJob = await spotlightRepository.fetchPortfolioImportJob(job.id);
      applyJob(refreshedJob, true);
    } catch (error) {
      setErrorMessage(errorMessageFromUnknown(error, 'Import job refresh failed.'));
    } finally {
      setIsRefreshing(false);
    }
  }, [applyJob, job?.id, loadPreview, spotlightRepository]);

  const resolveRow = useCallback(async (row: PortfolioImportRowRecord, candidate: CatalogSearchResult) => {
    if (!job?.id) {
      return false;
    }

    try {
      const updatedJob = await spotlightRepository.resolvePortfolioImportRow(job.id, {
        rowID: row.id,
        action: 'match',
        matchedCardID: candidate.cardId,
      });
      setBannerMessage(`Matched row ${Math.max(1, row.rowIndex)} to ${candidate.name}.`);
      applyJob(updatedJob, true);
      return true;
    } catch (error) {
      setErrorMessage(errorMessageFromUnknown(error, 'Import row update failed.'));
      return false;
    }
  }, [applyJob, job?.id, spotlightRepository]);

  const skipRow = useCallback(async (row: PortfolioImportRowRecord) => {
    if (!job?.id) {
      return false;
    }

    try {
      const updatedJob = await spotlightRepository.resolvePortfolioImportRow(job.id, {
        rowID: row.id,
        action: 'skip',
      });
      setBannerMessage(`Skipped row ${Math.max(1, row.rowIndex)}.`);
      applyJob(updatedJob, true);
      return true;
    } catch (error) {
      setErrorMessage(errorMessageFromUnknown(error, 'Import row update failed.'));
      return false;
    }
  }, [applyJob, job?.id, spotlightRepository]);

  const commitRows = useCallback(async () => {
    if (!job?.id || isCommitting) {
      return;
    }

    setIsCommitting(true);
    setErrorMessage(null);

    try {
      const response: PortfolioImportCommitResponsePayload = await spotlightRepository.commitPortfolioImportJob(job.id);
      if (response.job) {
        applyJob(response.job);
      } else {
        const refreshedJob = await spotlightRepository.fetchPortfolioImportJob(job.id);
        applyJob(refreshedJob);
      }
      capturePostHogEvent('portfolio_import_commit_succeeded', {
        committed_count: response.summary.committedCount,
      });
      refreshData();
      setBannerMessage(
        response.message?.trim()
          || `Imported ${Math.max(0, response.summary.committedCount)} row${response.summary.committedCount === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      setErrorMessage(errorMessageFromUnknown(error, 'Import commit failed.'));
    } finally {
      setIsCommitting(false);
    }
  }, [applyJob, isCommitting, job?.id, refreshData, spotlightRepository]);

  return (
    <>
      <SafeAreaView
        edges={['top', 'left', 'right']}
        style={[
          styles.safeArea,
          {
            backgroundColor: theme.colors.canvas,
          },
        ]}
      >
        <View style={styles.screen}>
          <View style={[styles.header, { paddingHorizontal: theme.layout.pageGutter }]}>
            <SheetHeader
              align="center"
              leadingAccessory={(
                <Button
                  label="Close"
                  onPress={onClose}
                  style={styles.headerButton}
                  testID="portfolio-import-close"
                  variant="secondary"
                />
              )}
              rightAccessory={(
                <Button
                  disabled={isLoadingPreview || isRefreshing}
                  label="Refresh"
                  onPress={() => {
                    void refreshJob();
                  }}
                  style={styles.headerButton}
                  testID="portfolio-import-refresh"
                  trailingAccessory={(
                    <Text style={[theme.typography.control, { color: theme.colors.textPrimary }]}>
                      {isRefreshing ? '…' : '↻'}
                    </Text>
                  )}
                  variant="secondary"
                />
              )}
              title={fileCopy?.reviewTitle ?? 'Import Review'}
            />
          </View>

          <ScrollView
            contentContainerStyle={[
              styles.content,
              {
                paddingBottom: canCommit ? 164 : Math.max(insets.bottom + 24, 36),
                paddingHorizontal: theme.layout.pageGutter,
                paddingTop: theme.layout.pageTopInset,
              },
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <SurfaceCard padding={20} radius={30}>
              <View style={styles.heroCard}>
                <View style={styles.heroCopy}>
                  <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                    {fileCopy?.reviewTitle ?? 'Portfolio Import'}
                  </Text>
                  {selectedFile ? (
                    <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                      {selectedFile.fileName}
                    </Text>
                  ) : null}
                  <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                    Review every row before anything touches your inventory. Ready rows can be imported immediately,
                    and the rest can be fixed in place.
                  </Text>
                </View>

                <View style={[styles.statusBadge, { backgroundColor: theme.colors.brand }]}>
                  <Text style={[theme.typography.caption, styles.statusBadgeText]}>
                    {statusTitle(job)}
                  </Text>
                </View>
              </View>
            </SurfaceCard>

            {bannerMessage ? (
              <SurfaceCard padding={16} radius={24} variant="muted">
                <Text style={[theme.typography.bodyStrong, { color: theme.colors.textPrimary }]}>Updated</Text>
                <Text style={[theme.typography.body, styles.messageCopy, { color: theme.colors.textSecondary }]}>
                  {bannerMessage}
                </Text>
              </SurfaceCard>
            ) : null}

            {errorMessage ? (
              <SurfaceCard padding={16} radius={24} variant="muted">
                <Text style={[theme.typography.bodyStrong, { color: theme.colors.textPrimary }]}>Import issue</Text>
                <Text style={[theme.typography.body, styles.messageCopy, { color: theme.colors.danger }]}>
                  {errorMessage}
                </Text>
              </SurfaceCard>
            ) : null}

            {isLoadingPreview && !job ? (
              <SurfaceCard padding={24} radius={28}>
                <View style={styles.loadingCard}>
                  <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
                    Building your preview
                  </Text>
                  <Text style={[theme.typography.body, styles.centeredCopy, { color: theme.colors.textSecondary }]}>
                    Parsing the CSV, matching cards locally, and sorting rows into review buckets.
                  </Text>
                </View>
              </SurfaceCard>
            ) : !job ? (
              <SurfaceCard padding={20} radius={28}>
                <View style={styles.retryCard}>
                  <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
                    Preview not loaded
                  </Text>
                  <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                    Pick a file again or retry the preview request.
                  </Text>
                  <Button
                    label="Retry preview"
                    onPress={() => {
                      void loadPreview();
                    }}
                    size="lg"
                    style={styles.primaryButton}
                    testID="portfolio-import-retry"
                  />
                </View>
              </SurfaceCard>
            ) : (
              <>
                <View style={styles.summarySection}>
                  <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>Review Summary</Text>
                  <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                    Start with the rows that still need a decision.
                  </Text>

                  <View style={styles.summaryGrid}>
                    <SummaryCard title="Rows" value={job.summary.totalRowCount} />
                    <SummaryCard title="Ready" value={job.summary.readyToCommitCount} />
                    <SummaryCard title="Review" value={job.summary.reviewCount + job.summary.unresolvedCount} />
                    <SummaryCard title="Unsupported" value={job.summary.unsupportedCount} />
                  </View>
                </View>

                {job.warnings.length > 0 ? (
                  <SurfaceCard padding={18} radius={24} variant="muted">
                    <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
                      Source warnings
                    </Text>
                    {job.warnings.map((warning) => (
                      <Text key={warning} style={[theme.typography.body, styles.warningCopy, { color: theme.colors.textSecondary }]}>
                        {warning}
                      </Text>
                    ))}
                  </SurfaceCard>
                ) : null}

                <View style={styles.filterSection}>
                  <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>Rows</Text>
                  <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                    Focus on the buckets that matter first.
                  </Text>

                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={styles.filterRow}>
                      {filterOrder.map((filter) => (
                        <PillButton
                          key={filter}
                          label={`${filterTitle(filter)} ${filterRows(job.rows, filter).length}`}
                          onPress={() => setSelectedFilter(filter)}
                          selected={selectedFilter === filter}
                          testID={`portfolio-import-filter-${filter}`}
                        />
                      ))}
                    </View>
                  </ScrollView>
                </View>

                <View style={styles.rowsSection}>
                  {filteredRows.length === 0 ? (
                    <SurfaceCard padding={18} radius={24} variant="muted">
                      <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                        No rows in this bucket right now.
                      </Text>
                    </SurfaceCard>
                  ) : (
                    filteredRows.map((row) => (
                      <RowCard
                        key={row.id}
                        onResolve={() => setSelectedRow(row)}
                        row={row}
                      />
                    ))
                  )}
                </View>
              </>
            )}
          </ScrollView>

          {canCommit ? (
            <View
              style={[
                styles.commitBar,
                {
                  backgroundColor: 'rgba(252, 252, 250, 0.98)',
                  borderTopColor: theme.colors.outlineSubtle,
                  paddingBottom: Math.max(insets.bottom, 14),
                  paddingHorizontal: theme.layout.pageGutter,
                },
              ]}
            >
              <View style={styles.commitCopy}>
                <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
                  Ready to import
                </Text>
                <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                  {readyRowCount} row{readyRowCount === 1 ? '' : 's'} can be added now.
                </Text>
              </View>

              <Button
                disabled={isCommitting}
                label={isCommitting ? 'Importing…' : 'Import Ready Rows'}
                onPress={() => {
                  void commitRows();
                }}
                size="lg"
                style={styles.commitButton}
                testID="portfolio-import-commit"
              />
            </View>
          ) : null}
        </View>
      </SafeAreaView>

      <ResolveRowModal
        onClose={() => setSelectedRow(null)}
        onResolve={resolveRow}
        onSearch={(query, limit) => spotlightRepository.searchCatalogCards(query, limit)}
        onSkip={skipRow}
        row={selectedRow}
        visible={selectedRow !== null}
      />
    </>
  );
}

type SummaryCardProps = {
  title: string;
  value: number;
};

function SummaryCard({ title, value }: SummaryCardProps) {
  const theme = useSpotlightTheme();

  return (
    <SurfaceCard padding={16} radius={22} variant="muted" style={styles.summaryCard}>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>{title}</Text>
      <Text style={[theme.typography.display, styles.summaryValue, { color: theme.colors.textPrimary }]}>
        {Math.max(0, value)}
      </Text>
    </SurfaceCard>
  );
}

type RowCardProps = {
  row: PortfolioImportRowRecord;
  onResolve: () => void;
};

function RowCard({ row, onResolve }: RowCardProps) {
  const theme = useSpotlightTheme();
  const priceText = priceLine(row);
  const matchedCard = row.matchedCard;

  const badgeBackgroundColor = (() => {
    switch (row.matchState) {
      case 'matched':
      case 'ready':
      case 'committed':
        return theme.colors.brand;
      case 'review':
      case 'unresolved':
      case 'failed':
        return '#F59D3D';
      case 'unsupported':
      case 'skipped':
      case 'unknown':
      default:
        return theme.colors.field;
    }
  })();

  const badgeForeground = row.matchState === 'unsupported' || row.matchState === 'skipped' || row.matchState === 'unknown'
    ? theme.colors.textPrimary
    : theme.colors.textInverse;

  return (
    <SurfaceCard padding={18} radius={26}>
      <View style={styles.rowCard}>
        <View style={styles.rowHeader}>
          <View style={styles.rowHeaderCopy}>
            <Text numberOfLines={2} style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
              {row.sourceCardName.trim() || `Row ${Math.max(1, row.rowIndex)}`}
            </Text>
            {detailLine(row) ? (
              <Text numberOfLines={2} style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                {detailLine(row)}
              </Text>
            ) : null}
          </View>

          <View style={[styles.statusBadge, { backgroundColor: badgeBackgroundColor }]}>
            <Text style={[theme.typography.caption, styles.statusBadgeText, { color: badgeForeground }]}>
              {rowStateTitle(row)}
            </Text>
          </View>
        </View>

        <View style={styles.rowPillWrap}>
          <View style={[styles.inlinePill, { backgroundColor: theme.colors.field }]}>
            <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
              Qty {Math.max(1, row.quantity)}
            </Text>
          </View>
          {row.sourceCollectionName ? (
            <View style={[styles.inlinePill, { backgroundColor: theme.colors.field }]}>
              <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                {row.sourceCollectionName}
              </Text>
            </View>
          ) : null}
          {priceText ? (
            <View style={[styles.inlinePill, { backgroundColor: theme.colors.field }]}>
              <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>{priceText}</Text>
            </View>
          ) : null}
        </View>

        {matchedCard ? (
          <View style={[styles.matchedCard, { backgroundColor: theme.colors.field, borderColor: theme.colors.outlineSubtle }]}>
            {matchedCard.imageUrl ? (
              <Image source={{ uri: matchedCard.imageUrl }} style={styles.matchedCardArt} />
            ) : (
              <View style={[styles.matchedCardFallback, { backgroundColor: theme.colors.canvasElevated }]}>
                <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>Card</Text>
              </View>
            )}

            <View style={styles.matchedCardCopy}>
              <Text numberOfLines={2} style={[theme.typography.bodyStrong, { color: theme.colors.textPrimary }]}>
                {matchedCard.name}
              </Text>
              <Text numberOfLines={2} style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {[matchedCard.setName, matchedCard.cardNumber].filter(Boolean).join(' • ')}
              </Text>
            </View>
          </View>
        ) : null}

        {row.warnings[0] ? (
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {row.warnings[0]}
          </Text>
        ) : null}

        {canResolveRow(row) ? (
          <Button
            label={isReadyToCommit(row) ? 'Change Match' : 'Resolve Row'}
            onPress={onResolve}
            size="lg"
            style={styles.secondaryButton}
            variant="secondary"
          />
        ) : null}
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  candidateArt: {
    borderRadius: 12,
    height: 74,
    resizeMode: 'contain',
    width: 54,
  },
  candidateArtFallback: {
    alignItems: 'center',
    borderRadius: 12,
    height: 74,
    justifyContent: 'center',
    width: 54,
  },
  candidateButton: {
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  candidateCopy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  candidateUseLabel: {
    alignSelf: 'center',
  },
  centeredCopy: {
    textAlign: 'center',
  },
  commitBar: {
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 14,
    paddingTop: 12,
  },
  commitButton: {
    alignItems: 'center',
    borderRadius: 18,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
  },
  commitCopy: {
    flex: 1,
    gap: 2,
    justifyContent: 'center',
  },
  content: {
    gap: 18,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 2,
  },
  filterSection: {
    gap: 10,
  },
  header: {
    minHeight: 52,
  },
  headerButton: {
    minWidth: 98,
  },
  heroCard: {
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
  },
  heroCopy: {
    flex: 1,
    gap: 6,
  },
  inlinePill: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  loadingCard: {
    alignItems: 'center',
    gap: 8,
  },
  matchedCard: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  matchedCardArt: {
    borderRadius: 12,
    height: 76,
    resizeMode: 'contain',
    width: 56,
  },
  matchedCardCopy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  matchedCardFallback: {
    alignItems: 'center',
    borderRadius: 12,
    height: 76,
    justifyContent: 'center',
    width: 56,
  },
  messageCopy: {
    marginTop: 6,
  },
  primaryButton: {
    alignSelf: 'flex-start',
  },
  resolveCandidates: {
    gap: 10,
  },
  resolveContent: {
    gap: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  resolveHeader: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  resolveHeaderSpacer: {
    width: 84,
  },
  resolveLoadingWrap: {
    alignItems: 'center',
    paddingVertical: 22,
  },
  resolveSearchField: {
    marginTop: 4,
    minHeight: 56,
  },
  resolveRowCard: {
    gap: 10,
  },
  resolveScreen: {
    flex: 1,
  },
  resolveSection: {
    gap: 10,
  },
  retryCard: {
    gap: 12,
  },
  rowCard: {
    gap: 14,
  },
  rowHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  rowHeaderCopy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  rowPillWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  rowsSection: {
    gap: 12,
  },
  safeArea: {
    flex: 1,
  },
  screen: {
    flex: 1,
  },
  secondaryButton: {
    alignSelf: 'flex-start',
  },
  skipButton: {
    alignSelf: 'flex-start',
  },
  statusBadge: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  statusBadgeText: {
    fontWeight: '700',
  },
  summaryCard: {
    flex: 1,
    minWidth: '48%',
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  summarySection: {
    gap: 10,
  },
  summaryValue: {
    fontSize: 28,
    lineHeight: 32,
    marginTop: 4,
  },
  warningCopy: {
    marginTop: 6,
  },
});
