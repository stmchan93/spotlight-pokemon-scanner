import { PropsWithChildren } from 'react';
import { Text, type StyleProp, type TextProps, type TextStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import type { SpotlightTheme } from '../tokens';

export type AppTextVariant = keyof SpotlightTheme['typography'];
export type AppTextColor = keyof SpotlightTheme['colors'];

type AppTextProps = PropsWithChildren<Omit<TextProps, 'style'>> & {
  color?: AppTextColor;
  style?: StyleProp<TextStyle>;
  variant?: AppTextVariant;
};

export function AppText({
  children,
  color,
  style,
  variant = 'body',
  ...textProps
}: AppTextProps) {
  const theme = useSpotlightTheme();

  return (
    <Text
      style={[
        theme.typography[variant],
        color ? { color: theme.colors[color] } : null,
        style,
      ]}
      {...textProps}
    >
      {children}
    </Text>
  );
}
