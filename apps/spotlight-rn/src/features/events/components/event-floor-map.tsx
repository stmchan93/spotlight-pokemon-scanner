import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import type { SpotlightEventMap, SpotlightEventMapTable, SpotlightEventMapVector } from '@spotlight/api-client';
import { Text, borderWidths, radii, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import {
  DOUBLE_TAP_ZOOM_FACTOR,
  MAP_MAX_SCALE,
  clampTransform,
  contentSize,
  floorMapViewportHeight,
  fitTablesTransform,
  restingTransform,
  tableAtPoint,
  type MapTransform,
} from '@/features/events/event-floor-map-model';

// iOS scales a view's existing bitmap under a transform, so anything drawn once
// and then zoomed goes soft. Two fixes: images are laid out at full-zoom size and
// only ever shrunk; the drawn layer (tables, numbers, labels) is re-laid out at
// the new zoom whenever a gesture settles, so it is re-rasterized sharp.
const IMAGE_RENDER_SCALE = MAP_MAX_SCALE;
const ANIMATION = { duration: 280 };
const PINCH_TAP_GUARD_MS = 350;

type EventFloorMapProps = {
  map: SpotlightEventMap;
  /** Strong highlight: the selected vendor's tables. */
  selectedTableIds: ReadonlySet<string>;
  /** Light highlight: tables of vendors matching the search/tag. */
  matchedTableIds: ReadonlySet<string>;
  /** Changing this animates the map to fit `selectedTableIds` (or back to the whole floor). */
  focusKey: string | null;
  /** Height at the bottom covered by an overlay; a fitted selection is centred above it. */
  bottomInset?: number;
  onTablePress: (tableId: string) => void;
  /** A tap that lands on no table (clears a selection). */
  onBackgroundPress?: () => void;
  /** The enclosing scroll view, so panning a zoomed map doesn't also scroll the page. */
  scrollGesture?: GestureType | React.RefObject<unknown>;
  testID?: string;
};

export function EventFloorMap({
  map,
  selectedTableIds,
  matchedTableIds,
  focusKey,
  bottomInset = 0,
  onTablePress,
  onBackgroundPress,
  scrollGesture,
  testID = 'event-floor-map',
}: EventFloorMapProps) {
  const theme = useSpotlightTheme();
  const [viewportWidth, setViewportWidth] = useState(0);
  const viewportHeight = floorMapViewportHeight(useWindowDimensions().height);
  const viewport = useMemo(() => ({ width: viewportWidth, height: viewportHeight }), [viewportWidth, viewportHeight]);
  const { imageWidth, imageHeight } = map;
  const content = useMemo(
    () => contentSize({ imageWidth, imageHeight }, Math.max(viewportWidth, 1), viewportHeight),
    [imageHeight, imageWidth, viewportHeight, viewportWidth],
  );

  const scale = useSharedValue(1);
  // The zoom the drawn layer is laid out at; the live transform covers the rest.
  // A new zoom is drawn hidden, then swapped in once laid out, so release never
  // shows a frame at the wrong size. Each layer bakes its own zoom into its
  // transform, so nothing has to stay in sync across threads.
  const [shownZoom, setShownZoom] = useState(1);
  const [pendingZoom, setPendingZoom] = useState<number | null>(null);
  const commitZoom = useCallback((next: number) => {
    setPendingZoom(next);
  }, []);
  const onLayerReady = useCallback(
    (zoom: number) => {
      if (zoom === pendingZoom) {
        setShownZoom(zoom);
        setPendingZoom(null);
      }
    },
    [pendingZoom],
  );
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  // Fingers lifting off a pinch can read as taps; a double tap then zoomed back in.
  const pinchEndedAt = useSharedValue(0);

  const applyTransform = useCallback(
    (next: MapTransform, animated: boolean) => {
      if (animated) {
        scale.value = withTiming(next.scale, ANIMATION, (finished) => {
          if (finished) {
            runOnJS(commitZoom)(next.scale);
          }
        });
      } else {
        scale.value = next.scale;
        commitZoom(next.scale);
      }
      translateX.value = animated ? withTiming(next.translateX, ANIMATION) : next.translateX;
      translateY.value = animated ? withTiming(next.translateY, ANIMATION) : next.translateY;
    },
    [commitZoom, scale, translateX, translateY],
  );

  // Whole floor on first layout and when the floor itself changes size. Keyed on
  // sizes, not the map object: a background refetch hands over a new object and
  // used to throw the user's zoom away.
  useEffect(() => {
    if (viewportWidth > 0) {
      applyTransform(restingTransform(content, viewport), false);
    }
  }, [applyTransform, content, viewport, viewportWidth]);

  const tablesById = useMemo(() => new Map(map.tables.map((table) => [table.id, table])), [map.tables]);

  useEffect(() => {
    if (viewportWidth === 0) {
      return;
    }
    const focus = [...selectedTableIds].map((id) => tablesById.get(id)).filter((table) => table != null);
    // Deselecting (closing the card, tapping an empty table) leaves the zoom where it is.
    if (focus.length === 0) {
      return;
    }
    const fitted = fitTablesTransform(focus, content, {
      width: viewport.width,
      height: Math.max(viewport.height - bottomInset, viewport.height / 2),
    });
    // Fitting against the shorter frame centres the tables above the overlay;
    // clamping against the real one keeps the map covering the whole viewport.
    applyTransform(clampTransform(fitted, content, viewport), true);
    // Only a new focus target moves the map; highlight-only changes leave the user's zoom alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, viewportWidth]);

  const handleTap = useCallback(
    (x: number, y: number, currentScale: number, currentX: number, currentY: number) => {
      const table = tableAtPoint(
        map.tables,
        { x, y },
        { scale: currentScale, translateX: currentX, translateY: currentY },
        content,
      );
      if (table) {
        onTablePress(table.id);
      } else {
        onBackgroundPress?.();
      }
    },
    [content, map.tables, onBackgroundPress, onTablePress],
  );

  const contentWidth = content.width;
  const contentHeight = content.height;
  const viewportW = viewport.width;
  const viewportH = viewport.height;

  // The point under the fingers stays under the fingers: anchor to where the
  // pinch started, and leave the edges loose until release (clamping every
  // frame shoved the map sideways while it was narrower than the frame).
  const pinch = Gesture.Pinch()
    .onStart((event) => {
      pinchEndedAt.value = Number.MAX_SAFE_INTEGER;
      startScale.value = scale.value;
      startX.value = translateX.value;
      startY.value = translateY.value;
      focalX.value = event.focalX;
      focalY.value = event.focalY;
    })
    .onUpdate((event) => {
      // One finger already up: its focal point jumps, so hold the last frame.
      if (event.numberOfPointers < 2) {
        return;
      }
      const nextScale = Math.min(MAP_MAX_SCALE, Math.max(1, startScale.value * event.scale));
      const ratio = nextScale / startScale.value;
      scale.value = nextScale;
      translateX.value = event.focalX - (focalX.value - startX.value) * ratio;
      translateY.value = event.focalY - (focalY.value - startY.value) * ratio;
    })
    .onEnd(() => {
      const settled = clampTransform(
        { scale: scale.value, translateX: translateX.value, translateY: translateY.value },
        { width: contentWidth, height: contentHeight },
        { width: viewportW, height: viewportH },
      );
      translateX.value = withTiming(settled.translateX, ANIMATION);
      translateY.value = withTiming(settled.translateY, ANIMATION);
      runOnJS(commitZoom)(settled.scale);
    })
    .onFinalize(() => {
      pinchEndedAt.value = Date.now();
    });

  const tapBlocked = () => {
    'worklet';
    return Date.now() - pinchEndedAt.value < PINCH_TAP_GUARD_MS;
  };

  // Unzoomed, a drag belongs to the page scroll; only a zoomed map pans.
  const pan = Gesture.Pan()
    // Two fingers belong to the pinch, which already moves the map with them.
    .maxPointers(1)
    .manualActivation(true)
    .onTouchesMove((_event, state) => {
      if (scale.value > 1.01) {
        state.activate();
      } else {
        state.fail();
      }
    })
    .onStart(() => {
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((event) => {
      const next = clampTransform(
        {
          scale: scale.value,
          translateX: startX.value + event.translationX,
          translateY: startY.value + event.translationY,
        },
        { width: contentWidth, height: contentHeight },
        { width: viewportW, height: viewportH },
      );
      translateX.value = next.translateX;
      translateY.value = next.translateY;
    });
  if (scrollGesture) {
    pan.blocksExternalGesture(scrollGesture as GestureType);
  }

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      if (tapBlocked()) {
        return;
      }
      // Zoom in only, from the current level; pinch is how you zoom out.
      const nextScale = Math.min(MAP_MAX_SCALE, scale.value * DOUBLE_TAP_ZOOM_FACTOR);
      const ratio = nextScale / scale.value;
      const next = clampTransform(
        {
          scale: nextScale,
          translateX: event.x - (event.x - translateX.value) * ratio,
          translateY: event.y - (event.y - translateY.value) * ratio,
        },
        { width: contentWidth, height: contentHeight },
        { width: viewportW, height: viewportH },
      );
      scale.value = withTiming(next.scale, ANIMATION, (finished) => {
        if (finished) {
          runOnJS(commitZoom)(next.scale);
        }
      });
      translateX.value = withTiming(next.translateX, ANIMATION);
      translateY.value = withTiming(next.translateY, ANIMATION);
    });

  const singleTap = Gesture.Tap().onEnd((event) => {
    if (tapBlocked()) {
      return;
    }
    // JS-side state: must hop threads, or the gesture callback crashes.
    runOnJS(handleTap)(event.x, event.y, scale.value, translateX.value, translateY.value);
  });

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const layerZooms = pendingZoom == null || Math.abs(pendingZoom - shownZoom) < 0.01 ? [shownZoom] : [shownZoom, pendingZoom];

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setViewportWidth(Math.round(event.nativeEvent.layout.width));
  }, []);

  const highlighted = useMemo(() => {
    const rows: { id: string; selected: boolean }[] = [];
    for (const id of matchedTableIds) {
      if (!selectedTableIds.has(id)) {
        rows.push({ id, selected: false });
      }
    }
    for (const id of selectedTableIds) {
      rows.push({ id, selected: true });
    }
    return rows;
  }, [matchedTableIds, selectedTableIds]);

  return (
    <View
      onLayout={onLayout}
      // Figma 5882:12658: gray-50 frame with a gray-50 stroke at radius 8.
      style={[styles.viewport, { height: viewportHeight, backgroundColor: theme.colors.gray50, borderColor: theme.colors.gray50 }]}
      testID={testID}
    >
      {viewportWidth > 0 ? (
        // On the fixed frame, not the moving map: gesture x/y are then viewport
        // points, which is what the tap and pinch math expects.
        <GestureDetector gesture={gesture}>
          <View collapsable={false} style={StyleSheet.absoluteFill} testID={`${testID}-content`}>
            <ImageLayer
              content={content}
              map={map}
              scale={scale}
              testID={testID}
              translateX={translateX}
              translateY={translateY}
            />
            {layerZooms.map((zoom) => (
              <DrawnLayer
                content={content}
                highlighted={highlighted}
                key={zoom}
                map={map}
                onReady={onLayerReady}
                scale={scale}
                tablesById={tablesById}
                testID={testID}
                translateX={translateX}
                translateY={translateY}
                // The old zoom stays up until the new one is laid out; hiding both blinked the tables off.
                visible={zoom === shownZoom}
                zoom={zoom}
              />
            ))}
          </View>
        </GestureDetector>
      ) : null}
    </View>
  );
}

type Size = { width: number; height: number };

function boxStyle(box: { x: number; y: number; width: number; height: number }, size: Size) {
  return { height: box.height * size.height, left: box.x * size.width, top: box.y * size.height, width: box.width * size.width };
}

type LayerMotion = {
  scale: SharedValue<number>;
  translateX: SharedValue<number>;
  translateY: SharedValue<number>;
};

/**
 * The image under everything: the walls only when the map has a drawn layer,
 * else the whole floor. Laid out once at full-zoom size and only ever shrunk by
 * the live transform, so it never re-lays out (which would reload it).
 */
const ImageLayer = memo(function ImageLayer({
  content,
  map,
  scale,
  testID,
  translateX,
  translateY,
}: LayerMotion & { content: Size; map: SpotlightEventMap; testID: string }) {
  const full = { width: content.width * IMAGE_RENDER_SCALE, height: content.height * IMAGE_RENDER_SCALE };
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value / IMAGE_RENDER_SCALE },
    ],
  }));
  const box = map.vector ? boxStyle(map.vector.baseImage, full) : { left: 0, top: 0, ...full };
  return (
    <Animated.View pointerEvents="none" style={[styles.layer, full, style]}>
      <CachedImage
        cachePolicy={imageCachePolicy.full}
        contentFit="fill"
        style={[styles.box, box]}
        testID={`${testID}-image`}
        uri={map.vector ? map.vector.baseImageUrl : map.imageUrl}
      />
    </Animated.View>
  );
});

