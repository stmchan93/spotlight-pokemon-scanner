import { useRouter } from 'expo-router';
// GOTCHA (this repo was burned by it — caused 100% scanner image loss): the
// file-system APIs must be imported from 'expo-file-system/legacy'. The new
// 'expo-file-system' entry's stubs typecheck clean but THROW at runtime.
import { cacheDirectory, deleteAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import { Image as ExpoImage } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type {
  NormalizedBox,
  NormalizedPoint,
  WhosThatPokemonMatch,
} from '@spotlight/api-client';
import {
  AppText,
  colors,
  radii,
  spacing,
  StateCard,
  textStyles,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { useVisionCameraCapture } from '@/features/scanner/use-vision-camera-capture';
import { useAppServices } from '@/providers/app-providers';

import { officialArtworkUrl } from '../artwork';
import { FaceLockOn } from '../components/face-lock-on';
import { RevealMorph } from '../components/reveal-morph';
import { ScanningTheater } from '../components/scanning-theater';
import { ResultPanel } from '../components/result-panel';
import { extractSelfiePalette, fallbackSelfiePalette } from '../palette';

const isTestEnv = process.env.NODE_ENV === 'test';

// The scanning theater plays for at least this long even when the API answers
// faster, so the reveal never feels instant/anticlimactic. Sized to the
// theater's own palette-sampling stagger (5 swatches at 420ms) — the lock-on
// phase now carries the "analysing you" beat, so the floor no longer has to.
// Shortened under jest so screen tests can walk the phases on real timers.
const MIN_THEATER_MS = isTestEnv ? 40 : 2400;

const SHARE_FILE_NAME = 'whos-that-pokemon.png';

type Phase = 'capture' | 'scanning' | 'lockon' | 'reveal' | 'result';

type SelfieCapture = {
  uri: string;
  jpegBase64: string;
  width: number;
  height: number;
};

// expo-sharing is a NATIVE module added after some shipped binaries were built,
// and OTA'd JS must not crash on them — lazy-require and fall back to RN Share
// (same pattern as portfolio/export-collection.ts).
type SharingModule = {
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (
    url: string,
    options?: { mimeType?: string; UTI?: string; dialogTitle?: string },
  ) => Promise<void>;
};
function loadSharingModule(): SharingModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-sharing') as SharingModule;
  } catch {
    return null;
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * "Who's That Pokémon?" — one screen, five phases in local state:
 * capture (front-camera selfie) → scanning (calm theater plays while the
 * backend matches) → lockon (your face is measured, then the landmark points
 * fly out and settle into the species outline) → reveal (the classic strobe
 * turns that silhouette into the artwork) → result (top-3 + playful reasons +
 * server-composed share card).
 *
 * The selfie is analyzed in the moment and never stored: it travels inline in
 * the request and the temp file is best-effort deleted on reset/unmount.
 */
export function WhosThatPokemonScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { spotlightRepository } = useAppServices();
  const {
    device,
    Camera,
    photoOutput,
    hasPermission,
    requestPermission,
    capture,
  } = useVisionCameraCapture({ position: 'front', quality: 0.8 });

  const [phase, setPhase] = useState<Phase>('capture');
  const [matchFailed, setMatchFailed] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(isTestEnv);
  const [isCapturing, setIsCapturing] = useState(false);
  const [selfie, setSelfie] = useState<SelfieCapture | null>(null);
  const [palette, setPalette] = useState<string[]>(fallbackSelfiePalette);
  const [matches, setMatches] = useState<WhosThatPokemonMatch[]>([]);
  // Background-removed selfie (data URI) from the backend — lets the morph
  // grab the user's actual outline; null → plain crossfade fallback.
  const [personCutoutUri, setPersonCutoutUri] = useState<string | null>(null);
  // Segmentation geometry for the lock-on. `headBox` is normalized to the
  // ORIGINAL SELFIE; `speciesOutline` to the ARTWORK IMAGE. Both are optional —
  // FaceLockOn falls back to a proportional head box and a scatter exit.
  const [headBox, setHeadBox] = useState<NormalizedBox | null>(null);
  const [speciesOutline, setSpeciesOutline] = useState<NormalizedPoint[] | null>(null);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  // True only when the reveal is taking over from the lock-on, which already
  // collapsed the scene onto the silhouette.
  const [revealFromSilhouette, setRevealFromSilhouette] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  // Track the live selfie temp file + an incrementing run id so a stale match
  // response (after retake/unmount) can't clobber newer state.
  const selfieUriRef = useRef<string | null>(null);
  const matchRunRef = useRef(0);
  const mountedRef = useRef(true);

  const deleteSelfieFile = useCallback(() => {
    const uri = selfieUriRef.current;
    selfieUriRef.current = null;
    if (uri) {
      // Best-effort: the OS clears the cache dir eventually anyway.
      void deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      matchRunRef.current += 1;
      deleteSelfieFile();
    };
  }, [deleteSelfieFile]);

  useEffect(() => {
    if (!hasPermission) {
      void requestPermission();
    }
  }, [hasPermission, requestPermission]);

  const runMatch = useCallback(async (nextSelfie: SelfieCapture) => {
    const runId = matchRunRef.current + 1;
    matchRunRef.current = runId;
    setMatchFailed(false);
    setPhase('scanning');

    const startedAt = Date.now();
    try {
      const paletteColors = await extractSelfiePalette(nextSelfie.uri);
      if (matchRunRef.current !== runId) {
        return;
      }
      setPalette(paletteColors);

      const result = await spotlightRepository.whosThatPokemon({
        jpegBase64: nextSelfie.jpegBase64,
        width: nextSelfie.width,
        height: nextSelfie.height,
        palette: paletteColors,
      });

      // Prefetch the top match's artwork while the theater is still running so
      // the reveal crossfade never pops in from a cold network load.
      const topMatch = result.matches[0];
      if (topMatch) {
        void ExpoImage.prefetch(officialArtworkUrl(topMatch.pokedexId)).catch(() => {});
      }

      // Enforce the minimum theater duration even on fast responses.
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_THEATER_MS) {
        await delay(MIN_THEATER_MS - elapsedMs);
      }
      if (matchRunRef.current !== runId || !mountedRef.current) {
        return;
      }

      setMatches(result.matches);
      setPersonCutoutUri(result.personCutoutUri ?? null);
      setHeadBox(result.headBox ?? null);
      setSpeciesOutline(result.speciesOutline ?? null);
      setActiveMatchIndex(0);
      setRevealFromSilhouette(false);
      setPhase('lockon');
    } catch {
      if (matchRunRef.current !== runId || !mountedRef.current) {
        return;
      }
      setMatchFailed(true);
    }
  }, [spotlightRepository]);

  const handleCapture = useCallback(async () => {
    if (isCapturing) {
      return;
    }
    setIsCapturing(true);
    try {
      const result = await capture({ includeBase64: true });
      if (!mountedRef.current) {
        return;
      }
      if (!result?.base64) {
        Alert.alert('Capture failed', 'Could not read the photo. Please try again.');
        return;
      }
      // A retake replaces the previous selfie — drop its temp file first.
      deleteSelfieFile();
      selfieUriRef.current = result.uri;
      const nextSelfie: SelfieCapture = {
        uri: result.uri,
        jpegBase64: result.base64,
        width: result.width,
        height: result.height,
      };
      setSelfie(nextSelfie);
      void runMatch(nextSelfie);
    } catch {
      if (mountedRef.current) {
        Alert.alert('Capture failed', 'Could not take the photo. Please try again.');
      }
    } finally {
      if (mountedRef.current) {
        setIsCapturing(false);
      }
    }
  }, [capture, deleteSelfieFile, isCapturing, runMatch]);

  const handleRetry = useCallback(() => {
    if (selfie) {
      void runMatch(selfie);
    } else {
      setMatchFailed(false);
      setPhase('capture');
    }
  }, [runMatch, selfie]);

  const handleTryAgain = useCallback(() => {
    matchRunRef.current += 1;
    deleteSelfieFile();
    setSelfie(null);
    setMatches([]);
    setPersonCutoutUri(null);
    setHeadBox(null);
    setSpeciesOutline(null);
    setActiveMatchIndex(0);
    setRevealFromSilhouette(false);
    setPalette(fallbackSelfiePalette);
    setMatchFailed(false);
    setIsCameraReady(isTestEnv);
    setPhase('capture');
  }, [deleteSelfieFile]);

  const handleSelectMatch = useCallback((index: number) => {
    setActiveMatchIndex(index);
    // Promoting an alternate replays the reveal only — the lock-on measures
    // YOUR face and has already happened; repeating it would be filler.
    setRevealFromSilhouette(false);
    setPhase('reveal');
  }, []);

  const handleShare = useCallback(async () => {
    const match = matches[activeMatchIndex];
    if (!match || !selfie || isSharing) {
      return;
    }
    setIsSharing(true);
    try {
      const { pngBase64 } = await spotlightRepository.whosThatShareCard({
        jpegBase64: selfie.jpegBase64,
        species: match.species,
        pokedexId: match.pokedexId,
        reason: match.reason,
        confidence: match.confidence,
      });

      const fileUri = `${cacheDirectory}${SHARE_FILE_NAME}`;
      await writeAsStringAsync(fileUri, pngBase64, { encoding: 'base64' });

      // Prefer expo-sharing (the only path that shares a real FILE on Android);
      // fall back to RN Share's iOS-friendly `url` when the module is missing.
      let sharedViaModule = false;
      const sharing = loadSharingModule();
      if (sharing) {
        try {
          if (await sharing.isAvailableAsync()) {
            await sharing.shareAsync(fileUri, {
              mimeType: 'image/png',
              UTI: 'public.png',
              dialogTitle: "Who's That Pokémon?",
            });
            sharedViaModule = true;
          }
        } catch {
          sharedViaModule = false;
        }
      }
      if (!sharedViaModule) {
        await Share.share({ url: fileUri });
      }
    } catch {
      if (mountedRef.current) {
        Alert.alert('Share failed', 'Could not build your share card. Please try again.');
      }
    } finally {
      if (mountedRef.current) {
        setIsSharing(false);
      }
    }
  }, [activeMatchIndex, isSharing, matches, selfie, spotlightRepository]);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/' as never);
    }
  }, [router]);

  const activeMatch = matches[activeMatchIndex] ?? null;
  const washColor = palette[0] ?? colors.brand;

  const renderCapturePhase = () => {
    if (!hasPermission) {
      return (
        <View style={styles.permissionWrap}>
          <StateCard
            actionLabel="Allow camera access"
            actionTestID="wtp-permission-request"
            centered
            message="The front camera powers your Pokémon match. If the prompt doesn't appear, enable camera access in Settings."
            onActionPress={() => {
              void requestPermission();
            }}
            testID="wtp-permission"
            title="Camera access needed"
          />
        </View>
      );
    }

    return (
      <View style={styles.cameraCanvas}>
        {device && photoOutput ? (
          <Camera
            device={device}
            isActive={phase === 'capture'}
            onStarted={() => setIsCameraReady(true)}
            orientationSource="interface"
            outputs={[photoOutput]}
            style={StyleSheet.absoluteFillObject}
            testID="wtp-camera"
          />
        ) : (
          <View style={[StyleSheet.absoluteFillObject, styles.cameraFallback]} />
        )}

        <View style={[styles.captureFooter, { paddingBottom: insets.bottom + spacing.lg }]}>
          <AppText style={styles.captureHint} testID="wtp-capture-hint">
            Step back for a full-body shot — your whole outfit &amp; vibe make the match.
          </AppText>
          <AppText style={styles.privacyCaption} testID="wtp-privacy-caption">
            Analyzed in the moment. Never stored.
          </AppText>
          <Pressable
            accessibilityLabel="Take selfie"
            accessibilityRole="button"
            disabled={isCapturing || !isCameraReady || !device || !photoOutput}
            onPress={() => {
              void handleCapture();
            }}
            style={({ pressed }) => [
              styles.shutterOuter,
              pressed || isCapturing ? styles.shutterPressed : null,
            ]}
            testID="wtp-shutter"
          >
            <View style={styles.shutterInner} />
          </Pressable>
        </View>
      </View>
    );
  };

  const renderScanningPhase = () => {
    if (matchFailed) {
      return (
        <View style={styles.permissionWrap}>
          <StateCard
            actionLabel="Try again"
            actionTestID="wtp-error-retry"
            centered
            message="The Pokédex glitched mid-lookup. Give it another go."
            onActionPress={handleRetry}
            testID="wtp-error"
            title="No match this time"
          />
        </View>
      );
    }
    return <ScanningTheater palette={palette} selfieUri={selfie?.uri ?? null} />;
  };

  return (
    <View style={styles.root} testID="whos-that-pokemon-screen">
      {phase === 'capture' ? renderCapturePhase() : null}
      {phase === 'scanning' ? renderScanningPhase() : null}
      {phase === 'lockon' && activeMatch ? (
        <FaceLockOn
          artworkUrl={officialArtworkUrl(activeMatch.pokedexId)}
          headBox={headBox}
          onDone={() => {
            setRevealFromSilhouette(true);
            setPhase('reveal');
          }}
          selfieUri={selfie?.uri ?? null}
          sourceHeight={selfie?.height ?? 0}
          sourceWidth={selfie?.width ?? 0}
          washColor={washColor}
        />
      ) : null}
      {phase === 'reveal' && activeMatch ? (
        <RevealMorph
          artworkUrl={officialArtworkUrl(activeMatch.pokedexId)}
          burstColors={palette}
          fromSilhouette={revealFromSilhouette}
          key={`reveal-${activeMatch.pokedexId}`}
          onDone={() => setPhase('result')}
          selfieUri={selfie?.uri ?? null}
          washColor={washColor}
        />
      ) : null}
      {phase === 'result' ? (
        <ScrollView
          contentContainerStyle={[
            styles.resultContent,
            { paddingBottom: insets.bottom + spacing.xxl, paddingTop: insets.top + 64 },
          ]}
          style={styles.resultScroll}
        >
          <ResultPanel
            activeIndex={activeMatchIndex}
            isSharing={isSharing}
            matches={matches}
            personCutoutUri={personCutoutUri}
            selfieUri={selfie?.uri ?? null}
            washColor={washColor}
            onSelectMatch={handleSelectMatch}
            onShare={() => {
              void handleShare();
            }}
            onTryAgain={handleTryAgain}
          />
        </ScrollView>
      ) : null}

      {/* Chrome overlays every phase so the user can always leave. */}
      <View pointerEvents="box-none" style={[styles.header, { top: insets.top + spacing.xxs }]}>
        <ChromeBackButton onPress={handleBack} testID="wtp-back" />
        <AppText style={styles.headerTitle} testID="wtp-title">
          Who&apos;s That Pokémon?
        </AppText>
        {/* Spacer balances the back button so the title stays centered. */}
        <View style={styles.headerSpacer} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.scannerCanvas,
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    left: spacing.sm,
    position: 'absolute',
    right: spacing.sm,
  },
  headerTitle: {
    ...textStyles.titleSmall,
    color: colors.scannerTextPrimary,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 34,
  },
  permissionWrap: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  cameraCanvas: {
    flex: 1,
  },
  cameraFallback: {
    backgroundColor: colors.scannerTray,
  },
  captureFooter: {
    alignItems: 'center',
    bottom: 0,
    gap: spacing.sm,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  captureHint: {
    ...textStyles.titleSmall,
    color: colors.scannerTextPrimary,
    marginHorizontal: spacing.xl,
    textAlign: 'center',
  },
  privacyCaption: {
    ...textStyles.captionMedium,
    color: colors.scannerTextSecondary,
  },
  shutterOuter: {
    alignItems: 'center',
    borderColor: colors.scannerTextPrimary,
    borderRadius: radii.pill,
    borderWidth: 4,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  shutterPressed: {
    opacity: 0.6,
  },
  shutterInner: {
    backgroundColor: colors.scannerTextPrimary,
    borderRadius: radii.pill,
    height: 58,
    width: 58,
  },
  resultScroll: {
    flex: 1,
  },
  resultContent: {
    paddingHorizontal: spacing.sm,
  },
});
