import { Pressable, StyleSheet, View } from 'react-native';

import type { WhosThatPokemonMatch } from '@spotlight/api-client';
import {
  AppText,
  Button,
  matchConfidence,
  radii,
  spacing,
  SurfaceCard,
  useSpotlightTheme,
  type MatchConfidenceLevel,
} from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';

import { officialArtworkUrl } from '../artwork';
import { MorphLoop } from './morph-loop';

type ResultPanelProps = {
  /** Top-3 matches, best first. */
  matches: WhosThatPokemonMatch[];
  /** Index of the match shown as the hero (alternates can be promoted). */
  activeIndex: number;
  /** Local uri of the captured photo — the "before" in the morph + comparison. */
  selfieUri: string | null;
  /** Top selfie palette swatch — tints the morph dissolve wash. */
  washColor: string;
  /** Tap on an alternate row → re-runs the reveal morph to that artwork. */
  onSelectMatch: (index: number) => void;
  onShare: () => void;
  onTryAgain: () => void;
  isSharing: boolean;
  testID?: string;
};

// Same thresholds as the scanner change-card picker (<34 red, 34–66 yellow,
// ≥67 green) so confidence colors read consistently across the app.
function confidenceLevel(confidence: number): MatchConfidenceLevel {
  const pct = Math.round(confidence * 100);
  if (pct < 34) {
    return 'red';
  }
  if (pct < 67) {
    return 'yellow';
  }
  return 'green';
}

function ConfidencePill({ confidence, testID }: { confidence: number; testID?: string }) {
  const theme = useSpotlightTheme();
  const level = matchConfidence[confidenceLevel(confidence)];
  return (
    <View
      style={[
        styles.confidencePill,
        { backgroundColor: level.chipBg, borderRadius: theme.radii.pill },
      ]}
      testID={testID}
    >
      <AppText style={[theme.typography.captionMedium, { color: level.chipText }]}>
        {`${Math.round(confidence * 100)}% match`}
      </AppText>
    </View>
  );
}

/**
 * Result phase: hero card for the active match (artwork + playful reason +
 * confidence pill), the other two matches as tappable rows, and the
 * Share / Try again actions.
 */
export function ResultPanel({
  matches,
  activeIndex,
  selfieUri,
  washColor,
  onSelectMatch,
  onShare,
  onTryAgain,
  isSharing,
  testID = 'wtp-result',
}: ResultPanelProps) {
  const theme = useSpotlightTheme();
  const hero = matches[activeIndex] ?? matches[0];
  if (!hero) {
    return null;
  }
  const heroArtworkUrl = officialArtworkUrl(hero.pokedexId);

  return (
    <View style={styles.root} testID={testID}>
      <SurfaceCard padding={spacing.md} radius={radii.xl} testID={`${testID}-hero`}>
        <View style={styles.heroContent}>
          {/* The transformation replays on a loop so you can watch how you
              morphed into the Pokémon. */}
          <MorphLoop
            artworkUrl={heroArtworkUrl}
            selfieUri={selfieUri}
            testID={`${testID}-morph`}
            washColor={washColor}
          />

          {/* Side-by-side before → after, always visible for comparison. */}
          <View style={styles.compareRow} testID={`${testID}-compare`}>
            <View style={styles.compareCell}>
              {selfieUri ? (
                <CachedImage
                  cachePolicy="memory-disk"
                  contentFit="cover"
                  style={styles.compareThumb}
                  uri={selfieUri}
                />
              ) : (
                <View style={[styles.compareThumb, { backgroundColor: theme.colors.surfaceMuted }]} />
              )}
              <AppText style={[theme.typography.captionMedium, { color: theme.colors.textSecondary }]}>
                You
              </AppText>
            </View>
            <AppText style={[theme.typography.titleSmall, { color: theme.colors.textSecondary }]}>
              →
            </AppText>
            <View style={styles.compareCell}>
              <CachedImage
                cachePolicy="disk"
                contentFit="contain"
                style={styles.compareThumb}
                uri={heroArtworkUrl}
              />
              <AppText
                numberOfLines={1}
                style={[theme.typography.captionMedium, { color: theme.colors.textSecondary }]}
              >
                {hero.species}
              </AppText>
            </View>
          </View>

          <AppText style={theme.typography.captionMedium}>You are basically…</AppText>
          <AppText style={theme.typography.titleLarge} testID={`${testID}-hero-name`}>
            {hero.species}
          </AppText>
          <ConfidencePill confidence={hero.confidence} testID={`${testID}-hero-confidence`} />
          {hero.reason ? (
            <AppText
              style={[theme.typography.body, styles.heroReason, { color: theme.colors.textSecondary }]}
              testID={`${testID}-hero-reason`}
            >
              {`“${hero.reason}”`}
            </AppText>
          ) : null}
        </View>
      </SurfaceCard>

      <View style={styles.alternateList}>
        {matches.map((match, index) => {
          if (index === activeIndex) {
            return null;
          }
          return (
            <Pressable
              accessibilityLabel={`See your ${match.species} match`}
              accessibilityRole="button"
              key={`${match.pokedexId}-${index}`}
              onPress={() => onSelectMatch(index)}
              testID={`${testID}-alternate-${index}`}
            >
              {({ pressed }) => (
                <SurfaceCard
                  padding={spacing.xs}
                  radius={radii.lg}
                  style={pressed ? styles.alternatePressed : null}
                  variant="muted"
                >
                  <View style={styles.alternateRow}>
                    <CachedImage
                      cachePolicy="disk"
                      contentFit="contain"
                      style={styles.alternateArtwork}
                      uri={officialArtworkUrl(match.pokedexId)}
                    />
                    <View style={styles.alternateCopy}>
                      <AppText style={theme.typography.titleSmall}>{match.species}</AppText>
                      {match.reason ? (
                        <AppText
                          numberOfLines={2}
                          style={[theme.typography.captionMedium, { color: theme.colors.textSecondary }]}
                        >
                          {match.reason}
                        </AppText>
                      ) : null}
                    </View>
                    <ConfidencePill confidence={match.confidence} />
                  </View>
                </SurfaceCard>
              )}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.actions}>
        <Button
          disabled={isSharing}
          label={isSharing ? 'Preparing…' : 'Share'}
          onPress={onShare}
          size="lg"
          testID={`${testID}-share`}
          variant="accent"
        />
        <Button
          label="Try again"
          onPress={onTryAgain}
          size="lg"
          testID={`${testID}-try-again`}
          variant="secondary"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.sm,
  },
  heroContent: {
    alignItems: 'center',
    gap: spacing.xxs,
  },
  compareRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  compareCell: {
    alignItems: 'center',
    gap: 2,
    width: 76,
  },
  compareThumb: {
    borderRadius: radii.md,
    height: 64,
    width: 64,
  },
  heroReason: {
    textAlign: 'center',
  },
  alternateList: {
    gap: spacing.xxs,
  },
  alternatePressed: {
    opacity: 0.7,
  },
  alternateRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  alternateArtwork: {
    height: 56,
    width: 56,
  },
  alternateCopy: {
    flex: 1,
    gap: 2,
  },
  confidencePill: {
    paddingHorizontal: spacing.xxs,
    paddingVertical: 3,
  },
  actions: {
    gap: spacing.xxs,
    marginTop: spacing.xxs,
  },
});
