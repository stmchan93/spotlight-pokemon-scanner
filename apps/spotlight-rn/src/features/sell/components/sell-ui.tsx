import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';

import { CameraView, useCameraPermissions } from 'expo-camera';

import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { useSpotlightTheme } from '@spotlight/design-system';

import { sanitizeSellPriceText } from '@/features/sell/sell-order-helpers';

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

type SellOfferCalculatorProps = {
  offerPriceText: string;
  offerPriceTestID: string;
  onBlur?: () => void;
  onFocus?: () => void;
  onOfferPriceChangeText: (value: string) => void;
  onYourPriceChangeText: (value: string) => void;
  ypPercentText?: string | null;
  yourPriceTestID: string;
  yourPriceText: string;
};

type SellFormFieldsProps = {
  boughtPriceLabel: string;
  boughtPriceToggleDisabled?: boolean;
  decrementDisabled?: boolean;
  incrementDisabled?: boolean;
  marketPriceLabel: string;
  offerPriceTestID: string;
  offerPriceText: string;
  onBlur?: () => void;
  onDecrement: () => void;
  onFocus?: () => void;
  onIncrement: () => void;
  onOfferPriceChangeText: (value: string) => void;
  onSoldPriceChangeText: (value: string) => void;
  onToggleBoughtPrice: () => void;
  onYourPriceChangeText: (value: string) => void;
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
  ypPercentText?: string | null;
  yourPriceTestID: string;
  yourPriceText: string;
};

type SellStatusOverlayProps = {
  detail: string;
  headline: string;
  state: 'processing' | 'success';
  testIDPrefix: string;
  title: string;
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

export function SellPriceField({
  onBlur,
  onChangeText,
  onFocus,
  placeholder = sellPricePlaceholderText,
  testID,
  value,
}: SellPriceFieldProps) {
  const theme = useSpotlightTheme();

  return (
    <TextInput
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
          borderColor: 'rgba(0, 0, 0, 0.08)',
          color: theme.colors.textPrimary,
        },
      ]}
      testID={testID}
      value={value}
    />
  );
}

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

export function SellOfferCalculator({
  offerPriceText,
  offerPriceTestID,
  onBlur,
  onFocus,
  onOfferPriceChangeText,
  onYourPriceChangeText,
  ypPercentText,
  yourPriceTestID,
  yourPriceText,
}: SellOfferCalculatorProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.formOfferSection}>
      <Text style={[theme.typography.headline, styles.formOfferTitle]}>Offer Calculator</Text>
      <View style={styles.formOfferFields}>
        <View style={styles.formOfferField}>
          <Text style={[theme.typography.caption, styles.formOfferLabel]}>Offer Price</Text>
          <SellPriceField
            onBlur={onBlur}
            onChangeText={onOfferPriceChangeText}
            onFocus={onFocus}
            testID={offerPriceTestID}
            value={offerPriceText}
          />
        </View>

        <Text style={[theme.typography.body, styles.formOfferSlash]}>/</Text>

        <View style={styles.formOfferField}>
          <Text style={[theme.typography.caption, styles.formOfferLabel]}>Your Price (YP)</Text>
          <SellPriceField
            onBlur={onBlur}
            onChangeText={onYourPriceChangeText}
            onFocus={onFocus}
            testID={yourPriceTestID}
            value={yourPriceText}
          />
        </View>
      </View>
      {ypPercentText ? (
        <Text style={[theme.typography.caption, styles.formYpPercentText]}>{ypPercentText}</Text>
      ) : null}
    </View>
  );
}

export function SellFormFields({
  boughtPriceLabel,
  boughtPriceToggleDisabled = false,
  decrementDisabled = false,
  incrementDisabled = false,
  marketPriceLabel,
  offerPriceTestID,
  offerPriceText,
  onBlur,
  onDecrement,
  onFocus,
  onIncrement,
  onOfferPriceChangeText,
  onSoldPriceChangeText,
  onToggleBoughtPrice,
  onYourPriceChangeText,
  quantity,
  revealsBoughtPrice,
  soldPriceErrorMessage,
  soldPriceErrorTestID,
  soldPriceTestID,
  soldPriceText,
  stepperTestIDs,
  testIDPrefix,
  toggleBoughtPriceTestID,
  ypPercentText,
  yourPriceTestID,
  yourPriceText,
}: SellFormFieldsProps) {
  const theme = useSpotlightTheme();

  return (
    <>
      <SellDetailRow label="Quantity">
        <View style={styles.formStepperRow}>
          <SellStepperButton
            disabled={decrementDisabled}
            label="−"
            onPress={onDecrement}
            testID={stepperTestIDs.decrement}
          />
          <Text style={[theme.typography.headline, styles.formStepperValue]}>{quantity}</Text>
          <SellStepperButton
            disabled={incrementDisabled}
            label="+"
            onPress={onIncrement}
            testID={stepperTestIDs.increment}
          />
        </View>
      </SellDetailRow>

      <View style={styles.formDivider} />

      <SellDetailRow label="Market Price">
        <Text style={theme.typography.headline}>{marketPriceLabel}</Text>
      </SellDetailRow>

      <View style={styles.formDivider} />

      <SellDetailRow label="Bought Price">
        <View style={styles.formBoughtRow}>
          <Text style={theme.typography.headline}>{boughtPriceLabel}</Text>
          <BoughtPriceVisibilityToggle
            disabled={boughtPriceToggleDisabled}
            onPress={onToggleBoughtPrice}
            revealsValue={revealsBoughtPrice}
            testID={toggleBoughtPriceTestID}
          />
        </View>
      </SellDetailRow>

      <View style={styles.formDivider} />

      <SellOfferCalculator
        offerPriceTestID={offerPriceTestID}
        offerPriceText={offerPriceText}
        onBlur={onBlur}
        onFocus={onFocus}
        onOfferPriceChangeText={onOfferPriceChangeText}
        onYourPriceChangeText={onYourPriceChangeText}
        ypPercentText={ypPercentText}
        yourPriceTestID={yourPriceTestID}
        yourPriceText={yourPriceText}
      />

      <View style={styles.formDivider} />

      <SellTransactionPhotoCapture compact testIDPrefix={testIDPrefix} />

      <View style={styles.formDivider} />

      <SellDetailRow label="Sold price*">
        <View style={styles.formSellPriceTrailing}>
          <SellPriceField
            onBlur={onBlur}
            onChangeText={onSoldPriceChangeText}
            onFocus={onFocus}
            testID={soldPriceTestID}
            value={soldPriceText}
          />
          {soldPriceErrorMessage ? (
            <Text
              style={[theme.typography.caption, styles.formSellPriceErrorText, { color: theme.colors.danger }]}
              testID={soldPriceErrorTestID}
            >
              {soldPriceErrorMessage}
            </Text>
          ) : null}
        </View>
      </SellDetailRow>
    </>
  );
}

