import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Rect } from 'react-native-svg';

import type { SpotlightEventMap } from '@spotlight/api-client';
import { borderWidths, radii, useSpotlightTheme } from '@spotlight/design-system';

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
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const applyTransform = useCallback(
    (next: MapTransform, animated: boolean) => {
      scale.value = animated ? withTiming(next.scale, ANIMATION) : next.scale;
      translateX.value = animated ? withTiming(next.translateX, ANIMATION) : next.translateX;
      translateY.value = animated ? withTiming(next.translateY, ANIMATION) : next.translateY;
    },
    [scale, translateX, translateY],
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
      scale.value = withTiming(next.scale, ANIMATION);
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
        <GestureDetector gesture={gesture}>
          <Animated.View
            style={[styles.content, { height: content.height, width: content.width }, contentStyle]}
            testID={`${testID}-content`}
          >
            <CachedImage
              cachePolicy={imageCachePolicy.full}
              contentFit="fill"
              style={{ height: content.height, width: content.width }}
              testID={`${testID}-image`}
              uri={map.imageUrl}
            />
            <Svg height={content.height} pointerEvents="none" style={styles.overlay} width={content.width}>
              {highlighted.map(({ id, selected }) => {
                const table = tablesById.get(id);
                if (!table) {
                  return null;
                }
                return (
                  <Rect
                    fill={theme.colors.purple500}
                    fillOpacity={selected ? 0.9 : 0.35}
                    height={table.height * content.height}
                    key={id}
                    rx={1}
                    stroke={selected ? theme.colors.gray900 : theme.colors.purple500}
                    strokeWidth={selected ? 0.6 : 0.4}
                    testID={`${testID}-highlight-${id}`}
                    width={table.width * content.width}
                    x={table.x * content.width}
                    y={table.y * content.height}
                  />
                );
              })}
            </Svg>
          </Animated.View>
        </GestureDetector>
      ) : null}
    </View>
  );
}

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
  overlay: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
});
