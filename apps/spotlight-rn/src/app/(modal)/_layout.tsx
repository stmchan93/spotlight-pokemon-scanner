import { Stack } from 'expo-router';

export default function ModalLayout() {
  return (
    <Stack
      screenOptions={{
        animation: 'default',
        contentStyle: {
          backgroundColor: 'transparent',
        },
        headerShown: false,
      }}
    />
  );
}
