import 'expo-dev-client';
// Docs pointer: the Dynamic Type cap is enforced by the capped `Text` primitive
// (see @/lib/text-scaling for why the old global Text.defaultProps approach is
// dead under React 19). Kept as a discoverable breadcrumb.
import '@/lib/text-scaling';

import {
  ThemeProvider as NavigationThemeProvider,
  type Theme,
} from '@react-navigation/native';
import { Stack } from 'expo-router';
import {
  useFonts,
} from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import {
  type ReactNode,
  useCallback,
  useEffect,
} from 'react';
import {
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import {
  Platform,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
} from 'react-native-safe-area-context';
import { enableFreeze } from 'react-native-screens';

import {
  SpotlightThemeProvider,
  fontFamilies,
} from '@spotlight/design-system';

import { StagingSmokeDiagnostics } from '@/components/staging-smoke-diagnostics';
import { AccessGate } from '@/features/auth/components/access-gate';
import { AuthGate } from '@/features/auth/components/auth-gate';
import { AppErrorBoundary } from '@/lib/observability/app-error-boundary';
import { PostHogAppProvider, identifyPostHogUser } from '@/lib/observability/posthog';
import { PostHogScreenTracker } from '@/lib/observability/posthog-screen-tracker';
import { AppProviders } from '@/providers/app-providers';
import { AppDrawer } from '@/components/app-drawer';
import { CircularTabAvatarProvider } from '@/components/circular-tab-avatar';
import { AppDrawerProvider } from '@/providers/app-drawer-provider';
import { PENDING_GUEST_USER_ID } from '@/features/auth/auth-models';
import {
  AuthProvider,
  resolveProviderRemountKey,
  resolveSessionOwnerKey,
  useAuth,
} from '@/providers/auth-provider';

void SplashScreen.preventAutoHideAsync();

// Cross-dissolve the native splash out instead of cutting it. Even when the JS
// first frame is already painted, a hard cut exposes any sub-frame mismatch
// between the native splash view and the RN root as a visible blink; a short
// fade makes the two overlap so there is nothing to catch. iOS-only (the option
// is a no-op elsewhere).
SplashScreen.setOptions({ duration: 220, fade: true });

// Freeze blurred stack screens (react-native-screens). The Scan tab deliberately
// PUSHES a fresh tabs instance so Back returns to the screen you scanned from —
// which stacks whole extra copies of the pager (Collection chart + dashboard
// model + scanner). Without freeze those buried copies keep re-rendering and
// re-fetching on every data change, and the JS thread backlog surfaces as an
// app-wide ~200-300ms input lag on swipes/drawer taps. Frozen screens thaw
// automatically when navigated back to.
enableFreeze(true);

const navigationTheme: Theme = {
  dark: false,
  colors: {
    primary: '#0F0F12',
    background: '#FFFFFF',
    card: '#FFFFFF',
    text: '#0F0F12',
    border: 'rgba(0, 0, 0, 0.08)',
    notification: '#D9AEFF',
  },
  fonts: {
    regular: {
      fontFamily: fontFamilies.bodyRegular,
      fontWeight: '400',
    },
    medium: {
      fontFamily: fontFamilies.bodyMedium,
      fontWeight: '500',
    },
    bold: {
      fontFamily: fontFamilies.bodyBold,
      fontWeight: '700',
    },
    heavy: {
      fontFamily: fontFamilies.display,
      fontWeight: '700',
    },
  },
};

function RootNavigator() {
  const [fontsLoaded] = useFonts({
    [fontFamilies.display]: require('../../assets/fonts/PlusJakartaSans-ExtraBold.ttf'),
    [fontFamilies.bodyRegular]: require('../../assets/fonts/PlusJakartaSans-Regular.ttf'),
    [fontFamilies.bodyMedium]: require('../../assets/fonts/PlusJakartaSans-Medium.ttf'),
    [fontFamilies.bodySemiBold]: require('../../assets/fonts/PlusJakartaSans-SemiBold.ttf'),
    [fontFamilies.bodyBold]: require('../../assets/fonts/PlusJakartaSans-Bold.ttf'),
  });
  const auth = useAuth();

  // Hold the NATIVE splash until the app can paint its real first frame:
  // fonts ready AND the persisted session restored (auth out of 'loading').
  // Hiding on fonts alone flashed AuthGate's near-empty loading screen for
  // ~0.5s (splash → white → app). Session restore always resolves (it falls
  // back to 'signedOut' on failure), but keep a safety timer so a pathological
  // hang can never trap the user on the splash forever.
  const isReady = fontsLoaded && auth.state !== 'loading';

  // Fail-safe ONLY: if readiness never resolves, lift the splash anyway after 8s
  // so a pathological hang can't trap the user on it. The happy path hides the
  // splash in onLayout below — not here — so the native splash lifts only AFTER
  // the first real JS frame has painted. Hiding in a useEffect fired ~1 frame
  // early, which showed as a single blink between the native splash and the app.
  useEffect(() => {
    if (isReady) {
      return;
    }
    const failSafe = setTimeout(() => {
      void SplashScreen.hideAsync();
    }, 8000);
    return () => clearTimeout(failSafe);
  }, [isReady]);

  // Lift the native splash once the first ready frame has been PRESENTED. Layout
  // is not paint: onLayout fires when the shadow tree has measured, one or two
  // frames before those pixels reach the screen, so hiding directly in onLayout
  // still exposed a blank frame. Two chained rAFs push the hide past the commit
  // that actually draws the content. Safe to call repeatedly — hideAsync is a
  // no-op once the splash is gone.
  const handleFirstFrameLayout = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void SplashScreen.hideAsync();
      });
    });
  }, []);

  if (!isReady) {
    return null;
  }

  return (
    <View onLayout={handleFirstFrameLayout} style={{ flex: 1 }}>
      <AuthenticatedRoot />
    </View>
  );
}

