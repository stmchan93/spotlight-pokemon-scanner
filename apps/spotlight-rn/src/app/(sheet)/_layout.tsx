import { Stack } from 'expo-router';

export default function SheetLayout() {
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
