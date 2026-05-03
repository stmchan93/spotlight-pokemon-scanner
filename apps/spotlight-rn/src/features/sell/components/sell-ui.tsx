import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
  type GestureResponderHandlers,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  IconCalculator,
  IconPencil,
} from '@tabler/icons-react-native';

import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { Button, useSpotlightTheme } from '@spotlight/design-system';

import {
  buildSellMetadataTokens,
  evaluateSellCalculatorExpression,
  formatEditableSellPrice,
  getSellSwipeConfirmThreshold,
  sanitizeSellPriceText,
  type SellMetadataToken,
} from '@/features/sell/sell-order-helpers';

export const sellPricePlaceholderText = '$0.00';
export const sellPricePlaceholderColor = 'rgba(15, 15, 18, 0.18)';

type SellBackdropProps = {
  imageUrl?: string | null;
  variant?: 'single' | 'bulk';
};

type BoughtPriceVisibilityToggleProps = {
  disabled?: boolean;
  onPress: () => void;
  revealsValue: boolean;
  testID: string;
};

type SellTransactionPhotoCaptureProps = {
  compact?: boolean;
  testIDPrefix: string;
};

type SellDetailRowProps = {
  children: ReactNode;
  label: string;
};

type SellPriceFieldProps = {
  invalid?: boolean;
  onBlur?: () => void;
  onChangeText: (value: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  testID?: string;
  value: string;
};

type SellStepperButtonProps = {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
};

type SellFormFieldsProps = {
  boughtPriceActionLabel?: string;
  boughtPriceInputRef?: React.Ref<TextInput>;
  boughtPriceLabel: string;
  boughtPriceEditorErrorMessage?: string | null;
  boughtPriceEditorText?: string;
  boughtPriceEditorVisible?: boolean;
  boughtPriceInputTestID?: string;
  boughtPriceSaveDisabled?: boolean;
  boughtPriceToggleDisabled?: boolean;
  decrementDisabled?: boolean;
  incrementDisabled?: boolean;
  marketPriceLabel: string;
  onBlur?: () => void;
  onBoughtPriceChangeText?: (value: string) => void;
  onBoughtPriceInputFocus?: () => void;
  onCancelBoughtPriceEdit?: () => void;
  onDecrement: () => void;
  onEditBoughtPrice?: () => void;
  onFocus?: () => void;
  onIncrement: () => void;
  onSaveBoughtPrice?: () => void;
  onSoldPriceChangeText: (value: string) => void;
  onSoldPriceFocus?: () => void;
  onToggleBoughtPrice: () => void;
  quantity: number;
  revealsBoughtPrice: boolean;
  soldPriceErrorMessage?: string | null;
  soldPriceErrorTestID?: string;
  soldPriceTestID: string;
  soldPriceText: string;
  stepperTestIDs: {
    decrement: string;
    increment: string;
  };
  testIDPrefix: string;
  toggleBoughtPriceTestID: string;
};

type SellStatusOverlayProps = {
  detail: string;
  headline: string;
  state: 'processing' | 'success';
  testIDPrefix: string;
  title: string;
};

type SellIdentityChipsProps = {
  entry: InventoryCardEntry;
  testIDPrefix: string;
};

type AnimatedNumericValue = Animated.Value | Animated.AnimatedInterpolation<number>;

type SellSwipeConfirmationSheetProps = {
  bottomInset: number;
  disabled: boolean;
  onAccessibilityConfirm: () => void;
  panHandlers?: GestureResponderHandlers;
  prompt: string;
  promptOpacity: AnimatedNumericValue;
  promptScale: AnimatedNumericValue;
  swipeSheetHeight: number;
  testIDPrefix: string;
  translateY: AnimatedNumericValue;
  usesDisabledVisual?: boolean;
};


function CameraIcon() {
  return (
    <Svg fill="none" height={24} viewBox="0 0 24 24" width={24}>
      <Path
        d="M8.5 6.5L9.45 5.1C9.71 4.73 10.13 4.5 10.58 4.5H13.42C13.87 4.5 14.29 4.73 14.55 5.1L15.5 6.5H17.5C18.88 6.5 20 7.62 20 9V16C20 17.38 18.88 18.5 17.5 18.5H6.5C5.12 18.5 4 17.38 4 16V9C4 7.62 5.12 6.5 6.5 6.5H8.5Z"
        stroke="rgba(15, 15, 18, 0.52)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.9}
      />
      <Path
        d="M12 15.35C13.85 15.35 15.35 13.85 15.35 12C15.35 10.15 13.85 8.65 12 8.65C10.15 8.65 8.65 10.15 8.65 12C8.65 13.85 10.15 15.35 12 15.35Z"
        stroke="rgba(15, 15, 18, 0.52)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.9}
      />
    </Svg>
  );
}

function SellMetadataChip({
  token,
  testID,
}: {
  token: SellMetadataToken;
  testID: string;
}) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.metadataChip,
        {
          backgroundColor: 'rgba(255, 255, 255, 0.78)',
          borderColor: theme.colors.outlineSubtle,
        },
      ]}
      testID={testID}
    >
      <Text numberOfLines={1} style={[theme.typography.control, styles.metadataChipValue]}>
        {token.value}
      </Text>
    </View>
  );
}

export async function triggerSellHaptic(kind: 'armed' | 'success') {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  try {
    const Haptics = await import('expo-haptics');
    if (kind === 'armed') {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return;
    }

    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    if (Platform.OS !== 'web') {
      Vibration.vibrate(kind === 'armed' ? 10 : 18);
    }
  }
}

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

