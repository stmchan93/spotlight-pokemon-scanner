import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, View, type ImageSourcePropType } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Image as SvgImage } from 'react-native-svg';

import { useAuth } from '@/providers/auth-provider';

/**
 * The `You` tab's icon: the signed-in user's profile photo, circular.
 *
 * ===========================================================================
 * WHY THIS IS NOT JUST `<Icon src={{ uri }} />`
 * ===========================================================================
 * That much works — react-native-screens hands the source to
 * `RCTImageLoader.loadImageWithURLRequest` (`RNSImageLoadingHelper.mm`), so a
 * remote URL really does load into a native tab item. What it will NOT do is
 * clip it: a tab item renders a `UIImage`, and the `borderRadius`-on-a-`View`
 * trick every other avatar in this app uses is a VIEW property that no UIImage
 * can carry. A square photograph between three SF Symbols reads as broken.
 *
 * Nothing installed can bake the circle either — `expo-image-manipulator` is
 * crop/resize/rotate/flip/extent only, with no alpha mask or compositing. So the
 * circle is drawn where a circle can be drawn (an SVG) and then RASTERISED:
 * `Svg.toDataURL()` returns the rendered canvas as base64 PNG, and a `data:` URI
 * is something `RCTImageLoader` accepts exactly like a remote one.
 *
 * This costs no new dependency (react-native-svg is already here for the app
 * mark) and no native build, so it ships over OTA like the rest of this work.
 *
 * ===========================================================================
 * WHY A PROVIDER AND NOT A HOOK IN THE LAYOUT
 * ===========================================================================
 * `toDataURL` is a method on a MOUNTED `Svg`, so the source SVG has to exist in
 * the tree — and it cannot live inside `<NativeTabs>`. `NativeBottomTabsNavigator`
 * splits its children into triggers and non-triggers, and the non-triggers are
 * only ever searched for a `BottomAccessory` (`NativeTabsView.js`) — anything
 * else is silently dropped, never rendered, so `onLoad` would never fire.
 *
 * The rasteriser therefore mounts next to the app's other root-level chrome and
 * publishes the finished icon through context. `useCircularTabAvatar()` defaults
 * to `null` with no provider present, which is also what lets the tabs layout be
 * rendered bare in tests.
 */

/**
 * Points the tab item draws at, and the scale the PNG is tagged with. iOS sizes
 * a tab icon from the `UIImage`'s own dimensions, so an 84px bitmap tagged
 * `scale: 1` would render as an 84pt icon and swamp the bar. Tagged `scale: 3`
 * it is 28pt of @3x artwork, which is what a tab item wants.
 */
const TAB_ICON_POINTS = 28;
const RASTER_SCALE = 3;
const RASTER_PX = TAB_ICON_POINTS * RASTER_SCALE;

/** Single `<Defs>` id; only one of these is ever mounted at a time. */
const CLIP_ID = 'circular-tab-avatar-clip';

const CircularTabAvatarContext = createContext<ImageSourcePropType | null>(null);

/**
 * The rasterised circular avatar, or `null` when there isn't one yet — no photo
 * on the account, a guest, or the raster still in flight. Callers fall back to
 * an SF Symbol.
 */
export function useCircularTabAvatar(): ImageSourcePropType | null {
  return useContext(CircularTabAvatarContext);
}

export function CircularTabAvatarProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth();
  const avatarURL = currentUser?.avatarURL ?? null;

  const svgRef = useRef<Svg>(null);
  // Keyed by the URL it was rendered from, so a raster from the PREVIOUS photo
  // can never be served for the current one.
  const [raster, setRaster] = useState<{ source: ImageSourcePropType; url: string } | null>(null);

  // Changing the photo (or signing out) invalidates the raster immediately —
  // the tab falls back to the glyph for the frame or two it takes to redraw,
  // rather than showing the old face.
  useEffect(() => {
    setRaster((current) => (current && current.url === avatarURL ? current : null));
  }, [avatarURL]);

  // Rasterise only once the bitmap is actually inside the SVG. Calling
  // `toDataURL` on mount would capture an empty canvas, because the href is a
  // network fetch — `onLoad` is the moment there is something to capture.
  const handleImageLoaded = useCallback(() => {
    const node = svgRef.current;
    if (!node || !avatarURL) {
      return;
    }
    node.toDataURL((base64) => {
      setRaster({
        url: avatarURL,
        source: {
          uri: `data:image/png;base64,${base64}`,
          width: TAB_ICON_POINTS,
          height: TAB_ICON_POINTS,
          scale: RASTER_SCALE,
        },
      });
    });
  }, [avatarURL]);

  const value = raster && raster.url === avatarURL ? raster.source : null;

  return (
    <CircularTabAvatarContext.Provider value={value}>
      {children}
      {avatarURL && !value ? (
        // Off-screen rather than hidden: `toDataURL` renders the SVG's own
        // canvas, but the view still has to be mounted and laid out for there to
        // be a canvas. Parked far off the top edge so it can never be seen or
        // touched, and unmounted the moment the raster lands.
        <View pointerEvents="none" style={styles.offscreen}>
          <Svg height={RASTER_PX} ref={svgRef} width={RASTER_PX}>
            <Defs>
              <ClipPath id={CLIP_ID}>
                <Circle cx={RASTER_PX / 2} cy={RASTER_PX / 2} r={RASTER_PX / 2} />
              </ClipPath>
            </Defs>
            <SvgImage
              clipPath={`url(#${CLIP_ID})`}
              height={RASTER_PX}
              href={{ uri: avatarURL }}
              onLoad={handleImageLoaded}
              // `slice` = CSS `cover`: fill the circle and crop the overflow, so
              // a non-square photo is centre-cropped instead of letterboxed.
              preserveAspectRatio="xMidYMid slice"
              width={RASTER_PX}
            />
          </Svg>
        </View>
      ) : null}
    </CircularTabAvatarContext.Provider>
  );
}

const styles = StyleSheet.create({
  offscreen: {
    height: RASTER_PX,
    left: 0,
    position: 'absolute',
    top: -RASTER_PX * 4,
    width: RASTER_PX,
  },
});
