import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Dev-only screen host: `spotlight://dev/<screen>` renders a registered screen
 * with deterministic mock data for /sync-design screenshots. See
 * `src/dev/dev-screen-host.tsx` for the registry and design-map.json for the
 * screen ↔ Figma mapping. No-op redirect in release builds; the lazy require
 * keeps the dev host + mocks out of the release bundle entirely.
 */
export default function DevScreenRoute() {
  const { screen } = useLocalSearchParams<{ screen: string }>();
  // The require must sit INSIDE `if (__DEV__)`: Metro folds that branch away in
  // release builds, but not code after an early `return`, which bundled the dev
  // host and its scanner PNGs into every OTA.
  if (__DEV__) {
    const { DevScreenHost } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: static import would pull the dev host + mocks into release bundles
      require('@/dev/dev-screen-host') as typeof import('@/dev/dev-screen-host');
    return <DevScreenHost screen={typeof screen === 'string' ? screen : ''} />;
  }
  return <Redirect href="/" />;
}
