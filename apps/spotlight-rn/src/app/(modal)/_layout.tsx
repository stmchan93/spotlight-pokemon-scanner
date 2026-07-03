import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function ModalLayout() {
  return (
    <>
      {/* Re-assert dark (visible) status-bar icons: modal screens present over
          the root as their own iOS view controllers, so the root layout's
          StatusBar doesn't stick and the light-on-white icons vanish. */}
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          animation: 'default',
          contentStyle: {
            backgroundColor: 'transparent',
          },
          headerShown: false,
        }}
      />
    </>
  );
}