/**
 * Tables, numbers, labels and highlights, laid out AT `zoom` (never nested in a
 * scaled-down parent: iOS then rasterizes them small and they pixelate).
 */
function DrawnLayer({
  content,
  highlighted,
  map,
  onReady,
  scale,
  tablesById,
  testID,
  translateX,
  translateY,
  visible,
  zoom,
}: LayerMotion & {
  content: Size;
  highlighted: readonly { id: string; selected: boolean }[];
  map: SpotlightEventMap;
  onReady: (zoom: number) => void;
  tablesById: ReadonlyMap<string, SpotlightEventMapTable>;
  testID: string;
  visible: boolean;
  zoom: number;
}) {
  const theme = useSpotlightTheme();
  const size = useMemo(() => ({ width: content.width * zoom, height: content.height * zoom }), [content, zoom]);
  const style = useAnimatedStyle(
    () => ({
      transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value / zoom }],
    }),
    [zoom],
  );
  return (
    <Animated.View
      onLayout={() => onReady(zoom)}
      pointerEvents="none"
      style={[styles.layer, size, { opacity: visible ? 1 : 0 }, style]}
    >
      {map.vector ? <FloorDrawing size={size} tables={map.tables} vector={map.vector} /> : null}
      {highlighted.map(({ id, selected }) => {
        const table = tablesById.get(id);
        if (!table) {
          return null;
        }
        return (
          <View
            key={id}
            style={[
              styles.box,
              boxStyle(table, size),
              {
                backgroundColor: theme.colors.purple500,
                borderColor: selected ? theme.colors.gray900 : theme.colors.purple500,
                borderWidth: selected ? 2 : 1,
                // See-through enough to read the table numbers underneath.
                opacity: selected ? 0.6 : 0.35,
              },
            ]}
            testID={visible ? `${testID}-highlight-${id}` : undefined}
          />
        );
      })}
    </Animated.View>
  );
}

