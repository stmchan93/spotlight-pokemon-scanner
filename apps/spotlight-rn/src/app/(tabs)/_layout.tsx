import { usePathname } from 'expo-router';
import { Platform } from 'react-native';
import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { colors } from '@spotlight/design-system';

import { useCircularTabAvatar } from '@/components/circular-tab-avatar';
import { rememberActiveTab } from '@/lib/last-active-tab';
import { NativeTabScreenProvider } from '@/lib/tab-bar-insets';

const { Trigger } = NativeTabs;
const { Icon, Label } = Trigger;

// Module scope so the object identity is stable across renders — `contentStyle`
// ends up in the tab's navigation options, and a fresh object every render would
// make those options look changed on every pathname update.
const scannerTabContentStyle = { backgroundColor: colors.scannerCanvas } as const;

/**
 * The app's tab bar: Apple's native iOS 26 tab controller, which is what gives
 * the real Liquid Glass material and the system minimize-on-scroll.
 *
 * REPLACED `TopTabsPager`. What that cost, so nobody re-derives it:
 *  - the horizontal Portfolio <-> Scanner swipe (UITabBarController has no
 *    swipe-between-tabs gesture; absent from TabsHost and expo-router alike).
 *    THIS IS NOW THE INTENDED BEHAVIOUR, not a gap to close: no screen that
 *    draws this bar may be reached or left by a horizontal swipe. The scanner's
 *    hand-rolled left-edge exit swipe was deleted for the same reason. Pushed
 *    stack screens keep UIKit's back-swipe — that rule is only about the tabs.
 *  - the left-edge drag that opened the hamburger drawer, which lived inside
 *    the pager's pan responder — the drawer BUTTON still works
 *  - hiding the bar during Collection edit mode; UIKit owns this bar and
 *    `hidden` on a TRIGGER hides a tab; `hidden` on <NativeTabs> hides the bar,
 *    which is how the Scanner gets a full screen (see below)
 *
 * Scan is a real tab because a native bar cannot host a push-button:
 * NativeBottomTabsNavigator emits `tabPress` then dispatches JUMP_TO without
 * reading `defaultPrevented`. The cost is that the bar draws over the viewfinder
 * and insets it. `disableAutomaticContentInsets` fixes that but needs
 * react-native-screens 4.25+ (we are on 4.23.0) — a native build, not an OTA.
 *
 * The pager is still in git history if this needs reverting.
 *
 * SELECTED-TAB COLOUR — why `tintColor` and nothing else.
 * Without it UIKit uses the system accent (iOS blue). `tintColor` is the ONE
 * prop that covers every surface of the selected item, because expo-router fans
 * it out three ways (expo-router/build/native-tabs/NativeBottomTabsNavigator.js
 * + NativeTabsView.js):
 *   1. `selectedIconColor: iconColor.selected ?? tintColor`
 *      -> standardAppearance.stacked.selected.tabBarItemIconColor  (ICON)
 *   2. `selectedLabelStyle: { color: tintColor }`
 *      -> standardAppearance.stacked.selected.tabBarItemTitleFontColor (LABEL)
 *   3. `tabBarTintColor={tintColor}` on the react-native-screens host, which per
 *      TabsHost.types.ts also tints the iOS 26 Liquid Glass SELECTION GLOW.
 * Setting `iconColor`/`labelStyle` on top would only re-state 1 and 2 while
 * risking a mismatch with 3, so this stays a single source of truth.
 *
 * UNSELECTED items are deliberately left alone: expo-router only writes these
 * values into the `selected`/`focused` appearance states, and react-native-screens
 * documents that from iOS 26 the unselected items follow the tab bar's own
 * light/dark appearance. Forcing gray900 on `normal` too would kill that
 * contrast in dark mode.
 *
 * `minimizeBehavior` — WHAT IT ACTUALLY DEPENDS ON. This was twice written off
 * as blocked on native support. It is not: the requirement is a JS-side tree
 * shape, and it is met in `portfolio-screen.tsx`, not here.
 *
 * The prop reaches UIKit fine — expo-router forwards it as
 * `tabBarMinimizeBehavior` and `RNSBottomTabsHostComponentView` assigns
 * `_controller.tabBarMinimizeBehavior` behind an iOS 26 SDK check. UIKit then
 * has to work out WHICH scroll view to track, and it finds it by walking
 * `subviews[0]` down from the tab screen's view. react-native-screens 4.23.0
 * indeed never implements `contentScrollViewForEdge:`, but it does not need to:
 * it replicates the same walk in
 * `ios/helpers/scroll-view/RNSScrollViewFinder.mm`, whose header says outright
 * that it works "similar to UIKit behavior". DEPTH IS NOT THE CONSTRAINT — the
 * walk is unbounded, and expo-router's own two wrappers (a `<SafeAreaProvider>`
 * and a `<View collapsable={false}>`, in NativeTabsView.js `Screen()`) are both
 * real single-child views and pass it fine.
 *
 * What breaks it is React Native VIEW FLATTENING. A plain `<View>` that has a
 * `testID` but no stacking-context trigger is mounted as a real but EMPTY
 * UIView, with its children re-parented as its own siblings
 * (`ViewShadowNode::initialize` + `sliceChildShadowNodeViewPairs.cpp`). One such
 * wrapper anywhere on the chain parks a childless view at index 0 and the walk
 * returns nil. `collapsable={false}` on that wrapper is the whole fix, and is
 * what the screens maintainer prescribes in
 * software-mansion/react-native-screens#3954. (#4145 is a different, still-open
 * case: a scroll view under a nested native STACK, which no JS flag reaches.)
 *
 * So: if minimize ever stops working, do not look here and do not look at
 * `contentInsetAdjustmentBehavior`. Look for a new unflattened `<View>` between
 * the tab screen and the list. `<DrawerEdgeSwipe>` in wrapper mode is safe — its
 * PanResponder handlers set `ViewEvents` bits, which force a stacking context on
 * their own.
 */