export function SellTransactionPhotoCapture({
  compact = false,
  testIDPrefix,
}: SellTransactionPhotoCaptureProps) {
  const theme = useSpotlightTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [isCameraVisible, setIsCameraVisible] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
        <Text style={[theme.typography.headline, styles.photoTitle]}>Photo (optional)</Text>

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void handleOpenCamera();
          }}
          style={({ pressed }) => [
            styles.photoTriggerButton,
            {
              opacity: pressed ? 0.76 : 1,
            },
          ]}
          testID={`${testIDPrefix}-photo-trigger`}
        >
          {photoUri && !isCameraVisible ? (
            <Image
              source={{ uri: photoUri }}
              style={styles.photoThumbnail}
              testID={`${testIDPrefix}-photo-thumbnail`}
            />
          ) : (
            <View testID={`${testIDPrefix}-photo-camera-icon`}>
              <CameraIcon />
            </View>
          )}
        </Pressable>
      </View>

      {isCameraVisible ? (
        <>
          <View style={styles.cameraShell}>
            <CameraView ref={cameraRef} style={styles.cameraView} testID={`${testIDPrefix}-camera`} />
          </View>

          <View style={styles.photoActions}>
            <Pressable
              accessibilityRole="button"
              disabled={isCapturing}
              onPress={() => {
                void handleCapture();
              }}
              style={({ pressed }) => [
                styles.photoPrimaryButton,
                {
                  backgroundColor: '#0F0F12',
                  opacity: pressed || isCapturing ? 0.9 : 1,
                },
              ]}
              testID={`${testIDPrefix}-capture-photo`}
            >
              {isCapturing ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={[theme.typography.control, styles.photoPrimaryButtonText]}>Capture photo</Text>
              )}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setErrorMessage(null);
                setIsCameraVisible(false);
              }}
              style={({ pressed }) => [
                styles.photoSecondaryButton,
                {
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
              testID={`${testIDPrefix}-cancel-photo`}
            >
              <Text style={[theme.typography.control, styles.photoSecondaryButtonText]}>Cancel</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {errorMessage ? (
        <Text
          style={[theme.typography.caption, styles.photoErrorText, { color: theme.colors.danger }]}
          testID={`${testIDPrefix}-photo-error`}
        >
          {errorMessage}
        </Text>
      ) : null}
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
  formBoughtRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
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
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  formOfferLabel: {
    color: '#0F0F12',
  },
  formOfferSection: {
    gap: 10,
    paddingVertical: 12,
  },
  formOfferSlash: {
    color: 'rgba(15, 15, 18, 0.44)',
    marginTop: 16,
  },
  formOfferTitle: {
    color: 'rgba(15, 15, 18, 0.9)',
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
  formSellPriceErrorText: {
    maxWidth: 220,
    textAlign: 'right',
  },
  formSellPriceTrailing: {
    alignItems: 'flex-end',
    gap: 6,
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
  cameraShell: {
    borderColor: 'rgba(15, 15, 18, 0.08)',
    borderRadius: 24,
    borderWidth: 1,
    height: 212,
    overflow: 'hidden',
  },
  cameraView: {
    flex: 1,
  },
  materialWash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 252, 248, 0.38)',
  },
  photoActions: {
    flexDirection: 'row',
    gap: 12,
  },
  photoErrorText: {
    lineHeight: 20,
  },
  photoRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  photoPrimaryButton: {
    alignItems: 'center',
    borderRadius: 18,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 128,
    paddingHorizontal: 16,
  },
  photoPrimaryButtonText: {
    color: '#FFFFFF',
  },
  photoSecondaryButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(15, 15, 18, 0.06)',
    borderRadius: 18,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 96,
    paddingHorizontal: 16,
  },
  photoSecondaryButtonText: {
    color: '#0F0F12',
  },
  photoSection: {
    gap: 12,
    paddingVertical: 6,
  },
  photoSectionCompact: {
    gap: 6,
    paddingVertical: 4,
  },
  photoTitle: {
    color: '#0F0F12',
  },
  photoThumbnail: {
    borderRadius: 13,
    height: 42,
    resizeMode: 'cover',
    width: 42,
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
  photoTriggerButton: {
    alignItems: 'center',
    borderRadius: 14,
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 44,
  },
  visibilityButton: {
    alignItems: 'center',
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
});