/** Areas, tables with their numbers, and labels, drawn at the current zoom so they stay sharp. */
const FloorDrawing = memo(function FloorDrawing({
  size,
  tables,
  vector,
}: {
  size: Size;
  tables: readonly SpotlightEventMapTable[];
  vector: SpotlightEventMapVector;
}) {
  const theme = useSpotlightTheme();
  const numberSize = vector.tableNumberSize * size.height;
  return (
    <View pointerEvents="none" style={[styles.box, { left: 0, top: 0, ...size }]}>
      {vector.areas.map((area, index) => (
        <View
          // Areas never reorder within one map.
          key={`area-${index}`}
          style={[
            styles.box,
            boxStyle(area, size),
            {
              backgroundColor: area.color,
              opacity: area.opacity,
              ...(area.shape === 'ellipse' ? { borderRadius: (area.width * size.width) / 2 } : null),
            },
          ]}
        />
      ))}
      {tables.map((table) => (
        <View key={table.id} style={[styles.box, styles.table, boxStyle(table, size), { backgroundColor: vector.tableColor }]}>
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            style={[styles.tableNumber, { color: theme.colors.gray900, fontSize: numberSize }]}
          >
            {table.number}
          </Text>
        </View>
      ))}
      {vector.labels.map((label) => {
        const fontSize = label.fontSize * size.height;
        const box = boxStyle(label, size);
        // Centered on the Figma box; text is allowed to run past it rather than clip.
        const width = Math.max(box.width, fontSize * label.text.length);
        return (
          <Text
            allowFontScaling={false}
            key={`${label.text}-${label.x}-${label.y}`}
            style={[
              styles.box,
              styles.label,
              {
                color: theme.colors.gray900,
                fontSize,
                fontWeight: label.bold ? '700' : '400',
                left: box.left + box.width / 2 - width / 2,
                lineHeight: fontSize * 1.1,
                top: box.top,
                width,
              },
            ]}
          >
            {label.text}
          </Text>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  viewport: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: borderWidths.containerRule,
    overflow: 'hidden',
  },
  content: {
    left: 0,
    position: 'absolute',
    top: 0,
    transformOrigin: 'left top',
  },
  rendered: {
    left: 0,
    position: 'absolute',
    top: 0,
    transformOrigin: 'left top',
  },
  box: {
    position: 'absolute',
  },
  layer: {
    left: 0,
    position: 'absolute',
    top: 0,
    transformOrigin: 'left top',
  },
  table: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tableNumber: {
    fontWeight: '600',
    includeFontPadding: false,
    textAlign: 'center',
  },
  label: {
    textAlign: 'center',
  },
});
