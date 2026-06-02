import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import Svg, { Path } from 'react-native-svg';

import { Button, useSpotlightTheme } from '@spotlight/design-system';

type TransactionPhotoCaptureProps = {
  compact?: boolean;
  onCapture: (uri: string) => void;
  onClear?: () => void;
  photoUri: string | null;
  testIDPrefix: string;
};

function TransactionPhotoCameraKeepAwake({
  testIDPrefix,
}: {
  testIDPrefix: string;
}) {
  useKeepAwake(`${testIDPrefix}-transaction-photo-camera`);
  return null;
}

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

export function TransactionPhotoCapture({
  compact = false,
  onCapture,
  onClear,
  photoUri,
  testIDPrefix,
}: TransactionPhotoCaptureProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
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
    `transaction-camera-${selectedLens ?? 'default'}`
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

      onCapture(photo.uri);
      setIsCameraVisible(false);
    } catch {
      setErrorMessage('Could not capture a photo right now.');
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, onCapture]);

  return (
    <View
      style={[styles.photoSection, compact ? styles.photoSectionCompact : null]}
      testID={`${testIDPrefix}-transaction-photo`}
    >
      <View style={styles.photoRow}>
        <View style={styles.photoCopy}>
          <Text style={[theme.typography.headline, styles.photoTitle]}>Photo</Text>
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
            {onClear ? (
              <Button
                label="Remove"
                onPress={() => {
                  setErrorMessage(null);
                  onClear();
                }}
                size="sm"
                testID={`${testIDPrefix}-clear-photo`}
                variant="ghost"
              />
            ) : null}
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
        <TransactionPhotoCameraKeepAwake testIDPrefix={testIDPrefix} />
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

const styles = StyleSheet.create({
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
});