export default function TabsLayout() {
  // Hide the BAR ITSELF on the Scanner. `hidden` on <NativeTabs> maps to
  // react-native-screens' `tabBarHidden` (NativeTabsView.js) — note this is NOT
  // the `hidden` on a Trigger, which removes a TAB from the bar entirely.
  //
  // This is what finally makes Scan work as a normal tab. Four earlier attempts
  // tried to keep the camera off the tab bar by making Scan a LAUNCHER that
  // pushed a full-screen route, and every one of them stranded the user on the
  // blank launcher after backing out: pushing from a tab means something has to
  // move the tab selection afterwards, and nothing reliably does while the tabs
  // are covered. Hiding the bar removes the entire problem — there is no push,
  // so there is nothing to come back from.
  //
  // THIS WORKS ON ANDROID TOO — checked, because "tabBarHidden is an iOS prop"
  // is the obvious guess and it is wrong. react-native-screens 4.23.0 documents
  // it `@platform android, ios` (`src/components/tabs/TabsHost.types.ts`) and
  // implements it: `TabsHostViewManager.kt` has the `@ReactProp`, and
  // `TabsHostAppearanceApplicator.kt` does `bottomNavigationView.isVisible =
  // !tabsHost.tabBarHidden`, i.e. View.GONE.
  //
  // And on Android it could never have insetted the content anyway: `TabsHost`
  // is a FrameLayout that adds the content at MATCH_PARENT and the
  // BottomNavigationView OVER it at Gravity.BOTTOM (`TabsHost.kt`). Android's
  // bar floats on a full-bleed screen; UIKit's shrinks one. So if something on
  // this route ever looks vertically shifted on Android, the bar is not the
  // suspect — the JS wrapper called out on the Scan trigger below is.
  const pathname = usePathname();
  const isScanner = pathname === '/scan';
  // Remember where the user was so leaving the Scanner can put them back. This
  // is the only place that sees every tab change, and `rememberActiveTab`
  // ignores `/scan` itself — otherwise opening the Scanner would immediately
  // overwrite the very answer we are storing. Recorded during render rather than
  // in an effect: it is a plain assignment to module scope with no subscribers,
  // so there is nothing to schedule or clean up.
  rememberActiveTab(pathname);
  // Null until the user's photo has been rasterised into a circle — see
  // `circular-tab-avatar.tsx` for why a tab icon cannot just be a remote URL.
  const avatarIcon = useCircularTabAvatar();

  return (
    /*
      MARKS EVERY SCREEN BELOW AS "UIKit/Material already inset my container".

      Android-only in effect, and it is not a route check on purpose: native tabs
      keep every tab screen MOUNTED, so asking `usePathname()` from inside a
      screen would have an unfocused tab answer for whatever tab IS focused.
      Provider membership does not move. See `@/lib/tab-bar-insets` for what the
      two platforms each need and why neither can be a hardcoded bar height.
    */
    <NativeTabScreenProvider>
    {/*
      ANDROID GETS ITS OWN APPEARANCE, EXPLICITLY.

      Everything else on this component is iOS: `minimizeBehavior` is iOS 26,
      `sf` icons are SF Symbols, and `tintColor` drives the Liquid Glass
      selection glow. Left at that, expo-router fell through to its Material 3
      defaults (`NativeTabsView.js`), whose background is
      `Color.android.dynamic.surfaceContainer` — Material You, derived from the
      user's WALLPAPER. So the bar was not merely the wrong colour, it was a
      different colour on every Android device, and with no icons at all (see
      `md` below) it read as a tall white slab.

      This is the same rule `GlassSurface` already follows for our own chrome:
      real glass where the platform has it, an honest solid token everywhere
      else — never a blur knockoff. The bar the OS owns just has to be told in
      its own API rather than through a `fallbackColor` prop.

      Every colour below is Android-only; iOS ignores them and keeps its glass.
    */}
    <NativeTabs
      backgroundColor={colors.canvasElevated}
      hidden={isScanner}
      // The Material pill behind the selected icon. Left to Material You this
      // was `secondaryContainer` — a wallpaper-derived accent.
      indicatorColor={colors.gray100}
      /*
        Material's default is LABEL_VISIBILITY_AUTO, which shows labels only
        while there are THREE OR FEWER tabs and drops them at four or more.
        We have exactly four (Home/Scan/Wishlist/You), so Android silently
        landed on the wrong side of that threshold and showed bare icons while
        iOS showed labels. Pin it rather than sit one tab away from a
        behaviour change.
      */
      labelVisibilityMode="labeled"
      minimizeBehavior="onScrollDown"
      rippleColor={colors.gray200}
      tintColor={colors.gray900}
    >
      {/*
        Home / Scan / Wishlist / You, in that order.

        `index` is the FEED now, not Collection — the app's landing surface is
        social. Collection moved to `you` and kept its screen unchanged; the
        legacy `/portfolio` path redirects there so old links still resolve.

        ─────────────────────────────────────────────────────────────────────
        THE FIGMA VECTORS ARE THE SOURCE OF TRUTH FOR THESE GLYPHS.
        ─────────────────────────────────────────────────────────────────────
        Figma 3670:48082 (Home), 3670:48086 (Scan), 3670:48091 (Wishlist). The
        frames do not draw invented artwork — they draw glyphs the app already
        owns, which is what makes matching them cheap:

          Home      iconoir `HomeSimple`  — the house plus its `M9 17H15` slot
          Wishlist  iconoir `Bookmark`    — ink is exactly 14x18 in a 24 box,
                                            which is the size Figma reports
          Scan      Apple's SF `viewfinder`

        A NATIVE bar takes a platform symbol name or a raster image, never a
        React component — and iconoir only ships components. So the two iconoir
        glyphs are rasterized from the INSTALLED PACKAGE by
        `tools/generate_tab_icons.py` (not from a Figma export, which expires
        and drifts from the icons the rest of the app draws) and land here as
        `src` images. Regenerate after an iconoir upgrade.

        No `renderingMode` on them, deliberately — the opposite of the avatar
        below. Left to default, `tintColor` makes them TEMPLATE images, so the
        OS tints them for selection on both platforms. That is also why the
        source PNGs are plain black: only their alpha survives.

        SCAN IS THE EXCEPTION, AND FOR A LICENSING REASON. Its frame draws
        Apple's own `viewfinder`, which iOS renders natively — nothing to
        rasterize. It is NOT rasterized for Android either: the SF Symbols
        license does not permit shipping Apple's artwork on other platforms, so
        Android keeps a Material glyph. That is the one place the two platforms
        differ from each other by design.

        The labels stay the system font. The frame specifies Plus Jakarta Sans
        SemiBold 10/12, but the label belongs to the OS here — on iOS 26 it is
        part of what gets rendered into the glass.
      */}
      <Trigger name="index">
        {/* One image for both platforms — see the note above. */}
        <Icon src={require('../../../assets/images/tab-icons/home.png')} />
        <Label>Home</Label>
      </Trigger>
      {/*
        NO BOTTOM INSET ON THE SCANNER.

        On Android expo-router wraps every tab's content in
        `<SafeAreaView edges={{ bottom: true }}>` unless this is set
        (`NativeTabsView.js`). The scanner HIDES the bar (`hidden={isScanner}`
        above), so that inset reserves room for chrome that is not drawn —
        shifting the whole viewfinder up and pushing the EN/JP toggle down onto
        the reticle.

        Worth being precise, because the note above says this needs
        react-native-screens 4.25+ and we are on 4.23: that applies to
        `overrideScrollViewContentInsetAdjustmentBehavior`, the NATIVE
        scroll-view half of the same prop. The Android wrapper above is plain
        JS in the version already installed, which is the half that moves the
        reticle — so this ships by OTA, no native build.
      */}
      {/*
        BLACK CANVAS UNDER THE SCANNER ON ANDROID.

        expo-router paints every tab's content view with the React Navigation
        theme background before it applies `contentStyle`
        (`NativeTabsView.js` `Screen()`: `style={[{ backgroundColor:
        colors.background }, options.contentStyle, …]}`), and this app's theme
        background is `#FFFFFF` (`src/app/_layout.tsx`). On the three light tabs
        that is invisible; under a full-bleed viewfinder it is a white sheet the
        camera has to cover on its very first frame. Naming the canvas removes
        the whole class rather than relying on the scanner painting first.

        Android-only, because the iOS tree is deliberately left byte-for-byte
        alone — and NOT the white bar reported on the Galaxy A17. That one is
        the SYSTEM navigation bar's contrast scrim, which the platform draws on
        the window decor above every React view and no JS style can reach; see
        the note in `scan.tsx`.
      */}
      <Trigger
        contentStyle={Platform.OS === 'android' ? scannerTabContentStyle : undefined}
        disableAutomaticContentInsets
        name="scan"
      >
        <Icon md="qr_code_scanner" sf={{ default: 'viewfinder', selected: 'viewfinder' }} />
        <Label>Scan</Label>
      </Trigger>
      <Trigger name="wishlist">
        <Icon src={require('../../../assets/images/tab-icons/wishlist.png')} />
        <Label>Wishlist</Label>
      </Trigger>
      <Trigger name="you">
        {/*
          Your own face, once there is one to draw. `renderingMode="original"` is
          not optional: `tintColor` above configures an icon colour, which makes
          expo-router default images to `template` — and a templated photograph
          is a flat silhouette in the tint colour, not a portrait.

          `sf` and `src` are mutually exclusive here rather than a pair, because
          iOS resolves them in the order `sf` > `xcasset` > `src`; passing both
          would mean the symbol always won and the avatar never appeared. The
          glyph is the fallback for a guest, an account with no photo, and the
          frame or two before the raster lands.
        */}
        {/*
          ANDROID GETS THE GLYPH, NOT THE PHOTO — AND THIS IS NOT A GATE THAT
          CAN JUST BE DELETED. Re-checked 2026-08-09 against the installed
          source; pinned by `__tests__/routes/tabs-layout-you-avatar-test.tsx`.

          `renderingMode="original"` is a UIKit concept (UIImage.RenderingMode)
          with no Android counterpart, and Android's whole icon pipeline here is
          built on TINTING A WHITE MASK:
           1. every Android tab icon — ours AND expo-router's own `md` ones —
              becomes a bitmap. `md` is literally rendered as a WHITE Material
              symbol (`unstable_getMaterialSymbolSourceAsync(name, 24, 'white')`
              in expo-router's `materialIconConverter.android.js`) and coloured
              later by the tint;
           2. it reaches native as `imageIconResource`, which react-native-screens
              decodes into a plain `BitmapDrawable` (`TabsImageLoader.kt`) and
              assigns to `menuItem.icon`;
           3. `TabsHostAppearanceApplicator.updateSharedAppearance` ALWAYS sets
              `bottomNavigationView.itemIconTintList` — the props only choose the
              colour, never whether there is one;
           4. Material's `NavigationBarItemView.setIcon` wraps, mutates, and
              calls `Drawable.setTintList(iconTint)` (verified in the
              material-1.13.0 bytecode). That is SRC_IN: the tint replaces every
              colour and keeps only the alpha.
          So a photograph does not come out dark-ish — it comes out as a SOLID
          gray900 circle. `account_circle` carries strictly more information.

          Upgrading does not unlock it: react-native-screens 4.27.0, the latest,
          still assigns `itemIconTintList` unconditionally and exposes no
          per-icon `tinted` opt-out on Android (expo pins us to ~4.23.0 anyway).
          Enabling this needs a native change — an upstream/patched
          react-native-screens that wraps image icons in a Drawable which
          ignores tinting — which is a NEW ANDROID BINARY, not an OTA. It cannot
          be a blanket "never tint image icons" either, or the white `md` glyphs
          above go invisible on a light bar.
        */}
        {avatarIcon && Platform.OS === 'ios' ? (
          <Icon renderingMode="original" src={avatarIcon} />
        ) : (
          <Icon md="account_circle" sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        )}
        <Label>You</Label>
      </Trigger>
    </NativeTabs>
    </NativeTabScreenProvider>
  );
}