export function SellStatusOverlay({
  detail,
  headline,
  state,
  testIDPrefix,
  title,
}: SellStatusOverlayProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[styles.statusOverlay, { backgroundColor: theme.colors.brand }]}
      testID={`${testIDPrefix}-status-screen`}
    >
      <View style={styles.statusOverlayBody}>
        <View style={styles.statusOverlayIconWrap}>
          {state === 'success' ? (
            <Text style={styles.statusOverlayCheckmark}>✓</Text>
          ) : (
            <ActivityIndicator color="rgba(0, 0, 0, 0.78)" size="large" />
          )}
        </View>
        <Text style={[theme.typography.caption, styles.statusOverlayTitle]}>{title}</Text>
        <Text style={[theme.typography.bodyStrong, styles.statusOverlayHeadline]}>{headline}</Text>
        <Text style={[theme.typography.body, styles.statusOverlayDetail]}>{detail}</Text>
      </View>
    </View>
  );
}

export function SellSwipeConfirmationSheet({
  bottomInset,
  disabled,
  onAccessibilityConfirm,
  panHandlers,
  prompt,
  promptOpacity,
  promptScale,
  swipeSheetHeight,
  testIDPrefix,
  translateY,
  usesDisabledVisual = false,
}: SellSwipeConfirmationSheetProps) {
  const theme = useSpotlightTheme();

  return (
    <View pointerEvents="box-none" style={styles.swipeSheetWrap}>
      <Animated.View
        accessibilityActions={[{ name: 'activate', label: 'Confirm sale' }]}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'activate') {
            onAccessibilityConfirm();
          }
        }}
        style={[
          styles.swipeSheet,
          {
            backgroundColor: usesDisabledVisual ? theme.colors.field : theme.colors.brand,
            height: swipeSheetHeight,
            paddingBottom: bottomInset + 16,
            transform: [{ translateY }],
          },
        ]}
        testID={`${testIDPrefix}-swipe-rail`}
      >
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.confirmationPrompt,
            {
              opacity: promptOpacity,
              transform: [{ scale: promptScale }],
            },
          ]}
          testID={`${testIDPrefix}-confirmation-prompt`}
        >
          <View
            {...panHandlers}
            style={styles.swipeGestureZone}
            testID={`${testIDPrefix}-swipe-handle`}
          >
            <Text style={[styles.swipeChevron, usesDisabledVisual ? styles.swipeChevronDisabled : null]}>⌃</Text>
          </View>
          <Text
            style={[
              theme.typography.body,
              styles.swipeRailTitle,
              usesDisabledVisual ? styles.swipeRailTitleDisabled : null,
            ]}
          >
            {prompt}
          </Text>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

export function SellStepperButton({
  disabled,
  label,
  onPress,
  testID,
}: SellStepperButtonProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.formStepperButton,
        {
          backgroundColor: '#FFFFFF',
          borderColor: 'rgba(0, 0, 0, 0.08)',
          opacity: disabled ? 0.36 : pressed ? 0.88 : 1,
        },
      ]}
      testID={testID}
    >
      <Text style={[theme.typography.headline, styles.formStepperButtonText]}>{label}</Text>
    </Pressable>
  );
}

export const SellPriceField = forwardRef<TextInput, SellPriceFieldProps>(function SellPriceField({
  invalid = false,
  onBlur,
  onChangeText,
  onFocus,
  placeholder = sellPricePlaceholderText,
  testID,
  value,
}, ref) {
  const theme = useSpotlightTheme();

  return (
    <TextInput
      ref={ref}
      keyboardType="decimal-pad"
      onBlur={onBlur}
      onChangeText={(nextValue) => onChangeText(sanitizeSellPriceText(nextValue))}
      onFocus={onFocus}
      placeholder={placeholder}
      placeholderTextColor={sellPricePlaceholderColor}
      style={[
        theme.typography.headline,
        styles.formPriceField,
        {
          borderColor: invalid ? theme.colors.danger : 'rgba(0, 0, 0, 0.08)',
          color: theme.colors.textPrimary,
        },
      ]}
      testID={testID}
      value={value}
    />
  );
});

export function SellDetailRow({
  children,
  label,
}: SellDetailRowProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.formDetailRow}>
      <Text style={[theme.typography.headline, styles.formDetailLabel]}>{label}</Text>
      <View style={styles.formDetailTrailing}>{children}</View>
    </View>
  );
}

type CalculatorKeyVariant = 'number' | 'operator' | 'utility';

type CalculatorKeySpec = {
  label: string;
  span?: 1 | 2;
  variant: CalculatorKeyVariant;
};

const calculatorRows: readonly CalculatorKeySpec[][] = [
  [
    { label: 'C', variant: 'utility' },
    { label: '(', variant: 'utility' },
    { label: ')', variant: 'utility' },
    { label: '÷', variant: 'operator' },
  ],
  [
    { label: '7', variant: 'number' },
    { label: '8', variant: 'number' },
    { label: '9', variant: 'number' },
    { label: '×', variant: 'operator' },
  ],
  [
    { label: '4', variant: 'number' },
    { label: '5', variant: 'number' },
    { label: '6', variant: 'number' },
    { label: '−', variant: 'operator' },
  ],
  [
    { label: '1', variant: 'number' },
    { label: '2', variant: 'number' },
    { label: '3', variant: 'number' },
    { label: '+', variant: 'operator' },
  ],
  [
    { label: '0', span: 2, variant: 'number' },
    { label: '.', variant: 'number' },
    { label: '=', variant: 'operator' },
  ],
] as const;

