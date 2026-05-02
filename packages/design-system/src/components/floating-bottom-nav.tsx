import type { ReactNode } from 'react';
import { BlurView, type BlurTint } from 'expo-blur';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';

import { useSpotlightTheme } from '../theme';
import type { SpotlightTheme } from '../tokens';

export type FloatingBottomNavItem = {
  key: string;
  label: string;
  icon: ReactNode;
  selected?: boolean;
  emphasized?: boolean;
  onPress: () => void;
  testID?: string;
};

type FloatingBottomNavProps = {
  items: readonly FloatingBottomNavItem[];
  bottomInset?: number;
  surface?: 'default' | 'scanner';
};

export function resolveFloatingBottomNavMetrics({
  bottomInset,
  surface,
  theme,
  windowWidth,
}: {
  windowWidth: number;
  theme: SpotlightTheme;
  bottomInset: number;
  surface: 'default' | 'scanner';
}) {
  const isScannerSurface = surface === 'scanner';
  const blurTint: BlurTint = 'light';

  return {
    blurTint,
    borderColor: isScannerSurface ? 'rgba(15, 15, 18, 0.08)' : 'rgba(255, 255, 255, 0.72)',
    bottom: theme.layout.bottomNavBottomInset + bottomInset,
    emphasizedFlex: 1,
    emphasizedPlateRestColor: isScannerSurface
      ? 'rgba(255, 255, 255, 0.56)'
      : 'rgba(15, 15, 18, 0.04)',
    emphasizedPlateSize: isScannerSurface ? 48 : 50,
    gap: isScannerSurface ? 14 : 18,
    horizontalPadding: isScannerSurface ? 16 : 18,
    innerPaddingBottom: isScannerSurface ? 3 : 2,
    innerPaddingTop: isScannerSurface ? 5 : 4,
    itemGap: isScannerSurface ? 2 : 3,
    itemShellBackgroundColor: isScannerSurface ? 'transparent' : 'rgba(255, 255, 255, 0.26)',
    itemShellSelectedBackgroundColor: isScannerSurface ? 'transparent' : 'rgba(255, 255, 255, 0.54)',
    itemShellSelectedBorderColor: isScannerSurface ? 'transparent' : 'rgba(255, 255, 255, 0.84)',
    itemShellRadius: isScannerSurface ? 16 : 19,
    itemShellMinHeight: isScannerSurface ? 0 : 58,
    labelColor: isScannerSurface ? 'rgba(15, 15, 18, 0.72)' : theme.colors.textPrimary,
    labelSecondaryColor: isScannerSurface ? 'rgba(15, 15, 18, 0.72)' : 'rgba(15, 15, 18, 0.78)',
    regularPlateSize: isScannerSurface ? 48 : 50,
    regularPlateSelectedColor: isScannerSurface
      ? theme.colors.brand
      : theme.colors.brand,
    shellBackgroundColor:
      Platform.OS === 'android'
        ? isScannerSurface
          ? 'rgba(250, 249, 244, 0.94)'
          : 'rgba(245, 242, 232, 0.92)'
        : isScannerSurface
          ? 'rgba(249, 248, 241, 0.78)'
          : 'rgba(246, 243, 233, 0.78)',
    shellWidth: Math.min(
      windowWidth - theme.layout.bottomNavSideInset * 2,
      isScannerSurface ? 292 : 302,
    ),
    shadowOpacity: isScannerSurface ? 0.12 : 0.08,
    shadowRadius: isScannerSurface ? 16 : 18,
  };
}

