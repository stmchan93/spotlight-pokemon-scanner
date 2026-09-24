import { Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type CalendarEventTone = 'release' | 'ban_list' | 'reveal' | 'event';

export type CalendarEventRowProps = {
  /** "SEP". */
  monthLabel: string;
  /** "26". */
  dayLabel: string;
  title: string;
  /** Kind chip label, e.g. "Release". */
  kindLabel: string;
  /** Kind chip tint: release green, ban list red, reveal purple, event gray. */
  kindTone: CalendarEventTone;
  /** One line under the title (`full` only). */
  subtitle?: string | null;
  /**
   * `compact` (feed block): 44pt date tile, title, chip on the right.
   * `full` (Coming up page): 50pt tile, chip over title over subtitle.
   */
  variant?: 'compact' | 'full';
  /** 0.5pt gray300 rule UNDER the row. */
  divider?: boolean;
  onPress?: () => void;
  testID?: string;
};

/**
 * One upcoming date (meta feed v2 "Coming up" mockups): a gray date tile, the
 * event title and a tinted kind chip. Strings arrive preformatted.
 */
export function CalendarEventRow({
  monthLabel,
  dayLabel,
  title,
  kindLabel,
  kindTone,
  subtitle = null,
  variant = 'compact',
  divider = false,
  onPress,
  testID,
}: CalendarEventRowProps) {
  const theme = useSpotlightTheme();
  const full = variant === 'full';
  const chipFill = {
    ban_list: theme.colors.deltaDownSurface,
    event: theme.colors.gray100,
    release: theme.colors.deltaUpSurface,
    reveal: theme.colors.purple50,
  }[kindTone];

  const chip = (
    <View
      style={[
        styles.chip,
        { backgroundColor: chipFill, borderCurve: 'continuous', borderRadius: theme.radii.pill },
      ]}
      testID={testID ? `${testID}-kind` : undefined}
    >
      <AppText color="gray900" numberOfLines={1} variant="feedTag">
        {kindLabel}
      </AppText>
    </View>
  );

  return (
    <Pressable
      accessibilityLabel={[`${monthLabel} ${dayLabel}`, kindLabel, title, full ? subtitle : null].filter(Boolean).join(', ')}
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        full ? styles.rowFull : styles.rowCompact,
        divider ? { borderBottomColor: theme.colors.gray300, borderBottomWidth: theme.borderWidths.rule } : null,
        { opacity: pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      <View
        style={[
          full ? styles.tileFull : styles.tileCompact,
          {
            backgroundColor: theme.colors.gray50,
            borderCurve: 'continuous',
            borderRadius: full ? theme.radii.md : theme.radii.sm,
          },
        ]}
        testID={testID ? `${testID}-date` : undefined}
      >
        <AppText color="gray600" style={styles.center} variant="feedTag">
          {monthLabel}
        </AppText>
        <AppText color="gray900" style={styles.center} variant={full ? 'titleLarge' : 'feedDelta'}>
          {dayLabel}
        </AppText>
      </View>
      {full ? (
        <View style={styles.copy}>
          {chip}
          <AppText color="gray900" style={styles.fullTitle} variant="feedRowTitle">
            {title}
          </AppText>
          {subtitle ? (
            <AppText color="gray600" variant="captionMedium">
              {subtitle}
            </AppText>
          ) : null}
        </View>
      ) : (
        <>
          <AppText color="gray900" numberOfLines={2} style={styles.copy} variant="feedRowTitle">
            {title}
          </AppText>
          {chip}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rowCompact: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
  },
  rowFull: {
    flexDirection: 'row',
    gap: 14,
    paddingVertical: 14,
  },
  tileCompact: {
    flexShrink: 0,
    paddingVertical: 4,
    width: 44,
  },
  tileFull: {
    flexShrink: 0,
    paddingVertical: 6,
    width: 50,
  },
  center: {
    textAlign: 'center',
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  chip: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexShrink: 0,
    height: 22,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  fullTitle: {
    marginTop: 6,
  },
});
