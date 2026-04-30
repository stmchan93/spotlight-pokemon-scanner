import 'expo-dev-client';

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

import {
  SpotlightThemeProvider,
  fontFamilies,
} from '@spotlight/design-system';

import { AuthGate } from '@/features/auth/components/auth-gate';
import { PostHogAppProvider, identifyPostHogUser } from '@/lib/observability/posthog';
import { PostHogScreenTracker } from '@/lib/observability/posthog-screen-tracker';
import { AppProviders } from '@/providers/app-providers';
import { AuthProvider, useAuth } from '@/providers/auth-provider';

void SplashScreen.preventAutoHideAsync();

const navigationTheme: Theme = {
  dark: false,
  colors: {
    primary: '#0F0F12',
    background: '#FCFCFA',
    card: '#FFFFFF',
    text: '#0F0F12',
    border: 'rgba(0, 0, 0, 0.08)',
    notification: '#FEE333',
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
    [fontFamilies.display]: require('../../assets/fonts/SpecialGothicExpandedOne-Regular.ttf'),
    [fontFamilies.bodyRegular]: require('../../assets/fonts/Outfit-Regular.ttf'),
    [fontFamilies.bodyMedium]: require('../../assets/fonts/Outfit-Medium.ttf'),
    [fontFamilies.bodySemiBold]: require('../../assets/fonts/Outfit-SemiBold.ttf'),
    [fontFamilies.bodyBold]: require('../../assets/fonts/Outfit-Bold.ttf'),
  });

  useEffect(() => {
    if (fontsLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return <AuthenticatedRoot />;
}

function AuthenticatedRoot() {
  const auth = useAuth();

  return (
    <AuthGate
      appleSignInAvailable={auth.appleSignInAvailable}
      authenticatedContent={(
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
            <Stack.Screen name="(sheet)" />
            <Stack.Screen name="(modal)" />
          </Stack>
        </View>
      )}
      configurationIssue={auth.configurationIssue}
      currentUser={auth.currentUser}
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

  useEffect(() => {
    identifyPostHogUser(auth.currentUser);
  }, [auth.currentUser]);

  return null;
}

function AuthenticatedAppProviders({
  children,
}: {
  children: ReactNode;
}) {
  const auth = useAuth();
  const sessionOwnerKey = auth.currentSession?.user.id ?? 'signed-out';
  return (
    <AppProviders key={sessionOwnerKey} accessToken={auth.accessToken} sessionOwnerKey={sessionOwnerKey}>
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
                <AuthenticatedAppProviders>
                  <View style={{ flex: 1, backgroundColor: navigationTheme.colors.background }}>
                    <RootNavigator />
                  </View>
                </AuthenticatedAppProviders>
              </PostHogAppProvider>
            </AuthProvider>
          </NavigationThemeProvider>
        </SpotlightThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default RootLayout;
