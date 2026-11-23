import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { NavArrowLeft } from 'iconoir-react-native';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type {
  CardGame,
  MarketWindow,
  MarketHeatmapSetCard,
  MarketHeatmapSet,
  MarketHeatmapTile,
} from '@spotlight/api-client';
import { PillButton, radii, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { formatAbbreviatedCurrency, formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { formatSignedPercent } from '@/features/meta-feed/screens/components/meta-format';
import { heatmapColor, prefersLightText, type HeatmapPalette } from '@/features/market/lib/heatmap-color';
import { squarify, type TreemapRect, type TreemapTile } from '@/features/market/lib/squarify';
import { useAppServices } from '@/providers/app-providers';

// Treemap height as a fraction of its width: a near-square map gives ~40 sets
// enough room for the top dozen to carry labels.
const HEATMAP_ASPECT = 0.92;
// Space between tiles (each tile is inset by half of it).
const TILE_GAP = 2;
// Labels need this much room; smaller tiles keep only an accessible label.
const LABEL_MIN_WIDTH = 72;
const LABEL_MIN_HEIGHT = 38;
const PERCENT_ONLY_MIN_WIDTH = 62;
const PERCENT_ONLY_MIN_HEIGHT = 22;
const PRICE_MIN_HEIGHT = 58;
const ZOOM_MS = 380;

type Zoom = {
  setId: string;
  name: string;
  color: string;
  rect: TreemapRect;
};

type HeatmapTileView = {
  key: string;
  label: string;
  changePct: number | null;
  /** Shown under the % on tall tiles (a card's price). */
  detail?: string;
  accessibilityLabel: string;
  onPress: () => void;
};

function changeWords(changePct: number | null) {
  if (changePct == null) {
    return 'no change data';
  }
  if (Math.abs(changePct) < 0.05) {
    return 'flat';
  }
  return `${changePct > 0 ? 'up' : 'down'} ${Math.abs(changePct).toFixed(1)} percent`;
}

const TreemapTiles = memo(function TreemapTiles({
  tiles,
  palette,
  testID,
}: {
  tiles: TreemapTile<HeatmapTileView>[];
  palette: HeatmapPalette;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <>
      {tiles.map((tile) => {
        const fill = heatmapColor(tile.data.changePct ?? 0, palette);
        const ink = prefersLightText(fill) ? theme.colors.gray0 : theme.colors.gray900;
        const width = tile.width - TILE_GAP;
        const height = tile.height - TILE_GAP;
        const showName = width >= LABEL_MIN_WIDTH && height >= LABEL_MIN_HEIGHT;
        const showPercent = width >= PERCENT_ONLY_MIN_WIDTH && height >= PERCENT_ONLY_MIN_HEIGHT;
        return (
          <Pressable
            accessibilityLabel={tile.data.accessibilityLabel}
            accessibilityRole="button"
            key={tile.data.key}
            onPress={tile.data.onPress}
            style={({ pressed }) => [
              styles.tile,
              {
                backgroundColor: fill,
                height: Math.max(0, height),
                left: tile.x + TILE_GAP / 2,
                opacity: pressed ? 0.8 : 1,
                top: tile.y + TILE_GAP / 2,
                width: Math.max(0, width),
              },
            ]}
            testID={`${testID}-tile-${tile.data.key}`}
          >
            {showName ? (
              <Text
                numberOfLines={height >= 56 ? 2 : 1}
                style={[theme.typography.captionStrong, { color: ink }]}
                testID={`${testID}-tile-${tile.data.key}-name`}
              >
                {tile.data.label}
              </Text>
            ) : null}
            {showPercent ? (
              <Text numberOfLines={1} style={[theme.typography.overline, { color: ink }]}>
                {tile.data.changePct == null ? '—' : formatSignedPercent(tile.data.changePct)}
              </Text>
            ) : null}
            {showName && tile.data.detail && height >= PRICE_MIN_HEIGHT ? (
              <Text numberOfLines={1} style={[theme.typography.overline, { color: ink }]}>
                {tile.data.detail}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </>
  );
});

type MarketHeatmapProps = {
  game: CardGame;
  window: MarketWindow;
  sets: readonly MarketHeatmapTile[];
  onPressCard: (card: MarketHeatmapSetCard) => void;
  /** Lets the page tell the assistant which set is zoomed. */
  onZoomChange?: (setId: string | null, name: string | null) => void;
  /** Dev screen host only: open this set once the map has laid out. */
  devInitialZoomSetId?: string;
  testID?: string;
};

/**
 * Squarified treemap of a game's sets (area = total value, color = change).
 * Tapping a set grows it in place into that set's own card treemap; "All sets"
 * shrinks it back. Plain Views (≈40 absolutely placed tiles) rather than SVG:
 * each tile needs a press target and text, which Views give natively.
 */
export function MarketHeatmap({
  game,
  window,
  sets,
  onPressCard,
  onZoomChange,
  devInitialZoomSetId,
  testID = 'market-heatmap',
}: MarketHeatmapProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();
  const [width, setWidth] = useState(0);
  const height = Math.round(width * HEATMAP_ASPECT);
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [zoomSet, setZoomSet] = useState<{ setId: string; data: MarketHeatmapSet | null; failed: boolean } | null>(null);
  const progress = useSharedValue(0);
  const zoomTokenRef = useRef(0);

  const palette = useMemo<HeatmapPalette>(() => ({
    up: theme.colors.green500,
    down: theme.colors.red500,
    neutral: theme.colors.gray200,
  }), [theme.colors]);

  // A new game or window starts from the overview (reset during render, so
  // the stale zoom never paints).
  const scopeKey = `${game}|${window}`;
  const [scope, setScope] = useState(scopeKey);
  if (scope !== scopeKey) {
    zoomTokenRef.current += 1;
    setScope(scopeKey);
    setZoom(null);
    setZoomSet(null);
  }
  useEffect(() => {
    progress.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shared value identity is stable on device
  }, [scopeKey]);

  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  useEffect(() => {
    onZoomChangeRef.current?.(zoom?.setId ?? null, zoom?.name ?? null);
  }, [zoom]);

  const openSet = useCallback((set: MarketHeatmapTile, rect: TreemapRect) => {
    const token = ++zoomTokenRef.current;
    setZoom({ setId: set.setId, name: set.name, color: heatmapColor(set.changePct ?? 0, palette), rect });
    setZoomSet(null);
    progress.value = 0;
    progress.value = withTiming(1, { duration: ZOOM_MS, easing: Easing.out(Easing.cubic) });
    spotlightRepository.getMarketHeatmapSet({ game, setId: set.setId, window })
      .then((data) => {
        if (token === zoomTokenRef.current) {
          setZoomSet({ setId: set.setId, data, failed: false });
        }
      })
      .catch(() => {
        if (token === zoomTokenRef.current) {
          setZoomSet({ setId: set.setId, data: null, failed: true });
        }
      });
  }, [game, palette, progress, spotlightRepository, window]);

  const closeSet = useCallback(() => {
    zoomTokenRef.current += 1;
    const finish = () => {
      setZoom(null);
      setZoomSet(null);
    };
    progress.value = withTiming(0, { duration: ZOOM_MS, easing: Easing.inOut(Easing.cubic) }, (done) => {
      if (done) {
        runOnJS(finish)();
      }
    });
  }, [progress]);

  const setTiles = useMemo(() => {
    if (width <= 0) {
      return [];
    }
    const full = { x: 0, y: 0, width, height };
    const laid = squarify(sets.map((set) => ({ value: set.totalValueUsd, data: set })), full);
    return laid.map((tile): TreemapTile<HeatmapTileView> => ({
      ...tile,
      data: {
        key: tile.data.setId,
        label: tile.data.name,
        changePct: tile.data.changePct,
        accessibilityLabel: `${tile.data.name}, ${changeWords(tile.data.changePct)}, ${formatAbbreviatedCurrency(tile.data.totalValueUsd)} total value. Shows its cards.`,
        onPress: () => openSet(tile.data, { x: tile.x, y: tile.y, width: tile.width, height: tile.height }),
      },
    }));
  }, [height, openSet, sets, width]);

  const devZoomedRef = useRef(false);
  useEffect(() => {
    if (!devInitialZoomSetId || devZoomedRef.current) {
      return;
    }
    const target = setTiles.find((tile) => tile.data.key === devInitialZoomSetId);
    if (target) {
      devZoomedRef.current = true;
      target.data.onPress();
    }
  }, [devInitialZoomSetId, setTiles]);

  const cards = zoomSet?.setId === zoom?.setId ? zoomSet?.data?.cards ?? null : null;
  const cardTiles = useMemo(() => {
    if (!cards || width <= 0) {
      return [];
    }
    const laid = squarify(cards.map((card) => ({ value: card.priceUsd, data: card })), { x: 0, y: 0, width, height });
    return laid.map((tile): TreemapTile<HeatmapTileView> => ({
      ...tile,
      data: {
        key: tile.data.cardId,
        label: tile.data.name,
        changePct: tile.data.changePct,
        detail: formatCurrency(tile.data.priceUsd),
        accessibilityLabel: `${tile.data.name} ${tile.data.number}, ${formatCurrency(tile.data.priceUsd)}, ${changeWords(tile.data.changePct)}. Opens the card.`,
        onPress: () => onPressCard(tile.data),
      },
    }));
  }, [cards, height, onPressCard, width]);

  const overviewStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.7], [1, 0], 'clamp'),
  }));

  const rect = zoom?.rect;
  const zoomLayerStyle = useAnimatedStyle(() => {
    if (!rect || width <= 0 || height <= 0) {
      return { opacity: 0 };
    }
    const p = progress.value;
    const scaleX = interpolate(p, [0, 1], [rect.width / width, 1]);
    const scaleY = interpolate(p, [0, 1], [rect.height / height, 1]);
    const translateX = interpolate(p, [0, 1], [rect.x + rect.width / 2 - width / 2, 0]);
    const translateY = interpolate(p, [0, 1], [rect.y + rect.height / 2 - height / 2, 0]);
    return {
      opacity: 1,
      transform: [{ translateX }, { translateY }, { scaleX }, { scaleY }],
    };
  });
  // The set's own color washes out as its cards fade in.
  const washStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.3, 1], [1, 0], 'clamp'),
  }));
  const cardsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.5, 1], [0, 1], 'clamp'),
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next !== width) {
      setWidth(next);
    }
  };

  const zoomEmpty = zoom && zoomSet?.setId === zoom.setId && (zoomSet.failed || !zoomSet.data || zoomSet.data.cards.length === 0);

  return (
    <View style={styles.root} testID={testID}>
      {zoom ? (
        <View style={styles.toolbar}>
          <PillButton
            label="All sets"
            labelRole="caption"
            leading={<NavArrowLeft color={theme.colors.gray900} height={14} strokeWidth={2} width={14} />}
            onPress={closeSet}
            testID={`${testID}-back`}
            tone="filled"
            uppercase
          />
          <Text
            numberOfLines={1}
            style={[theme.typography.titleXsmall, styles.toolbarTitle, { color: theme.colors.gray900 }]}
            testID={`${testID}-zoom-title`}
          >
            {zoom.name}
          </Text>
        </View>
      ) : null}
      <View onLayout={onLayout} style={[styles.canvas, { height: height || undefined }]} testID={`${testID}-canvas`}>
        <Animated.View
          pointerEvents={zoom ? 'none' : 'auto'}
          style={[StyleSheet.absoluteFill, overviewStyle]}
          testID={`${testID}-overview`}
        >
          <TreemapTiles palette={palette} testID={testID} tiles={setTiles} />
        </Animated.View>
        {zoom ? (
          <Animated.View
            style={[StyleSheet.absoluteFill, zoomLayerStyle]}
            testID={`${testID}-zoom`}
          >
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, styles.wash, { backgroundColor: zoom.color }, washStyle]}
            />
            <Animated.View style={[StyleSheet.absoluteFill, cardsStyle]}>
              {cardTiles.length > 0 ? (
                <TreemapTiles palette={palette} testID={`${testID}-card`} tiles={cardTiles} />
              ) : zoomEmpty ? (
                <View style={styles.zoomMessage}>
                  <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID={`${testID}-zoom-empty`}>
                    {zoomSet?.failed ? "Couldn't load this set's cards." : 'No card prices for this set yet.'}
                  </Text>
                </View>
              ) : (
                <View style={styles.zoomMessage}>
                  <ActivityIndicator color={theme.colors.gray500} testID={`${testID}-zoom-loading`} />
                </View>
              )}
            </Animated.View>
          </Animated.View>
        ) : null}
      </View>
      {/* Diverging scale key, so the colors read without a tap. */}
      <View style={styles.scale} testID={`${testID}-scale`}>
        <Text style={[theme.typography.overline, styles.hint, { color: theme.colors.gray600 }]} testID={`${testID}-legend`}>
          {zoom ? 'Tap a card to open it' : 'Tap a set to see its cards'}
        </Text>
        <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]}>−15%</Text>
        <View style={styles.scaleBar}>
          {[-15, -9, -4, 0, 4, 9, 15].map((stop) => (
            <View key={stop} style={[styles.scaleStop, { backgroundColor: heatmapColor(stop, palette) }]} />
          ))}
        </View>
        <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]}>+15%</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    overflow: 'hidden',
    width: '100%',
  },
  root: {
    gap: spacing.xxs,
  },
  hint: {
    flex: 1,
  },
  scale: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  scaleBar: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    flexDirection: 'row',
    height: 8,
    overflow: 'hidden',
    width: 112,
  },
  scaleStop: {
    flex: 1,
  },
  tile: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    gap: 2,
    overflow: 'hidden',
    padding: 6,
    position: 'absolute',
  },
  toolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 32,
  },
  toolbarTitle: {
    flex: 1,
  },
  wash: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
  },
  zoomMessage: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});