function normalizeCalculatorExpression(expression: string) {
  return expression
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-');
}

function appendCalculatorSymbol(expression: string, symbol: string) {
  const current = expression;
  if (symbol === '.') {
    const segment = current.split(/[+\-*/()]/).at(-1) ?? '';
    if (segment.includes('.')) {
      return current;
    }
  }

  if ((symbol === '×' || symbol === '÷' || symbol === '+' || symbol === '−') && current.length === 0) {
    return symbol === '−' ? symbol : current;
  }

  return `${current}${symbol}`;
}

function calculatorKeyTestID(testIDPrefix: string, key: CalculatorKeySpec) {
  if (key.label === 'C') {
    return `${testIDPrefix}-calculator-clear`;
  }

  if (key.label === '=') {
    return `${testIDPrefix}-calculator-equals`;
  }

  return `${testIDPrefix}-calculator-key-${key.label}`;
}

function SellInlineCalculator({
  expression,
  errorMessage,
  onAppend,
  onClear,
  onDismiss,
  onEvaluate,
  resultText,
  testIDPrefix,
}: {
  errorMessage: string | null;
  expression: string;
  onAppend: (value: string) => void;
  onClear: () => void;
  onDismiss: () => void;
  onEvaluate: () => void;
  resultText: string | null;
  testIDPrefix: string;
}) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const sheetTranslateY = useRef(new Animated.Value(0)).current;

  const resetSheetPosition = useCallback(() => {
    Animated.spring(sheetTranslateY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 170,
      friction: 22,
    }).start();
  }, [sheetTranslateY]);

  const dragDismissResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => (
      gestureState.dy > 6 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx)
    ),
    onPanResponderMove: (_, gestureState) => {
      sheetTranslateY.setValue(Math.max(0, gestureState.dy));
    },
    onPanResponderRelease: (_, gestureState) => {
      if (gestureState.dy >= 72 || gestureState.vy >= 0.9) {
        onDismiss();
        return;
      }

      resetSheetPosition();
    },
    onPanResponderTerminate: resetSheetPosition,
  }), [onDismiss, resetSheetPosition, sheetTranslateY]);

  return (
    <Modal
      animationType="slide"
      presentationStyle="overFullScreen"
      transparent
      visible
    >
      <View style={styles.calculatorBackdrop}>
        <Pressable
          onPress={onDismiss}
          style={StyleSheet.absoluteFill}
          testID={`${testIDPrefix}-calculator-dismiss`}
        />
        <SafeAreaView
          edges={['bottom']}
          style={styles.calculatorSheetSafeArea}
        >
          <Animated.View
            style={[
              styles.calculatorSheet,
              {
                paddingBottom: Math.max(insets.bottom, 16),
                transform: [{ translateY: sheetTranslateY }],
              },
            ]}
            testID={`${testIDPrefix}-calculator-sheet`}
          >
            <View
              {...dragDismissResponder.panHandlers}
              style={styles.calculatorDragZone}
              testID={`${testIDPrefix}-calculator-drag-zone`}
            >
              <View style={styles.calculatorHandleWrap}>
                <View style={styles.calculatorHandle} testID={`${testIDPrefix}-calculator-handle`} />
              </View>
            </View>
            <View style={styles.calculatorSheetBody}>
              <View style={styles.calculatorHeader}>
                <Text style={[theme.typography.headline, styles.calculatorTitle]}>Calculator</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={onDismiss}
                  style={({ pressed }) => [
                    styles.calculatorCloseButton,
                    pressed ? styles.calculatorCloseButtonPressed : null,
                  ]}
                  testID={`${testIDPrefix}-calculator-close`}
                >
                  <Text style={[theme.typography.caption, styles.calculatorCloseLabel]}>Close</Text>
                </Pressable>
              </View>

              <View style={styles.calculatorDisplay}>
                <Text
                  numberOfLines={2}
                  style={styles.calculatorExpression}
                  testID={`${testIDPrefix}-calculator-expression`}
                >
                  {expression.length > 0 ? expression : '0'}
                </Text>
                <Text
                  style={styles.calculatorResult}
                  testID={`${testIDPrefix}-calculator-result`}
                >
                  {errorMessage ?? (resultText ? `= ${resultText}` : 'Use = to apply to sold price')}
                </Text>
              </View>

              <View style={styles.calculatorGrid}>
                {calculatorRows.map((row, rowIndex) => (
                  <View key={`row-${rowIndex}`} style={styles.calculatorRow}>
                    {row.map((key) => {
                      const isWide = key.span === 2;
                      const isOperator = key.variant === 'operator';
                      const isUtility = key.variant === 'utility';
                      const isClear = key.label === 'C';
                      const isEquals = key.label === '=';

                      const handlePress = () => {
                        if (isClear) {
                          onClear();
                          return;
                        }

                        if (isEquals) {
                          onEvaluate();
                          return;
                        }

                        onAppend(key.label);
                      };

                      return (
                      <Pressable
                        key={key.label}
                        accessibilityRole="button"
                        onPress={handlePress}
                        style={({ pressed }) => [
                          styles.calculatorKey,
                          isWide ? styles.calculatorKeyWide : null,
                          isOperator
                            ? styles.calculatorKeyOperator
                            : isUtility
                              ? styles.calculatorKeyUtility
                              : styles.calculatorKeyNumber,
                          pressed ? styles.calculatorKeyPressed : null,
                        ]}
                        testID={calculatorKeyTestID(testIDPrefix, key)}
                      >
                        <Text
                          style={[
                            styles.calculatorKeyLabel,
                            isOperator
                              ? styles.calculatorKeyLabelDark
                              : isUtility
                                ? styles.calculatorKeyLabelDark
                                : styles.calculatorKeyLabelNumber,
                            isWide ? styles.calculatorKeyLabelWide : null,
                          ]}
                        >
                          {key.label}
                        </Text>
                      </Pressable>
                      );
                    })}
                  </View>
                ))}
              </View>
            </View>
          </Animated.View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

export function SellIdentityChips({
  entry,
  testIDPrefix,
}: SellIdentityChipsProps) {
  const tokens = buildSellMetadataTokens(entry);

  if (tokens.length === 0) {
    return null;
  }

  return (
    <View style={styles.metadataChipRow}>
      {tokens.map((token) => (
        <SellMetadataChip
          key={`${token.label}-${token.value}`}
          testID={`${testIDPrefix}-meta-${token.label.toLowerCase()}`}
          token={token}
        />
      ))}
    </View>
  );
}

export function SellFormFields({
  boughtPriceActionLabel,
  boughtPriceInputRef,
  boughtPriceLabel,
  boughtPriceEditorErrorMessage,
  boughtPriceEditorText = '',
  boughtPriceEditorVisible = false,
  boughtPriceInputTestID,
  boughtPriceSaveDisabled = false,
  boughtPriceToggleDisabled = false,
  decrementDisabled = false,
  incrementDisabled = false,
  marketPriceLabel,
  onBlur,
  onBoughtPriceChangeText,
  onBoughtPriceInputFocus,
  onCancelBoughtPriceEdit,
  onDecrement,
  onEditBoughtPrice,
  onFocus,
  onIncrement,
  onSaveBoughtPrice,
  onSoldPriceChangeText,
  onSoldPriceFocus,
  onToggleBoughtPrice,
  quantity,
  revealsBoughtPrice,
  soldPriceErrorMessage,
  soldPriceErrorTestID,
  soldPriceTestID,
  soldPriceText,
  stepperTestIDs,
  testIDPrefix,
  toggleBoughtPriceTestID,
}: SellFormFieldsProps) {
  const theme = useSpotlightTheme();
  const [showsCalculator, setShowsCalculator] = useState(false);
  const [calculatorExpression, setCalculatorExpression] = useState('');
  const [calculatorErrorMessage, setCalculatorErrorMessage] = useState<string | null>(null);
  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);
  const hasSoldPriceError = Boolean(soldPriceErrorMessage);
  const evaluatedCalculatorResult = useMemo(() => {
    const evaluated = evaluateSellCalculatorExpression(normalizeCalculatorExpression(calculatorExpression));
    return evaluated == null ? null : formatEditableSellPrice(evaluated);
  }, [calculatorExpression]);

  const openCalculator = useCallback(() => {
    setCalculatorExpression(soldPriceText.trim().length > 0 ? soldPriceText : '');
    setCalculatorErrorMessage(null);
    setShowsCalculator(true);
  }, [soldPriceText]);

  const closeCalculator = useCallback(() => {
    setShowsCalculator(false);
    setCalculatorErrorMessage(null);
  }, []);
  const soldPriceDisplayText = soldPriceText.trim().length > 0 ? `$${soldPriceText}` : 'Tap to enter';

  const handleAppendCalculatorSymbol = useCallback((symbol: string) => {
    setCalculatorErrorMessage(null);
    setCalculatorExpression((current) => appendCalculatorSymbol(current, symbol));
  }, []);

  const handleCalculatorClear = useCallback(() => {
    setCalculatorErrorMessage(null);
    setCalculatorExpression('');
  }, []);

  const handleApplyCalculatorResult = useCallback(() => {
    const evaluated = evaluateSellCalculatorExpression(normalizeCalculatorExpression(calculatorExpression));
    if (evaluated == null) {
      setCalculatorErrorMessage('Enter a valid calculation.');
      return;
    }

    onSoldPriceChangeText(formatEditableSellPrice(evaluated));
    setCalculatorErrorMessage(null);
    setShowsCalculator(false);
  }, [calculatorExpression, onSoldPriceChangeText]);

  return (
    <>
      <SellDetailRow label="Quantity">
        <View style={styles.formStepperRow}>
          <SellStepperButton
            disabled={decrementDisabled}
            label="−"
            onPress={() => {
              dismissKeyboard();
              onDecrement();
            }}
            testID={stepperTestIDs.decrement}
          />
          <Text style={[theme.typography.headline, styles.formStepperValue]}>{quantity}</Text>
          <SellStepperButton
            disabled={incrementDisabled}
            label="+"
            onPress={() => {
              dismissKeyboard();
              onIncrement();
            }}
            testID={stepperTestIDs.increment}
          />
        </View>
      </SellDetailRow>

      <View style={styles.formDivider} />

      <SellDetailRow label="Market price">
        <Text style={theme.typography.headline}>{marketPriceLabel}</Text>
      </SellDetailRow>

      <View style={styles.formDivider} />

      <SellDetailRow label="Bought price">
        <View style={styles.formBoughtRow}>
          <Text style={theme.typography.headline}>{boughtPriceLabel}</Text>
          <BoughtPriceVisibilityToggle
            disabled={boughtPriceToggleDisabled}
            onPress={() => {
              dismissKeyboard();
              onToggleBoughtPrice();
            }}
            revealsValue={revealsBoughtPrice}
            testID={toggleBoughtPriceTestID}
          />
          {onEditBoughtPrice ? (
            <Pressable
              accessibilityLabel={`${boughtPriceActionLabel ?? (boughtPriceLabel === '--' ? 'Add' : 'Edit')} bought price`}
              accessibilityRole="button"
              onPress={() => {
                dismissKeyboard();
                onEditBoughtPrice();
              }}
              style={({ pressed }) => [
                styles.inlineIconButton,
                pressed ? styles.inlineIconButtonPressed : null,
              ]}
              testID={`${testIDPrefix}-edit-bought-price`}
            >
              <IconPencil color="#0F0F12" size={16} strokeWidth={2} />
            </Pressable>
          ) : null}
        </View>
      </SellDetailRow>

      {boughtPriceEditorVisible ? (
        <View style={styles.formBoughtEditor}>
          <SellPriceField
            ref={boughtPriceInputRef}
            invalid={Boolean(boughtPriceEditorErrorMessage)}
            onBlur={onBlur}
            onChangeText={(nextValue) => onBoughtPriceChangeText?.(nextValue)}
            onFocus={() => { onBoughtPriceInputFocus?.(); onFocus?.(); }}
            testID={boughtPriceInputTestID}
            value={boughtPriceEditorText}
          />

          <View style={styles.formBoughtEditorActions}>
            <Button
              disabled={boughtPriceSaveDisabled}
              label="Save"
              onPress={() => {
                dismissKeyboard();
                onSaveBoughtPrice?.();
              }}
              size="sm"
              testID={`${testIDPrefix}-save-bought-price`}
            />
            <Button
              label="Cancel"
              onPress={() => {
                dismissKeyboard();
                onCancelBoughtPriceEdit?.();
              }}
              size="sm"
              testID={`${testIDPrefix}-cancel-bought-price`}
              variant="secondary"
            />
          </View>

          {boughtPriceEditorErrorMessage ? (
            <Text
              style={[theme.typography.caption, styles.formSellPriceErrorText, { color: theme.colors.danger }]}
              testID={`${testIDPrefix}-bought-price-error`}
            >
              {boughtPriceEditorErrorMessage}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.formDivider} />

      <SellTransactionPhotoCapture compact testIDPrefix={testIDPrefix} />

      <View style={styles.formDivider} />

      <View style={styles.formSoldSection}>
        <SellDetailRow label="Sold price*">
          <View style={styles.formSoldInputRow}>
            <Pressable
              accessibilityLabel={soldPriceText.trim().length > 0 ? `Edit sold price ${soldPriceText}` : 'Enter sold price'}
              accessibilityRole="button"
              onPress={() => {
                dismissKeyboard();
                onSoldPriceFocus?.();
                onFocus?.();
                openCalculator();
              }}
              style={({ pressed }) => [
                styles.formPriceButton,
                {
                  borderColor: hasSoldPriceError ? theme.colors.danger : 'rgba(0, 0, 0, 0.08)',
                  opacity: pressed ? 0.9 : 1,
                },
              ]}
              testID={soldPriceTestID}
            >
              <Text
                style={[
                  theme.typography.headline,
                  styles.formPriceButtonText,
                  soldPriceText.trim().length === 0 ? styles.formPriceButtonPlaceholder : null,
                  { color: soldPriceText.trim().length === 0 ? sellPricePlaceholderColor : theme.colors.textPrimary },
                ]}
              >
                {soldPriceDisplayText}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Open sold price calculator"
              accessibilityRole="button"
              onPress={() => {
                dismissKeyboard();
                openCalculator();
              }}
              style={({ pressed }) => [
                styles.inlineIconButton,
                styles.calculatorButton,
                pressed ? styles.inlineIconButtonPressed : null,
              ]}
              testID={`${testIDPrefix}-toggle-calculator`}
            >
              <IconCalculator color="#0F0F12" size={18} strokeWidth={1.95} />
            </Pressable>
          </View>
        </SellDetailRow>

        {hasSoldPriceError ? (
          <Text
            style={[theme.typography.caption, styles.formSellPriceErrorText, { color: theme.colors.danger }]}
            testID={soldPriceErrorTestID}
          >
            {soldPriceErrorMessage}
          </Text>
        ) : null}
      </View>

      {showsCalculator ? (
        <SellInlineCalculator
          errorMessage={calculatorErrorMessage}
          expression={calculatorExpression}
          onAppend={handleAppendCalculatorSymbol}
          onClear={handleCalculatorClear}
          onDismiss={closeCalculator}
          onEvaluate={handleApplyCalculatorResult}
          resultText={evaluatedCalculatorResult}
          testIDPrefix={testIDPrefix}
        />
      ) : null}
    </>
  );
}

export function SellTransactionPhotoCapture({
  compact = false,
  testIDPrefix,
}: SellTransactionPhotoCaptureProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [isCameraVisible, setIsCameraVisible] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [availableLenses, setAvailableLenses] = useState<string[]>(
    Platform.OS === 'ios'
      ? ['builtInWideAngleCamera']
      : [],
  );

  const updateAvailableLenses = useCallback((nextLenses?: string[]) => {
    if (!Array.isArray(nextLenses)) {
      return;
    }

    const sanitizedLenses = nextLenses.filter((lens) => typeof lens === 'string' && lens.length > 0);
    if (sanitizedLenses.length === 0) {
      return;
    }

    setAvailableLenses((current) => {
      if (
        current.length === sanitizedLenses.length
        && current.every((lens, index) => lens === sanitizedLenses[index])
      ) {
        return current;
      }

      return sanitizedLenses;
    });
  }, []);

  const wideAngleLens = useMemo(() => {
    if (Platform.OS !== 'ios') {
      return undefined;
    }

    const preferredWideLenses = [
      'builtInWideAngleCamera',
      'builtInDualWideCamera',
      'builtInTripleCamera',
    ];

    return preferredWideLenses.find((lens) => availableLenses.includes(lens));
  }, [availableLenses]);

  const selectedLens = useMemo(() => {
    if (Platform.OS !== 'ios') {
      return undefined;
    }

    if (wideAngleLens) {
      return wideAngleLens;
    }

    return undefined;
  }, [wideAngleLens]);

  const cameraViewKey = useMemo(() => (
    `sell-transaction-camera-${selectedLens ?? 'default'}`
  ), [selectedLens]);

  const cameraHeaderStyle = useMemo(() => (
    [
      styles.cameraHeader,
      {
        paddingTop: insets.top + 8,
      },
    ]
  ), [insets.top]);

  const handleCameraReady = useCallback(() => {
    void (async () => {
      try {
        const nextLenses = await cameraRef.current?.getAvailableLensesAsync?.();
        updateAvailableLenses(nextLenses);
      } catch {
        // Ignore lens-discovery failures and keep the default camera configuration.
      }
    })();
  }, [updateAvailableLenses]);

  const handleOpenCamera = useCallback(async () => {
    setErrorMessage(null);

    if (permission?.granted) {
      setIsCameraVisible(true);
      return;
    }

    const nextPermission = await requestPermission();
    if (nextPermission.granted) {
      setIsCameraVisible(true);
      return;
    }

    setIsCameraVisible(false);
    setErrorMessage(
      nextPermission.canAskAgain === false
        ? 'Enable camera access in Settings to attach a transaction photo.'
        : 'Camera access is needed to attach a transaction photo.',
    );
  }, [permission?.granted, requestPermission]);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || isCapturing) {
      return;
    }

    setIsCapturing(true);
    setErrorMessage(null);

    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.72,
        skipProcessing: true,
      });
      if (!photo?.uri) {
        setErrorMessage('Could not capture a photo right now.');
        return;
      }

      setPhotoUri(photo.uri);
      setIsCameraVisible(false);
    } catch {
      setErrorMessage('Could not capture a photo right now.');
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing]);

  return (
    <View
      style={[styles.photoSection, compact ? styles.photoSectionCompact : null]}
      testID={`${testIDPrefix}-transaction-photo`}
    >
      <View style={styles.photoRow}>
        <View style={styles.photoCopy}>
          <Text style={[theme.typography.headline, styles.photoTitle]}>Photo (optional)</Text>
        </View>

        {photoUri ? (
          <View style={styles.photoPreviewActions}>
            <Image
              source={{ uri: photoUri }}
              style={styles.photoThumbnail}
              testID={`${testIDPrefix}-photo-thumbnail`}
            />
            <Button
              label="Retake"
              onPress={() => {
                void handleOpenCamera();
              }}
              size="sm"
              testID={`${testIDPrefix}-retake-photo`}
              variant="secondary"
            />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void handleOpenCamera();
            }}
            style={({ pressed }) => [
              styles.photoTriggerButton,
              {
                backgroundColor: 'rgba(255, 255, 255, 0.94)',
                borderColor: 'rgba(0, 0, 0, 0.08)',
                opacity: pressed ? 0.76 : 1,
              },
            ]}
            testID={`${testIDPrefix}-photo-trigger`}
          >
            <View testID={`${testIDPrefix}-photo-camera-icon`}>
              <CameraIcon />
            </View>
          </Pressable>
        )}
      </View>

      {errorMessage ? (
        <Text
          style={[theme.typography.caption, styles.photoErrorText, { color: theme.colors.danger }]}
          testID={`${testIDPrefix}-photo-error`}
        >
          {errorMessage}
        </Text>
      ) : null}

      <Modal
        animationType="slide"
        presentationStyle="fullScreen"
        visible={isCameraVisible}
      >
        <SafeAreaView
          edges={['bottom', 'left', 'right']}
          style={styles.cameraModal}
          testID={`${testIDPrefix}-camera-modal`}
        >
          <View style={cameraHeaderStyle} testID={`${testIDPrefix}-camera-header`}>
            <Button
              label="Cancel"
              onPress={() => {
                setErrorMessage(null);
                setIsCameraVisible(false);
              }}
              size="sm"
              testID={`${testIDPrefix}-cancel-photo`}
              variant="secondary"
            />
            <View style={styles.cameraHeaderSpacer} />
          </View>

          <View style={styles.cameraFullscreenShell}>
            <CameraView
              key={cameraViewKey}
              ref={cameraRef}
              onAvailableLensesChanged={(event) => {
                updateAvailableLenses(event?.lenses);
              }}
              onCameraReady={handleCameraReady}
              selectedLens={selectedLens}
              style={styles.cameraFullscreenView}
              testID={`${testIDPrefix}-camera`}
              zoom={0}
            />
          </View>

          <View style={styles.cameraFooter}>
            <Button
              label={isCapturing ? 'Capturing...' : 'Capture photo'}
              onPress={() => {
                void handleCapture();
              }}
              style={styles.cameraCaptureButton}
              testID={`${testIDPrefix}-capture-photo`}
            />
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

