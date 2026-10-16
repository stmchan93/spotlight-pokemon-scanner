import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { SpotlightEventMap, SpotlightEventMapTable, SpotlightEventMapVector } from '@spotlight/api-client';
import { Text, borderWidths, radii, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import {
  MAP_MAX_SCALE,
  clampTransform,
  contentSize,
  fitTablesTransform,
  restingTransform,
  tableAtPoint,
  type MapTransform,
} from '@/features/events/event-floor-map-model';

const VIEWPORT_HEIGHT = 440;
// iOS scales a view's existing bitmap under a transform, so anything drawn once
// and then zoomed goes soft. Two fixes: images are laid out at full-zoom size and
// only ever shrunk; the drawn layer (tables, numbers, labels) is re-laid out at
// the new zoom whenever a gesture settles, so it is re-rasterized sharp.
const IMAGE_RENDER_SCALE = MAP_MAX_SCALE;
const DOUBLE_TAP_SCALE = 2.5;
const ANIMATION = { duration: 280 };

type EventFloorMapProps = {
  map: SpotlightEventMap;
  /** Strong highlight: the selected vendor's tables. */
  selectedTableIds: ReadonlySet<string>;
  /** Light highlight: tables of vendors matching the search/tag. */
  matchedTableIds: ReadonlySet<string>;
  /** Changing this animates the map to fit `selectedTableIds` (or back to the whole floor). */
  focusKey: string | null;
  onTablePress: (tableId: string) => void;
  /** The enclosing scroll view, so panning a zoomed map doesn't also scroll the page. */
  scrollGesture?: GestureType | React.RefObject<unknown>;
  testID?: string;
};

export function EventFloorMap({
  map,
  selectedTableIds,
  matchedTableIds,
  focusKey,
  onTablePress,
  scrollGesture,
  testID = 'event-floor-map',
}: EventFloorMapProps) {
  const theme = useSpotlightTheme();
  const [viewportWidth, setViewportWidth] = useState(0);
  const viewport = useMemo(() => ({ width: viewportWidth, height: VIEWPORT_HEIGHT }), [viewportWidth]);
  const content = useMemo(
    () => contentSize(map, Math.max(viewportWidth, 1), VIEWPORT_HEIGHT),
    [map, viewportWidth],
  );

  const scale = useSharedValue(1);
  // The zoom the drawn layer is laid out at. It is shrunk back by a static
  // transform set in the SAME render as its size, so a change never shows a
  // frame at the wrong size (the flicker on pinch release).
  const [layoutZoom, setLayoutZoom] = useState(1);
  const commitZoom = useCallback((next: number) => {
    setLayoutZoom((current) => (Math.abs(current - next) < 0.01 ? current : next));
  }, []);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

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

  // Whole floor on first layout and whenever a different map arrives.
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
    applyTransform(fitTablesTransform(focus, content, viewport), true);
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
      }
    },
    [content, map.tables, onTablePress],
  );

  const contentWidth = content.width;
  const contentHeight = content.height;
  const viewportW = viewport.width;

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((event) => {
      const nextScale = Math.min(MAP_MAX_SCALE, Math.max(1, startScale.value * event.scale));
      const ratio = nextScale / startScale.value;
      const next = clampTransform(
        {
          scale: nextScale,
          translateX: event.focalX - (event.focalX - startX.value) * ratio,
          translateY: event.focalY - (event.focalY - startY.value) * ratio,
        },
        { width: contentWidth, height: contentHeight },
        { width: viewportW, height: VIEWPORT_HEIGHT },
      );
      scale.value = next.scale;
      translateX.value = next.translateX;
      translateY.value = next.translateY;
    })
    .onEnd(() => {
      runOnJS(commitZoom)(scale.value);
    });

  // Unzoomed, a drag belongs to the page scroll; only a zoomed map pans.
  const pan = Gesture.Pan()
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
        { width: viewportW, height: VIEWPORT_HEIGHT },
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
      const zoomIn = scale.value < DOUBLE_TAP_SCALE - 0.1;
      const nextScale = zoomIn ? DOUBLE_TAP_SCALE : 1;
      const ratio = nextScale / scale.value;
      const next = clampTransform(
        {
          scale: nextScale,
          translateX: event.x - (event.x - translateX.value) * ratio,
          translateY: event.y - (event.y - translateY.value) * ratio,
        },
        { width: contentWidth, height: contentHeight },
        { width: viewportW, height: VIEWPORT_HEIGHT },
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
    // JS-side state: must hop threads, or the gesture callback crashes.
    runOnJS(handleTap)(event.x, event.y, scale.value, translateX.value, translateY.value);
  });

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));
  const drawn = useMemo(
    () => ({ width: content.width * layoutZoom, height: content.height * layoutZoom }),
    [content, layoutZoom],
  );

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
      style={[styles.viewport, { backgroundColor: theme.colors.gray50, borderColor: theme.colors.gray200 }]}
      testID={testID}
    >
      {viewportWidth > 0 ? (
        // On the fixed frame, not the moving map: gesture x/y are then screen
        // (viewport) points, which is what the tap and pinch math expects.
        <GestureDetector gesture={gesture}>
          <View collapsable={false} style={StyleSheet.absoluteFill}>
            <Animated.View
              style={[styles.content, { height: content.height, width: content.width }, contentStyle]}
              testID={`${testID}-content`}
            >
              <MapImage content={content} map={map} testID={testID} />
              <View
                pointerEvents="none"
                style={[styles.rendered, { ...drawn, transform: [{ scale: 1 / layoutZoom }] }]}
              >
                {map.vector ? <FloorDrawing size={drawn} tables={map.tables} vector={map.vector} /> : null}
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
                        boxStyle(table, drawn),
                        {
                          backgroundColor: theme.colors.purple500,
                          borderColor: selected ? theme.colors.gray900 : theme.colors.purple500,
                          borderWidth: selected ? 2 : 1,
                          opacity: selected ? 0.9 : 0.35,
                        },
                      ]}
                      testID={`${testID}-highlight-${id}`}
                    />
                  );
                })}
              </View>
            </Animated.View>
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

/**
 * The image under everything: the walls only when the map has a drawn layer,
 * else the whole floor. Laid out at full-zoom size and shrunk by a static
 * transform, so a zoom change never re-lays it out (which would reload it).
 */
const MapImage = memo(function MapImage({
  content,
  map,
  testID,
}: {
  content: Size;
  map: SpotlightEventMap;
  testID: string;
}) {
  const full = { width: content.width * IMAGE_RENDER_SCALE, height: content.height * IMAGE_RENDER_SCALE };
  const box = map.vector ? boxStyle(map.vector.baseImage, full) : { left: 0, top: 0, ...full };
  return (
    <View
      pointerEvents="none"
      style={[styles.rendered, { ...full, transform: [{ scale: 1 / IMAGE_RENDER_SCALE }] }]}
    >
      <CachedImage
        cachePolicy={imageCachePolicy.full}
        contentFit="fill"
        style={[styles.box, box]}
        testID={`${testID}-image`}
        uri={map.vector ? map.vector.baseImageUrl : map.imageUrl}
      />
    </View>
  );
});

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
    borderRadius: radii.lg,
    borderWidth: borderWidths.containerRule,
    height: VIEWPORT_HEIGHT,
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
