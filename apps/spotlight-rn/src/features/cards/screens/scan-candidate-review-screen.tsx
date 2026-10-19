import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { SectionHeader, Text, colors, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  formatCurrency,
} from '@/features/portfolio/components/portfolio-formatting';
import type {
  ScanImageDimensions,
  ScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';

function resultNumberLabel(result: CatalogSearchResult) {
  const number = result.cardNumber?.trim() ?? '';
  if (!number) {
    return '';
  }
  return number.startsWith('#') ? number : `#${number}`;
}

export function resolveActiveScanReviewCandidate(
  session: ScanCandidateReviewSession | null,
  cardId?: string | null,
) {
  if (!session) {
    return null;
  }

  return session.candidates.find((candidate) => candidate.cardId === cardId)
    ?? session.candidates.find((candidate) => candidate.cardId === session.selectedCardId)
    ?? session.candidates[0]
    ?? null;
}

export function resolveSimilarScanCandidates(
  session: ScanCandidateReviewSession | null,
  activeCardId?: string | null,
) {
  if (!session) {
    return [];
  }

  const seenCardIds = new Set<string>();

  return session.candidates
    .filter((candidate) => candidate.cardId !== activeCardId)
    .filter((candidate) => {
      if (seenCardIds.has(candidate.cardId)) {
        return false;
      }

      seenCardIds.add(candidate.cardId);
      return true;
    })
    .slice(0, 9);
}

export function ScanCandidateReviewScreen({
  closestMatch,
  candidates,
  normalizedImageDimensions,
  normalizedImageUri,
  totalCount,
  onBack,
  onOpenCandidate,
}: {
  closestMatch: CatalogSearchResult | null;
  candidates: CatalogSearchResult[];
  normalizedImageDimensions?: ScanImageDimensions | null;
  normalizedImageUri?: string | null;
  totalCount: number;
  onBack: () => void;
  onOpenCandidate: (candidate: CatalogSearchResult) => void;
}) {
  const theme = useSpotlightTheme();
  const { width: windowWidth } = useWindowDimensions();
  const title = totalCount === 1 ? '1 card found' : `${totalCount} cards found`;
  const similarTitle = candidates.length === 1 ? '1 similar card' : `${candidates.length} similar cards`;
  const reviewImageNaturalWidth = normalizedImageDimensions?.width && normalizedImageDimensions.width > 0
    ? normalizedImageDimensions.width
    : 630;
  const reviewImageNaturalHeight = normalizedImageDimensions?.height && normalizedImageDimensions.height > 0
    ? normalizedImageDimensions.height
    : 880;
  const reviewImageAspectRatio = reviewImageNaturalWidth / reviewImageNaturalHeight;
  const sourceImageWidth = Math.min(Math.max(windowWidth - 180, 200), 248);
  const sourceImageHeight = sourceImageWidth / reviewImageAspectRatio;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.scanReviewSafeArea, { backgroundColor: colors.gray0 }]}
      testID="detail-scan-candidate-review"
    >
      <View style={[styles.scanReviewHeader, { paddingHorizontal: theme.layout.pageGutter }]}>
        <ChromeBackButton onPress={onBack} testID="detail-scan-candidate-back" />
        <Text style={[theme.typography.headline, styles.scanReviewTitle]}>{title}</Text>
        <View style={styles.scanReviewHeaderSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scanReviewContent,
          {
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {normalizedImageUri ? (
          <View style={styles.scanReviewSourceImageWrap}>
            <View
              style={[
                styles.scanReviewSourceImageFrame,
                {
                  height: sourceImageHeight,
                  width: sourceImageWidth,
                },
              ]}
              testID="detail-scan-source-image-frame"
            >
              <Image
                resizeMode="contain"
                source={{ uri: normalizedImageUri }}
                style={styles.scanReviewSourceImage}
                testID="detail-scan-source-image"
              />
            </View>
          </View>
        ) : null}
        {closestMatch ? (
          <View style={styles.scanReviewSection}>
            <SectionHeader title="Closest Match" />
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenCandidate(closestMatch)}
              style={({ pressed }) => [
                styles.scanCandidateRow,
                pressed ? styles.scanCandidateRowPressed : null,
              ]}
              testID="detail-scan-candidate-closest"
            >
              <CachedImage
                cachePolicy={imageCachePolicy.thumbnail}
                style={styles.scanCandidateArt}
                uri={closestMatch.smallImageUrl ?? closestMatch.imageUrl}
              />

              <View style={styles.scanCandidateCopy}>
                <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                  {closestMatch.setName.toUpperCase()}
                </Text>
                <Text numberOfLines={2} style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
                  {closestMatch.name}
                  {' '}
                  {resultNumberLabel(closestMatch)}
                </Text>
                <Text style={[theme.typography.body, { color: theme.colors.gray900 }]}>
                  EST VALUE
                  {' '}
                  {closestMatch.marketPrice != null
                    ? formatCurrency(closestMatch.marketPrice, closestMatch.currencyCode ?? 'USD')
                    : '—'}
                </Text>
              </View>

              <Text style={[theme.typography.titleLarge, styles.scanCandidateChevron, { color: theme.colors.gray600 }]}>›</Text>
            </Pressable>
          </View>
        ) : null}

        {candidates.length > 0 ? (
          <View style={styles.scanReviewSection}>
            <SectionHeader title={similarTitle} />
            <View style={styles.scanReviewList}>
              {candidates.map((candidate, index) => (
                <Pressable
                  accessibilityRole="button"
                  key={`${candidate.cardId}:${candidate.id}:${index}`}
                  onPress={() => onOpenCandidate(candidate)}
                  style={({ pressed }) => [
                    styles.scanCandidateRow,
                    pressed ? styles.scanCandidateRowPressed : null,
                  ]}
                  testID={`detail-scan-candidate-${index}`}
                >
                  <CachedImage
                    cachePolicy={imageCachePolicy.thumbnail}
                    style={styles.scanCandidateArt}
                    uri={candidate.smallImageUrl ?? candidate.imageUrl}
                  />

                  <View style={styles.scanCandidateCopy}>
                    <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                      {candidate.setName.toUpperCase()}
                    </Text>
                    <Text numberOfLines={2} style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
                      {candidate.name}
                      {' '}
                      {resultNumberLabel(candidate)}
                    </Text>
                    <Text style={[theme.typography.body, { color: theme.colors.gray900 }]}>
                      EST VALUE
                      {' '}
                      {candidate.marketPrice != null
                        ? formatCurrency(candidate.marketPrice, candidate.currencyCode ?? 'USD')
                        : '—'}
                    </Text>
                  </View>

                  <Text style={[theme.typography.titleLarge, styles.scanCandidateChevron, { color: theme.colors.gray600 }]}>›</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scanReviewSafeArea: {
    flex: 1,
  },
  scanReviewHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingTop: 6,
  },
  scanReviewTitle: {
    flex: 1,
    textAlign: 'center',
  },
  scanReviewHeaderSpacer: {
    width: 34,
  },
  scanReviewContent: {
    paddingBottom: 40,
  },
  scanReviewSourceImageWrap: {
    alignItems: 'center',
    marginBottom: 24,
  },
  scanReviewSourceImageFrame: {
    borderCurve: 'continuous',
    borderRadius: 34,
    overflow: 'hidden',
  },
  scanReviewSourceImage: {
    height: '100%',
    width: '100%',
  },
  scanReviewSection: {
    gap: 12,
    marginBottom: 16,
  },
  scanReviewList: {
    gap: 0,
  },
  scanCandidateRow: {
    alignItems: 'center',
    borderBottomColor: 'rgba(15, 15, 18, 0.08)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 16,
    minHeight: 104,
    paddingVertical: 16,
  },
  scanCandidateRowPressed: {
    opacity: 0.8,
  },
  scanCandidateArt: {
    borderCurve: 'continuous',
    borderRadius: 14,
    height: 84,
    width: 84,
  },
  scanCandidateCopy: {
    flex: 1,
    gap: 6,
  },
  // Text glyph "›" sized by the title role; no design-system chevron is used
  // on this screen yet.
  scanCandidateChevron: {
    marginLeft: 8,
  },
});
