import { PropsWithChildren } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type SheetSurfaceTone = 'light' | 'dark';

type SheetSurfaceProps = PropsWithChildren<{
  padding?: number;
  showHandle?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * Surface treatment. `light` (default) is the white elevated sheet used by
   * portfolio/pricing sheets. `dark` is the near-black scanner sheet (gray-900
   * surface, white content) used over the camera viewport.
   */
  tone?: SheetSurfaceTone;
}>;

export function SheetSurface({
  children,
  padding = 20,
  showHandle = true,
  style,
  testID,
  tone = 'light',
}: SheetSurfaceProps) {
  const theme = useSpotlightTheme();

  const isDark = tone === 'dark';
  const surfaceColor = isDark ? theme.colors.gray900 : theme.colors.canvasElevated;
  const borderColor = isDark ? theme.colors.gray800 : theme.colors.outlineSubtle;
  const handleColor = isDark ? theme.colors.gray100 : theme.colors.outlineSubtle;

  return (
    <View
      style={[
        styles.surface,
        theme.shadows.card,
        {
          padding,
          backgroundColor: surfaceColor,
          borderColor,
          borderTopLeftRadius: 0,
          borderTopRightRadius: 0,
        },
        style,
      ]}
      testID={testID}
    >
      {showHandle ? (
        <View
          style={[
            styles.handle,
            {
              backgroundColor: handleColor,
              borderRadius: theme.radii.pill,
            },
          ]}
          testID={testID ? `${testID}-handle` : undefined}
        />
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  handle: {
    alignSelf: 'center',
    height: 4,
    marginBottom: 16,
    width: 48,
  },
  surface: {
    borderWidth: 1,
  },
});