export function BoughtPriceVisibilityToggle({
  disabled = false,
  onPress,
  revealsValue,
  testID,
}: BoughtPriceVisibilityToggleProps) {
  const iconColor = 'rgba(15, 15, 18, 0.36)';

  return (
    <Pressable
      accessibilityLabel={revealsValue ? 'Hide bought price' : 'Show bought price'}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: revealsValue }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.visibilityButton,
        {
          opacity: disabled ? 0.3 : pressed ? 0.78 : 1,
        },
      ]}
      testID={testID}
    >
      <Svg
        fill="none"
        height={22}
        testID={`${testID}-${revealsValue ? 'visible' : 'hidden'}-icon`}
        viewBox="0 0 24 24"
        width={22}
      >
        <Path
          d="M2.2 12C4.22 7.9 7.71 5.85 12 5.85C16.29 5.85 19.78 7.9 21.8 12C19.78 16.1 16.29 18.15 12 18.15C7.71 18.15 4.22 16.1 2.2 12Z"
          stroke={iconColor}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.7}
        />
        <Path
          d="M12 14.75C13.52 14.75 14.75 13.52 14.75 12C14.75 10.48 13.52 9.25 12 9.25C10.48 9.25 9.25 10.48 9.25 12C9.25 13.52 10.48 14.75 12 14.75Z"
          stroke={iconColor}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.7}
        />
        {!revealsValue ? (
          <Path
            d="M4.15 19.85L19.85 4.15"
            stroke={iconColor}
            strokeLinecap="round"
            strokeWidth={1.9}
          />
        ) : null}
      </Svg>
    </Pressable>
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
  calculatorButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 0,
    width: 48,
  },
  calculatorBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 15, 18, 0.34)',
    justifyContent: 'flex-end',
  },
  calculatorCloseButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(15, 15, 18, 0.06)',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: 12,
  },
  calculatorCloseButtonPressed: {
    opacity: 0.82,
  },
  calculatorCloseLabel: {
    color: 'rgba(15, 15, 18, 0.62)',
  },
  calculatorDisplay: {
    alignItems: 'flex-end',
    backgroundColor: 'rgba(15, 15, 18, 0.04)',
    borderRadius: 24,
    gap: 8,
    minHeight: 118,
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
  },
  calculatorExpression: {
    color: '#0F0F12',
    fontSize: 46,
    fontWeight: '400',
    lineHeight: 50,
    textAlign: 'right',
  },
  calculatorHandle: {
    backgroundColor: 'rgba(15, 15, 18, 0.18)',
    borderRadius: 999,
    height: 5,
    width: 44,
  },
  calculatorHandleWrap: {
    alignItems: 'center',
    paddingBottom: 4,
    paddingTop: 2,
    width: '100%',
  },
  calculatorDragZone: {
    paddingBottom: 2,
    paddingHorizontal: 20,
    paddingTop: 10,
    width: '100%',
  },
  calculatorGrid: {
    gap: 12,
  },
  calculatorHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  calculatorKey: {
    alignItems: 'center',
    borderRadius: 38,
    flex: 1,
    justifyContent: 'center',
    minHeight: 76,
  },
  calculatorKeyLabel: {
    fontSize: 31,
    fontWeight: '400',
    lineHeight: 34,
  },
  calculatorKeyLabelNumber: {
    color: '#0F0F12',
  },
  calculatorKeyLabelDark: {
    color: '#0F0F12',
  },
  calculatorKeyLabelWide: {
    paddingLeft: 8,
  },
  calculatorKeyPressed: {
    opacity: 0.82,
  },
  calculatorKeyNumber: {
    backgroundColor: 'rgba(15, 15, 18, 0.06)',
  },
  calculatorKeyOperator: {
    backgroundColor: '#FFE24B',
  },
  calculatorKeyUtility: {
    backgroundColor: 'rgba(15, 15, 18, 0.14)',
  },
  calculatorKeyWide: {
    alignItems: 'flex-start',
    flex: 2.1,
    paddingLeft: 28,
  },
  calculatorResult: {
    color: 'rgba(15, 15, 18, 0.56)',
    fontSize: 17,
    lineHeight: 22,
    textAlign: 'right',
  },
  calculatorRow: {
    flexDirection: 'row',
    gap: 12,
  },
  calculatorSheet: {
    backgroundColor: '#FFFDF9',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
    width: '100%',
  },
  calculatorSheetBody: {
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 2,
  },
  calculatorSheetSafeArea: {
    justifyContent: 'flex-end',
    width: '100%',
  },
  calculatorTitle: {
    color: '#0F0F12',
  },
  cameraCaptureButton: {
    width: '100%',
  },
  cameraFooter: {
    gap: 18,
    paddingBottom: 20,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  cameraFullscreenShell: {
    flex: 1,
    overflow: 'hidden',
  },
  cameraFullscreenView: {
    flex: 1,
  },
  cameraHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  cameraHeaderSpacer: {
    width: 72,
  },
  cameraModal: {
    backgroundColor: '#050507',
    flex: 1,
  },
  formBoughtEditor: {
    alignItems: 'flex-end',
    gap: 10,
    paddingBottom: 12,
  },
  formBoughtEditorActions: {
    flexDirection: 'row',
    gap: 10,
  },
  formBoughtRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'flex-end',
  },
  formDetailLabel: {
    color: '#0F0F12',
  },
  formDetailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  formDetailTrailing: {
    alignItems: 'flex-end',
    flex: 1,
  },
  formDivider: {
    backgroundColor: 'rgba(0, 0, 0, 0.08)',
    height: 1,
  },
  formOfferField: {
    flex: 1,
    gap: 6,
  },
  formOfferFields: {
    flexDirection: 'row',
    gap: 10,
  },
  formOfferLabel: {
    color: 'rgba(15, 15, 18, 0.56)',
  },
  formOfferSlash: {
    color: 'rgba(15, 15, 18, 0.44)',
    marginTop: 16,
  },
  formOfferSection: {
    gap: 10,
    paddingTop: 8,
  },
  formOfferTitle: {
    color: 'rgba(15, 15, 18, 0.62)',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  formPriceField: {
    backgroundColor: 'rgba(255, 255, 255, 0.98)',
    borderRadius: 24,
    borderWidth: 1,
    minHeight: 48,
    minWidth: 112,
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  formPriceButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.98)',
    borderRadius: 24,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 148,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  formPriceButtonPlaceholder: {
    fontWeight: '500',
  },
  formPriceButtonText: {
    textAlign: 'center',
  },
  formSellPriceHelperText: {
    color: 'rgba(15, 15, 18, 0.48)',
    maxWidth: 260,
    textAlign: 'right',
  },
  formSellPriceErrorText: {
    maxWidth: 260,
    textAlign: 'right',
  },
  formSoldHeader: {
    alignItems: 'flex-start',
    gap: 12,
  },
  formSoldInputRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
  },
  formSoldSection: {
    alignItems: 'flex-end',
    gap: 10,
    paddingVertical: 12,
  },
  formStepperButton: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  formStepperButtonText: {
    color: '#0F0F12',
    lineHeight: 20,
  },
  formStepperRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  formStepperValue: {
    color: '#0F0F12',
    minWidth: 18,
    textAlign: 'center',
  },
  formYpPercentText: {
    alignSelf: 'stretch',
    color: 'rgba(15, 15, 18, 0.48)',
    textAlign: 'right',
  },
  inlineIconButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(15, 15, 18, 0.06)',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 32,
    minWidth: 32,
    padding: 8,
  },
  inlineIconButtonPressed: {
    opacity: 0.76,
  },
  materialWash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 252, 248, 0.38)',
  },
  metadataChip: {
    alignItems: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  metadataChipLabel: {
    color: 'rgba(15, 15, 18, 0.54)',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  metadataChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metadataChipValue: {
    color: '#0F0F12',
    flexShrink: 1,
  },
  photoCopy: {
    flex: 1,
    gap: 4,
  },
  photoErrorText: {
    lineHeight: 20,
  },
  photoPreviewActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  photoRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  photoSection: {
    gap: 12,
    paddingVertical: 6,
  },
  photoSectionCompact: {
    gap: 6,
    paddingVertical: 4,
  },
  photoSubtitle: {
    color: 'rgba(15, 15, 18, 0.52)',
  },
  photoThumbnail: {
    borderRadius: 13,
    height: 42,
    resizeMode: 'cover',
    width: 42,
  },
  photoTitle: {
    color: '#0F0F12',
  },
  photoTriggerButton: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 44,
  },
  statusOverlay: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    width: '100%',
  },
  statusOverlayBody: {
    alignItems: 'center',
    maxWidth: 320,
    width: '100%',
  },
  statusOverlayCheckmark: {
    color: 'rgba(0, 0, 0, 0.84)',
    fontSize: 32,
    fontWeight: '800',
    lineHeight: 36,
  },
  statusOverlayDetail: {
    color: 'rgba(0, 0, 0, 0.66)',
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  statusOverlayHeadline: {
    color: 'rgba(0, 0, 0, 0.9)',
    fontSize: 18,
    lineHeight: 22,
    textAlign: 'center',
  },
  statusOverlayIconWrap: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    marginBottom: 20,
  },
  statusOverlayTitle: {
    color: 'rgba(0, 0, 0, 0.58)',
    fontSize: 14,
    lineHeight: 18,
    marginBottom: 10,
  },
  swipeChevron: {
    color: 'rgba(15, 15, 18, 0.7)',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 13,
  },
  swipeChevronDisabled: {
    color: 'rgba(15, 15, 18, 0.36)',
  },
  confirmationPrompt: {
    alignItems: 'center',
    borderTopColor: 'rgba(0, 0, 0, 0.05)',
    borderTopWidth: 1,
    gap: 8,
    justifyContent: 'center',
    minHeight: 56,
    paddingTop: 4,
    width: '100%',
  },
  swipeSheet: {
    alignItems: 'center',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    justifyContent: 'flex-start',
    overflow: 'hidden',
    width: '100%',
  },
  swipeSheetHelper: {
    color: 'rgba(15, 15, 18, 0.62)',
    maxWidth: 280,
    textAlign: 'center',
  },
  swipeRailHelperDisabled: {
    color: 'rgba(15, 15, 18, 0.44)',
  },
  swipeRailTitle: {
    color: 'rgba(15, 15, 18, 0.88)',
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  swipeRailTitleDisabled: {
    color: 'rgba(15, 15, 18, 0.56)',
  },
  swipeSheetWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  swipeGestureZone: {
    alignItems: 'center',
    alignSelf: 'center',
    justifyContent: 'flex-end',
    minHeight: 44,
    width: 220,
  },
  visibilityButton: {
    alignItems: 'center',
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
});
