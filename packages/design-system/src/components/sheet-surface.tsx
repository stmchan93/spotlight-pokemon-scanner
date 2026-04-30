import { PropsWithChildren } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

type SheetSurfaceProps = PropsWithChildren<{
  padding?: number;
  showHandle?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}>;

export function SheetSurface({
  children,
  padding = 20,
  showHandle = true,
  style,
  testID,
}: SheetSurfaceProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.surface,
        theme.shadows.card,
        {
          padding,
          backgroundColor: theme.colors.canvasElevated,
          borderColor: theme.colors.outlineSubtle,
          borderTopLeftRadius: theme.radii.xxl,
          borderTopRightRadius: theme.radii.xxl,
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
              backgroundColor: theme.colors.outlineSubtle,
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
