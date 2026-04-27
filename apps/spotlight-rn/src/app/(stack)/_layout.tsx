import { Stack } from 'expo-router';

export default function BrowseStackLayout() {
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
