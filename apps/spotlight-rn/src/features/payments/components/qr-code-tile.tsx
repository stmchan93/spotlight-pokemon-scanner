import { StyleSheet, Text, View } from 'react-native';

import { SurfaceCard, useSpotlightTheme } from '@spotlight/design-system';

// Lazy-require so tests don't choke on the optional native module if absent.
function tryRequireQrCode(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-qrcode-svg').default ?? require('react-native-qrcode-svg');
  } catch {
    return null;
  }
}

const QRCodeComponent = tryRequireQrCode();

type QrCodeTileProps = {
  qrUrl: string;
  shortUrl?: string | null;
  size?: number;
  testID?: string;
};

export function QrCodeTile({
  qrUrl,
  shortUrl,
  size = 220,
  testID = 'qr-code-tile',
}: QrCodeTileProps) {
  const theme = useSpotlightTheme();
  const trimmedFallback = (shortUrl ?? qrUrl ?? '').trim();

  return (
    <SurfaceCard padding={20} radius={24} testID={testID} variant="elevated">
      <View style={styles.center}>
        <View
          accessibilityLabel="Payment QR code"
          style={[
            styles.qrCanvas,
            {
              backgroundColor: theme.colors.canvasElevated,
              borderColor: theme.colors.outlineSubtle,
            },
          ]}
          testID={`${testID}-canvas`}
        >
          {QRCodeComponent ? (
            <QRCodeComponent
              backgroundColor="transparent"
              color={theme.colors.textPrimary}
              size={size}
              value={qrUrl}
            />
          ) : (
            <Text
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
              testID={`${testID}-fallback`}
            >
              QR unavailable
            </Text>
          )}
        </View>
        {trimmedFallback ? (
          <Text
            numberOfLines={2}
            style={[
              theme.typography.caption,
              styles.shortUrl,
              { color: theme.colors.textSecondary },
            ]}
            testID={`${testID}-short-url`}
          >
            {trimmedFallback}
          </Text>
        ) : null}
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    gap: 12,
  },
  qrCanvas: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: 'center',
    padding: 16,
  },
  shortUrl: {
    textAlign: 'center',
  },
});