export function FloatingBottomNav({
  items,
  bottomInset = 0,
  surface = 'default',
}: FloatingBottomNavProps) {
  const theme = useSpotlightTheme();
  const { width: windowWidth } = useWindowDimensions();
  const metrics = resolveFloatingBottomNavMetrics({
    bottomInset,
    surface,
    theme,
    windowWidth,
  });
  const isScannerSurface = surface === 'scanner';
  const shellStyle: ViewStyle[] = [
    styles.shell,
    {
      alignSelf: 'center',
      backgroundColor: metrics.shellBackgroundColor,
      borderColor: metrics.borderColor,
      bottom: metrics.bottom,
      height: theme.layout.bottomNavHeight,
      shadowColor: theme.shadows.card.shadowColor,
      shadowOffset: theme.shadows.card.shadowOffset,
      shadowOpacity: metrics.shadowOpacity,
      shadowRadius: metrics.shadowRadius,
      width: metrics.shellWidth,
      elevation: surface === 'scanner' ? 5 : theme.shadows.card.elevation,
    },
  ];

  const content = (
    <View
      style={[
        styles.inner,
        {
          gap: metrics.gap,
          paddingHorizontal: metrics.horizontalPadding,
          paddingBottom: metrics.innerPaddingBottom,
          paddingTop: metrics.innerPaddingTop,
        },
      ]}
    >
      {items.map((item) => {
        const selected = item.selected === true;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={item.onPress}
            style={({ pressed }) => [
              styles.item,
              isScannerSurface && item.emphasized ? { flex: metrics.emphasizedFlex } : null,
              {
                gap: metrics.itemGap,
                opacity: pressed ? 0.82 : 1,
              },
            ]}
            testID={item.testID}
          >
            <View
              style={[
                isScannerSurface
                  ? null
                  : [
                      styles.defaultItemShell,
                      {
                        backgroundColor: selected
                          ? metrics.itemShellSelectedBackgroundColor
                          : metrics.itemShellBackgroundColor,
                        borderColor: selected
                          ? metrics.itemShellSelectedBorderColor
                          : 'transparent',
                        borderRadius: metrics.itemShellRadius,
                        minHeight: metrics.itemShellMinHeight,
                      },
                    ],
                isScannerSurface && item.emphasized ? styles.iconPlate : null,
                isScannerSurface && !item.emphasized
                  ? {
                      borderRadius: 16,
                      height: metrics.regularPlateSize,
                      width: metrics.regularPlateSize,
                    }
                  : null,
                isScannerSurface && !item.emphasized && selected
                  ? [
                      styles.selectedRegularIconSlot,
                      {
                        backgroundColor: metrics.regularPlateSelectedColor,
                        height: metrics.regularPlateSize,
                        width: metrics.regularPlateSize,
                      },
                    ]
                  : null,
                isScannerSurface && item.emphasized
                  ? [
                      styles.emphasizedPlate,
                      {
                        borderColor: 'rgba(15, 15, 18, 0.08)',
                        backgroundColor: selected
                          ? theme.colors.brand
                          : metrics.emphasizedPlateRestColor,
                        height: metrics.emphasizedPlateSize,
                        width: metrics.emphasizedPlateSize,
                      },
                    ]
                  : null,
              ]}
              testID={item.testID ? `${item.testID}-surface` : undefined}
            >
              <View style={isScannerSurface ? null : styles.defaultIconSlot}>
                {item.icon}
              </View>
              {!isScannerSurface ? (
                <Text
                  style={[
                    theme.typography.control,
                    styles.defaultLabel,
                    {
                      color: selected
                        ? metrics.labelColor
                        : metrics.labelSecondaryColor,
                    },
                  ]}
                >
                  {item.label}
                </Text>
              ) : null}
            </View>
            {isScannerSurface ? (
              <Text
                style={[
                  theme.typography.micro,
                  {
                    color: selected
                      ? theme.colors.textPrimary
                      : metrics.labelSecondaryColor,
                  },
                ]}
              >
                {item.label}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );

  if (Platform.OS === 'ios') {
    return (
      <BlurView
        intensity={45}
        style={shellStyle}
        tint={metrics.blurTint}
      >
        {content}
      </BlurView>
    );
  }

  return <View style={shellStyle}>{content}</View>;
}

const styles = StyleSheet.create({
  defaultIconSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 24,
  },
  defaultItemShell: {
    alignItems: 'center',
    borderWidth: 1,
    gap: 2,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    width: '100%',
  },
  defaultLabel: {
    letterSpacing: 0,
  },
  emphasizedPlate: {
    borderWidth: 1,
    height: 52,
    width: 52,
  },
  iconPlate: {
    alignItems: 'center',
    borderRadius: 16,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  inner: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
  },
  item: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  regularIconSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedRegularIconSlot: {
    borderRadius: 16,
  },
  shell: {
    borderRadius: 24,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'absolute',
  },
});
