import * as Linking from 'expo-linking';
import { MapPin } from 'iconoir-react-native';
import { Platform, Pressable, StyleSheet, UIManager, View } from 'react-native';

import { AppText, colors, radii, spacing } from '@spotlight/design-system';

type MapsModule = typeof import('react-native-maps');

/** Figma map frame height. */
const MAP_HEIGHT = 268;
const PIN_SIZE = 24;
const REGION_DELTA = 0.05;

/*
  OTA SAFETY. Binaries built before react-native-maps was added have no native
  map, and JS reaches them over the air. Two guards, both required:
   1. the Fabric component `RNMapsMapView` (what MapView renders on iOS and
      Android under the New Architecture) must be registered — otherwise the
      host view would render as an unimplemented-component box;
   2. the module itself is required lazily inside try/catch, because importing
      it calls `TurboModuleRegistry.getEnforcing('RNMapsAirModule')`, which
      throws when the native module is missing.
*/
let cachedMaps: MapsModule | null | undefined;

function loadNativeMaps(): MapsModule | null {
  if (cachedMaps !== undefined) {
    return cachedMaps;
  }
  try {
    cachedMaps = UIManager.hasViewManagerConfig?.('RNMapsMapView')
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module: older binaries fall back to a static card
        (require('react-native-maps') as MapsModule)
      : null;
  } catch {
    cachedMaps = null;
  }
  return cachedMaps;
}

export function buildNativeMapsUrl(latitude: number, longitude: number, title: string): string {
  const coordinate = `${latitude},${longitude}`;
  const label = encodeURIComponent(title);
  return Platform.OS === 'ios'
    ? `http://maps.apple.com/?daddr=${coordinate}&q=${label}`
    : `geo:${coordinate}?q=${coordinate}(${label})`;
}

type EventMapProps = {
  latitude: number;
  longitude: number;
  title: string;
  address: string;
  testID?: string;
};

export function EventMap({ latitude, longitude, title, address, testID }: EventMapProps) {
  const openInMaps = () => {
    Linking.openURL(buildNativeMapsUrl(latitude, longitude, title)).catch(() => {});
  };

  const maps = loadNativeMaps();

  if (!maps) {
    return (
      <Pressable
        accessibilityHint="Opens directions in your maps app"
        accessibilityLabel={`${title}, ${address}`}
        accessibilityRole="button"
        onPress={openInMaps}
        style={({ pressed }) => [styles.frame, styles.fallback, pressed ? styles.pressed : null]}
        testID={testID ? `${testID}-fallback` : undefined}
      >
        <MapPin color={colors.gray600} height={PIN_SIZE} width={PIN_SIZE} />
        <AppText color="textSecondary" numberOfLines={2} style={styles.address} variant="body">
          {address}
        </AppText>
      </Pressable>
    );
  }

  const { default: MapView, Marker } = maps;

  return (
    <View style={styles.frame} testID={testID}>
      <MapView
        initialRegion={{
          latitude,
          longitude,
          latitudeDelta: REGION_DELTA,
          longitudeDelta: REGION_DELTA,
        }}
        pitchEnabled={false}
        rotateEnabled={false}
        scrollEnabled
        style={StyleSheet.absoluteFill}
        zoomEnabled
      >
        <Marker
          coordinate={{ latitude, longitude }}
          description={address}
          onCalloutPress={openInMaps}
          title={title}
        />
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    height: MAP_HEIGHT,
    borderRadius: radii.sm,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxs,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.gray100,
  },
  pressed: {
    opacity: 0.7,
  },
  address: {
    textAlign: 'center',
  },
});
