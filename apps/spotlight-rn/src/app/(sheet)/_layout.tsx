import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

export default function SheetLayout() {
  return (
    <>
      {/* Re-assert dark (visible) status-bar icons: these screens present over
          the root as their own iOS view controllers, so the root layout's
          StatusBar doesn't stick and the light-on-white icons vanish. */}
      <StatusBar style="dark" />
      {/*
        ITS OWN PROVIDER, because this group presents as a `fullScreenModal`
        (see the root layout). A modal is a separate UIViewController shown over
        the root one, and `react-native-safe-area-context` measures insets
        against the nearest provider's VIEW — without one here that is the root
        view the modal covers, so every screen inside measured insets of ZERO
        and drew its chrome under the status bar. That is why Search Cards put
        its back button on top of the clock despite asking for `edges: ['top']`.

        `initialMetrics` is not an optimisation: a provider renders NOTHING
        until it has measured, so seeding it is what stops this group flashing
        one blank frame on every open.
      */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <Stack
        screenOptions={{
          animation: 'default',
          contentStyle: {
            backgroundColor: 'transparent',
          },
          headerShown: false,
        }}
      />
      </SafeAreaProvider>
    </>
  );
}
