import { useEffect, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';

export type RollingNumberTextProps = {
  /** Pre-formatted string (e.g. "$17,400.47"). Digits roll; everything else is static. */
  value: string;
  style?: StyleProp<TextStyle>;
  /** Milliseconds per digit roll. Defaults to 320. */
  duration?: number;
  testID?: string;
};

const DEFAULT_DURATION_MS = 320;
const DIGIT_REGEX = /^\d$/;

/**
 * Slot-machine style number display. Each digit in `value` lives in its own
 * fixed-height column; when `value` changes, only the digits that differ
 * animate their column's translateY to the new digit position. Non-digit
 * characters (currency symbols, commas, decimals, signs) render as plain
 * Text and never animate.
 *
 * Uses the React Native built-in Animated API with `useNativeDriver: true`
 * — all animations run on the UI thread at 60fps via transform-only
 * interpolation.
 */
export function RollingNumberText({
  value,
  style,
  duration = DEFAULT_DURATION_MS,
  testID,
}: RollingNumberTextProps) {
  const flatStyle = StyleSheet.flatten(style ?? {}) as TextStyle;
  const fontSize = (flatStyle.fontSize as number | undefined) ?? 28;
  const lineHeight = (flatStyle.lineHeight as number | undefined) ?? fontSize * 1.2;
  // Tabular-style digit advance width. Plus Jakarta Sans Bold's widest digit
  // (`0`/`8`) renders at ~0.65 × fontSize at this weight; pinning every digit
  // Text to that width keeps the narrow `1` from leaving trailing whitespace
  // inside its column while still giving the wider digits room to breathe.
  const digitWidth = Math.round(fontSize * 0.65);

  const chars = value.split('');

  return (
    <View style={styles.row} testID={testID}>
      {chars.map((char, index) => {
        if (DIGIT_REGEX.test(char)) {
          return (
            <DigitRoll
              digit={Number.parseInt(char, 10)}
              digitWidth={digitWidth}
              duration={duration}
              key={`digit-${index}`}
              lineHeight={lineHeight}
              style={style}
            />
          );
        }
        return (
          // Digit columns are measured in JS from the unscaled fontSize, so the
          // glyphs must NOT scale with Dynamic Type or they'd clip/misalign.
          <Text allowFontScaling={false} key={`static-${index}`} style={style}>
            {char}
          </Text>
        );
      })}
    </View>
  );
}

type DigitRollProps = {
  digit: number;
  digitWidth: number;
  duration: number;
  lineHeight: number;
  style?: StyleProp<TextStyle>;
};

function DigitRoll({ digit, digitWidth, duration, lineHeight, style }: DigitRollProps) {
  const translateY = useRef(new Animated.Value(-digit * lineHeight)).current;
  const previousDigitRef = useRef<number>(digit);

  useEffect(() => {
    if (previousDigitRef.current === digit) {
      return;
    }
    previousDigitRef.current = digit;
    Animated.timing(translateY, {
      toValue: -digit * lineHeight,
      duration,
      useNativeDriver: true,
    }).start();
  }, [digit, duration, lineHeight, translateY]);

  return (
    <View style={[styles.column, { height: lineHeight, width: digitWidth }]}>
      <Animated.View style={{ transform: [{ translateY }] }}>
        {Array.from({ length: 10 }, (_, n) => (
          <Text
            allowFontScaling={false}
            key={n}
            style={[style, styles.digit, { height: lineHeight, width: digitWidth }]}
          >
            {n}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    overflow: 'hidden',
  },
  digit: {
    textAlign: 'center',
  },
  row: {
    alignItems: 'baseline',
    flexDirection: 'row',
  },
});
