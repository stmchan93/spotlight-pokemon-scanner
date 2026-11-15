import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';

export type RollingNumberProps = {
  /** Pre-formatted string, e.g. "$3,410.00". Digits roll; every other char is static. */
  value: string;
  /** Default true. false = snap instantly (used while the user scrubs a chart). */
  animate?: boolean;
  /** Typography; fontSize/lineHeight drive the digit cell height. */
  style?: StyleProp<TextStyle>;
  testID?: string;
  /** Defaults to `value`. */
  accessibilityLabel?: string;
};

const ROLL_DURATION_MS = 450;
// Ease-out with a slight overshoot, after Robinhood's `ticker`.
const ROLL_EASING = Easing.out(Easing.back(1));
const FALLBACK_FONT_SIZE = 14;
const DIGIT_REGEX = /^\d$/;
// 9 above the 0 and 0 below the 9, so the overshoot never reveals an empty cell.
const STRIP_GLYPHS = ['9', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function stripOffset(digit: number, lineHeight: number) {
  return -(digit + 1) * lineHeight;
}

function useSystemReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (alive) {
          setReduceMotion(enabled);
        }
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (alive) {
        setReduceMotion(enabled);
      }
    });
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, []);
  return reduceMotion;
}

/**
 * Robinhood-style rolling number. Each digit is a clipped vertical strip that
 * translates to its new digit when `value` changes; other characters are static.
 * Renders as a single accessible text element labelled with the value.
 */
export function RollingNumber({
  value,
  animate = true,
  style,
  testID,
  accessibilityLabel,
}: RollingNumberProps) {
  const reduceMotion = useSystemReduceMotion();
  const shouldAnimate = animate && !reduceMotion;

  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const fontSize = typeof flat.fontSize === 'number' ? flat.fontSize : FALLBACK_FONT_SIZE;
  const lineHeight =
    typeof flat.lineHeight === 'number' ? flat.lineHeight : Math.round(fontSize * 1.3);
  const textStyle: StyleProp<TextStyle> = [style, styles.tabular, { lineHeight }];

  const chars = value.split('');
  // Keys count from the RIGHT (digits by digit index, so inserted commas don't
  // shift identity): "$999.00" -> "$1,240.00" keeps the cents and units columns.
  let digitsFromRight = 0;
  const keys = new Array<string>(chars.length);
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    keys[i] = DIGIT_REGEX.test(chars[i])
      ? `d${digitsFromRight++}`
      : `s${chars.length - 1 - i}-${chars[i]}`;
  }

  return (
    <View
      accessibilityLabel={accessibilityLabel ?? value}
      accessibilityRole="text"
      accessible
      style={styles.row}
      testID={testID}
    >
      {chars.map((char, index) => {
        const key = keys[index];
        if (DIGIT_REGEX.test(char)) {
          return (
            <DigitCell
              animate={shouldAnimate}
              digit={Number(char)}
              key={key}
              lineHeight={lineHeight}
              testID={testID ? `${testID}-${key}` : undefined}
              textStyle={textStyle}
            />
          );
        }
        return (
          <Text
            accessibilityElementsHidden
            allowFontScaling={false}
            importantForAccessibility="no-hide-descendants"
            key={key}
            style={textStyle}
          >
            {char}
          </Text>
        );
      })}
    </View>
  );
}

type DigitCellProps = {
  animate: boolean;
  digit: number;
  lineHeight: number;
  testID?: string;
  textStyle: StyleProp<TextStyle>;
};

function DigitCell({ animate, digit, lineHeight, testID, textStyle }: DigitCellProps) {
  const translateY = useRef(new Animated.Value(stripOffset(digit, lineHeight))).current;
  const shown = useRef({ digit, lineHeight });

  useEffect(() => {
    const previous = shown.current;
    if (previous.digit === digit && previous.lineHeight === lineHeight) {
      return undefined;
    }
    shown.current = { digit, lineHeight };
    const target = stripOffset(digit, lineHeight);
    if (!animate || previous.lineHeight !== lineHeight) {
      translateY.stopAnimation();
      translateY.setValue(target);
      return undefined;
    }
    // Starts from the current position, so an interrupted roll continues smoothly.
    const roll = Animated.timing(translateY, {
      toValue: target,
      duration: ROLL_DURATION_MS,
      easing: ROLL_EASING,
      useNativeDriver: true,
    });
    roll.start();
    return () => roll.stop();
  }, [animate, digit, lineHeight, translateY]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.cell, { height: lineHeight }]}
    >
      {/* Invisible "0" gives the cell its tabular width. */}
      <Text allowFontScaling={false} style={[textStyle, styles.sizer]}>
        0
      </Text>
      <Animated.View style={[styles.strip, { transform: [{ translateY }] }]} testID={testID}>
        {STRIP_GLYPHS.map((glyph, index) => (
          <Text
            allowFontScaling={false}
            key={index}
            style={[textStyle, styles.glyph, { height: lineHeight }]}
          >
            {glyph}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  cell: {
    overflow: 'hidden',
  },
  glyph: {
    textAlign: 'center',
  },
  row: {
    alignItems: 'flex-start',
    alignSelf: 'flex-start',
    flexDirection: 'row',
  },
  sizer: {
    opacity: 0,
  },
  strip: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
});
