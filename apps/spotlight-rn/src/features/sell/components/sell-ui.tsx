import { Image, StyleSheet, View } from 'react-native';

import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

type SellBackdropProps = {
  imageUrl?: string | null;
  variant?: 'single' | 'bulk';
};

// SellBackdrop is the only surviving export from the retired sell flow. It is a
// purely decorative blurred-card backdrop still used by the card-detail screen.
// The heavy sell form, calculator, payment chips, and photo capture were removed
// when the standalone transaction logger replaced the inventory-coupled sell UI.
export function SellBackdrop({
  imageUrl,
  variant = 'single',
}: SellBackdropProps) {
  const accentOpacity = variant === 'bulk' ? 0.2 : 0.26;
  const imageOpacity = variant === 'bulk' ? 0.4 : 0.5;

  return (
    <View pointerEvents="none" style={styles.backdropWrap} testID="sell-backdrop">
      <View style={styles.backdropBase} />

      {imageUrl ? (
        <Image
          blurRadius={32}
          resizeMode="cover"
          source={{ uri: imageUrl }}
          style={[styles.backdropImage, { opacity: imageOpacity }]}
          testID="sell-backdrop-image"
        />
      ) : null}

      <View style={styles.materialWash} testID="sell-backdrop-material" />

      <Svg
        height="100%"
        preserveAspectRatio="none"
        style={StyleSheet.absoluteFill}
        viewBox="0 0 100 100"
        width="100%"
      >
        <Defs>
          <LinearGradient id="sell-backdrop-wash" x1="50" x2="50" y1="0" y2="100">
            <Stop offset="0%" stopColor="#FFF8F0" stopOpacity="0.18" />
            <Stop offset="28%" stopColor="#FFFDFB" stopOpacity="0.44" />
            <Stop offset="60%" stopColor="#FFF6EA" stopOpacity="0.68" />
            <Stop offset="100%" stopColor="#FFFFFF" stopOpacity="1" />
          </LinearGradient>
          <LinearGradient id="sell-backdrop-accent" x1="6" x2="94" y1="8" y2="92">
            <Stop offset="0%" stopColor="#F4C486" stopOpacity={accentOpacity} />
            <Stop offset="48%" stopColor="#FFFFFF" stopOpacity="0" />
            <Stop offset="100%" stopColor="#79D2C5" stopOpacity={accentOpacity} />
          </LinearGradient>
          <LinearGradient id="sell-backdrop-floor" x1="50" x2="50" y1="0" y2="100">
            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
            <Stop offset="56%" stopColor="#FFF8EF" stopOpacity="0.16" />
            <Stop offset="100%" stopColor="#F6E1B8" stopOpacity="0.34" />
          </LinearGradient>
        </Defs>
        <Rect fill="url(#sell-backdrop-wash)" height="100" width="100" x="0" y="0" />
        <Rect fill="url(#sell-backdrop-accent)" height="100" width="100" x="0" y="0" />
        <Path
          d="M0 66C18 59 33 56 50 56C67 56 82 60 100 68V100H0V66Z"
          fill="url(#sell-backdrop-floor)"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  backdropBase: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#FFFDF9',
  },
  backdropImage: {
    ...StyleSheet.absoluteFillObject,
    transform: [{ scale: 1.18 }],
  },
  backdropWrap: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  materialWash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 252, 248, 0.38)',
  },
});
