import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

type SheetHeaderProps = {
  align?: 'leading' | 'center';
  leadingAccessory?: ReactNode;
  rightAccessory?: ReactNode;
  showHandle?: boolean;
  style?: StyleProp<ViewStyle>;
  subtitle?: string;
  title: string;
  titleStyleVariant?: 'title' | 'titleCompact';
};

export function SheetHeader({
  align = 'leading',
  leadingAccessory,
  rightAccessory,
  showHandle = false,
  style,
  subtitle,
  title,
  titleStyleVariant = 'titleCompact',
}: SheetHeaderProps) {
  const theme = useSpotlightTheme();
  const titleStyle = titleStyleVariant === 'title' ? theme.typography.title : theme.typography.titleCompact;

  return (
    <View style={[styles.header, style]}>
      {showHandle ? (
        <View
          style={[
            styles.handle,
            {
              backgroundColor: theme.colors.outlineSubtle,
            },
          ]}
        />
      ) : null}

      <View style={styles.row}>
        <View style={styles.accessorySlot}>
          {leadingAccessory}
        </View>

        <View style={[styles.copy, align === 'center' ? styles.copyCentered : null]}>
          <Text style={[titleStyle, align === 'center' ? styles.textCentered : null]}>{title}</Text>
          {subtitle ? (
            <Text
              style={[
                theme.typography.body,
                styles.subtitle,
                align === 'center' ? styles.textCentered : null,
                {
                  color: theme.colors.textSecondary,
                },
              ]}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={[styles.accessorySlot, styles.accessorySlotRight]}>
          {rightAccessory}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  accessorySlot: {
    justifyContent: 'center',
    minWidth: 40,
  },
  accessorySlotRight: {
    alignItems: 'flex-end',
  },
  copy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  copyCentered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  handle: {
    alignSelf: 'center',
    borderRadius: 999,
    height: 4,
    width: 48,
  },
  header: {
    gap: 14,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  subtitle: {
    maxWidth: '100%',
  },
  textCentered: {
    textAlign: 'center',
  },
});
