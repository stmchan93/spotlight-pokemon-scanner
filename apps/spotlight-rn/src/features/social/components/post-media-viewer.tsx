import { useState, type ReactNode } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Xmark } from 'iconoir-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CarouselPagination,
  GlassNavBubble,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

/** Figma 6322:8419 draws the edge-to-edge photo at 361:491. */
export const POST_VIEWER_IMAGE_ASPECT_RATIO = 361 / 491;

type PostMediaViewerProps = {
  visible: boolean;
  onClose: () => void;
  /** The author's name, centered in the toolbar. */
  title: string;
  header: ReactNode;
  body?: ReactNode;
  /** One edge-to-edge image per page; more than one makes the row swipeable. */
  pages: ReactNode[];
  /** The image the viewer was opened on. Read when the modal's content mounts. */
  initialPage: number;
  metrics: ReactNode;
  /**
   * The card's sheets. They must live inside this Modal while it is up: a sibling
   * modal would try to present from a controller that is already presenting.
   */
  children?: ReactNode;
  testID?: string;
};

/**
 * The full-screen post view (Figma 6322:8404): black backdrop, close + author
 * toolbar, the post's header and body, an edge-to-edge photo, and the metrics.
 * Layout only — `PostCard` owns the content and interaction state, so a like made
 * here is already on the card underneath when this closes.
 */
export function PostMediaViewer({
  visible,
  onClose,
  title,
  header,
  body,
  pages,
  initialPage,
  metrics,
  children,
  testID = 'post-media-viewer',
}: PostMediaViewerProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [activePage, setActivePage] = useState(initialPage);

  const handlePageSettled = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setActivePage(Math.round(event.nativeEvent.contentOffset.x / width));
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      onShow={() => setActivePage(initialPage)}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <StatusBar style="light" />
      <View
        style={[styles.root, { backgroundColor: theme.colors.mediaBackdrop }]}
        testID={testID}
      >
        <View style={[styles.toolbar, { paddingTop: insets.top }]}>
          <GlassNavBubble
            accessibilityLabel="Close"
            onPress={onClose}
            surface="onDark"
            testID={`${testID}-close`}
          >
            <Xmark
              color={theme.colors.gray0}
              height={glassNavBubbleGlyphSize}
              strokeWidth={glassNavBubbleGlyphStrokeWidth}
              width={glassNavBubbleGlyphSize}
            />
          </GlassNavBubble>
          <View
            pointerEvents="none"
            style={[styles.titleSlot, { top: insets.top }]}
          >
            <Text
              numberOfLines={1}
              style={[theme.typography.titleMedium, { color: theme.colors.gray0 }]}
              testID={`${testID}-title`}
            >
              {title}
            </Text>
          </View>
        </View>

        {/* Centered per Figma; scrolls only when a long caption overflows the screen. */}
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + CONTENT_BOTTOM_GAP },
          ]}
          showsVerticalScrollIndicator={false}
          style={styles.scroll}
        >
          <View style={styles.postText}>
            {header}
            {body}
          </View>
          <View>
            <ScrollView
              contentOffset={{ x: initialPage * width, y: 0 }}
              horizontal
              onMomentumScrollEnd={handlePageSettled}
              pagingEnabled
              scrollEnabled={pages.length > 1}
              showsHorizontalScrollIndicator={false}
              testID={`${testID}-pager`}
            >
              {pages.map((page, index) => (
                <View key={index} style={{ width }}>
                  {page}
                </View>
              ))}
            </ScrollView>
            <View pointerEvents="none" style={styles.pagination}>
              <CarouselPagination activeIndex={activePage} count={pages.length} />
            </View>
          </View>
          {metrics}
        </ScrollView>
        {children}
      </View>
    </Modal>
  );
}

// Figma 6322:8405 sits 14 under the toolbar and 41 above the screen's bottom edge
// (34 of which is the home indicator); centering between those lands it exactly.
const CONTENT_TOP_GAP = 14;
const CONTENT_BOTTOM_GAP = 7;
const TOOLBAR_HEIGHT = 44;

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: 12,
    justifyContent: 'center',
    paddingTop: CONTENT_TOP_GAP,
  },
  pagination: {
    alignItems: 'center',
    bottom: 12,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  postText: {
    gap: 8,
  },
  root: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  // Absolute so the name centers on the screen, not in the space beside the button.
  titleSlot: {
    alignItems: 'center',
    height: TOOLBAR_HEIGHT,
    justifyContent: 'center',
    left: 68,
    position: 'absolute',
    right: 68,
  },
  toolbar: {
    alignItems: 'flex-start',
    paddingBottom: 10,
    paddingHorizontal: 16,
  },
});