function AuthenticatedRoot() {
  const auth = useAuth();

  return (
    <AuthGate
      appleSignInAvailable={auth.appleSignInAvailable}
      authenticatedContent={(
        <AccessGate>
          <View style={{ flex: 1 }}>
            <StatusBar style={Platform.OS === 'android' ? 'dark' : 'dark'} />
            <PostHogScreenTracker />
            <Stack
              screenOptions={{
                animation: 'default',
                contentStyle: {
                  backgroundColor: 'transparent',
                },
                headerShown: false,
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="(stack)" />
              {/*
                Catalog search (and the expansion browser beside it) comes UP
                from the bottom as a full-screen surface rather than pushing in
                from the right: search is a place you drop into and dismiss, not
                a step deeper into the collection. The Home top bar's "Search
                Cards" pill is the main way in (Figma 3505:14526).

                The presentation goes on the GROUP, not on the search route:
                react-native-screens ignores `stackPresentation` on a stack's
                bottom-most screen, and `/catalog/search` is exactly that inside
                `(sheet)`'s own stack — the same trap documented on `new-post`
                below. Routes pushed from WITHIN the group (expansion detail)
                still push normally, because they are pushed on the inner stack.

                `fullScreenModal` and not `formSheet`: the screen already carries
                its own full safe-area chrome and a close button, and a card
                presentation would leave the collection showing behind a search
                that is meant to take over.
              */}
              <Stack.Screen name="(sheet)" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="(modal)" />
              {/*
                New Post lives at the ROOT, not in `(stack)`, and that placement
                is load-bearing. react-native-screens ignores `stackPresentation`
                on a stack's BOTTOM-MOST screen — there is nothing to present
                over — and pushing `/new-post` from the tabs mounted the `(stack)`
                navigator with new-post as its only route. The presentation was
                silently a no-op and the composer rendered as a plain full-screen
                push with its close button jammed under the status bar.

                Here it is pushed over `(tabs)`, which is the root stack's
                initial route, so the modal presentation actually applies.

                If you ever move this route back under a group, re-check that it
                is not that group's first screen or the presentation silently
                dies again.

                The composer is a FULL-PAGE modal with no dismiss gesture on
                either platform: it comes up from the bottom, and the only ways
                out are the X button or a completed post (Twitter's composer).
                A sheet gave the image and the body less room and put a
                drag-to-dismiss over the text field; there is no draft
                persistence behind this screen, so that gesture could only ever
                lose work.
              */}
              <Stack.Screen
                name="new-post"
                options={{
                  /*
                    `slide_from_bottom` is MANDATORY, and it is doing work on
                    exactly one platform.

                    iOS ignores it: `RNSScreen.mm`'s `setStackAnimation` only
                    touches `modalTransitionStyle` for fade/flip, so a
                    `fullScreenModal` keeps `UIModalPresentationFullScreen`'s
                    default `coverVertical` — which is already the slide-up we
                    want, for free.

                    Android is where it matters: `fullScreenModal` maps to a
                    plain MODAL fragment whose default transition is an
                    X-translate, so WITHOUT this the composer slides in from the
                    RIGHT like an ordinary push. It reads as "a page deeper"
                    rather than "a thing that came up over the app", and it does
                    not match iOS.
                  */
                  animation: 'slide_from_bottom',
                  // No dismiss gesture anywhere. Exit is the X button, Android's
                  // hardware back, or a completed post — all deliberate presses
                  // on a specific target rather than a stray swipe.
                  //
                  // There is no discard confirmation behind them any more: it
                  // was removed once the gesture it protected against no longer
                  // existed. Closing DOES lose what was typed (there is no draft
                  // persistence), which is now stated behaviour rather than
                  // something a dialog apologised for.
                  gestureEnabled: false,
                  presentation: 'fullScreenModal',
                }}
              />
            </Stack>
          </View>
        </AccessGate>
      )}
      configurationIssue={auth.configurationIssue}
      currentUser={auth.currentUser}
      emailAuth={auth}
      errorMessage={auth.errorMessage}
      isBusy={auth.isBusy}
      isConfigured={auth.isConfigured}
      onAppleSignIn={() => {
        void auth.signInWithApple();
      }}
      onChangeProfileDraftName={auth.setProfileDraftName}
      onGoogleSignIn={() => {
        void auth.signInWithGoogle();
      }}
      onSubmitProfile={() => {
        void auth.submitProfile();
      }}
      profileDraftName={auth.profileDraftName}
      state={auth.state}
    />
  );
}

function ObservabilityAuthSync() {
  const auth = useAuth();
  const currentUser = auth.currentUser;

  useEffect(() => {
    // A PENDING guest has no Supabase user yet — its id is a shared placeholder,
    // so identifying it would merge every device's pending guest into one
    // PostHog person and wreck the counts. Stay on the anonymous distinct_id and
    // identify when a real uuid exists (the mint re-runs this effect). Not a
    // reset either: `identifyPostHogUser(null)` would drop the anonymous id.
    if (currentUser?.id === PENDING_GUEST_USER_ID) {
      return;
    }
    identifyPostHogUser(currentUser);
  }, [currentUser]);

  return null;
}

function AuthenticatedAppProviders({
  children,
}: {
  children: ReactNode;
}) {
  const auth = useAuth();
  // Owner key = the exact Supabase uuid whenever there is one. It scopes every
  // persisted/in-memory cache below, and is what keeps two accounts' data apart.
  const sessionOwnerKey = resolveSessionOwnerKey(auth.currentSession?.user.id, auth.isGuest);
  // Remount key: coarser on purpose, so the guest mint that happens mid-scan
  // doesn't tear the tree down and discard the capture. See
  // resolveProviderRemountKey for why this can't leak data across accounts.
  const providerRemountKey = resolveProviderRemountKey(sessionOwnerKey, auth.isGuest);
  return (
    <AppProviders
      key={providerRemountKey}
      accessToken={auth.accessToken}
      getAccessToken={auth.getAccessToken}
      sessionOwnerKey={sessionOwnerKey}
    >
      {children}
    </AppProviders>
  );
}

function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SpotlightThemeProvider>
          <NavigationThemeProvider value={navigationTheme}>
            <AuthProvider>
              <PostHogAppProvider>
                <ObservabilityAuthSync />
                <AppErrorBoundary>
                  <AuthenticatedAppProviders>
                    <AppDrawerProvider>
                      {/*
                        Wraps the navigator because the You TAB reads the icon it
                        publishes, and mounts the off-screen SVG it rasterises
                        from HERE because `<NativeTabs>` drops any child that is
                        not a Trigger or a BottomAccessory — see the file.
                      */}
                      <CircularTabAvatarProvider>
                        <View style={{ flex: 1, backgroundColor: navigationTheme.colors.background }}>
                          <RootNavigator />
                          <StagingSmokeDiagnostics />
                          <AppDrawer />
                        </View>
                      </CircularTabAvatarProvider>
                    </AppDrawerProvider>
                  </AuthenticatedAppProviders>
                </AppErrorBoundary>
              </PostHogAppProvider>
            </AuthProvider>
          </NavigationThemeProvider>
        </SpotlightThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default RootLayout;
