// react-test-renderer's internal `reportGlobalError` (newer versions) tries to
// dispatch an `error` event on `window` when an uncaught error fires during
// commit. In the React Native jest env there is no full DOM `window`, so the
// dispatch itself throws and masks the real failure. Stub it so React's error
// reporter can complete its no-op path.
const __globalAny = globalThis as { window?: { dispatchEvent?: (event: unknown) => boolean } };
if (__globalAny.window && typeof __globalAny.window.dispatchEvent !== 'function') {
  __globalAny.window.dispatchEvent = () => true;
}

// Reanimated v4 delegates its worklet runtime to react-native-worklets, whose
// native module isn't present under jest. Mock it first so requiring the
// reanimated mock doesn't try to initialize native worklets.
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

// Reanimated ships an official jest mock that no-ops the worklet runtime so
// components render synchronously in tests.
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
}));

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('iconoir-react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  const make = (name: string) => {
    const Component = (props: Record<string, unknown>) =>
      React.createElement(View, {
        ...props,
        testID: props.testID ?? `iconoir-${name}`,
      });
    Component.displayName = `MockIconoir(${name})`;
    return Component;
  };

  return {
    Star: make('star'),
    StarSolid: make('star-solid'),
    ArrowUp: make('arrow-up'),
    ArrowDown: make('arrow-down'),
    ArrowUpRightSquare: make('arrow-up-right-square'),
    Check: make('check'),
    CheckCircle: make('check-circle'),
    CheckCircleSolid: make('check-circle-solid'),
    DataTransferBoth: make('data-transfer-both'),
    DollarCircle: make('dollar-circle'),
    EditPencil: make('edit-pencil'),
    Eye: make('eye'),
    EyeClosed: make('eye-closed'),
    Filter: make('filter'),
    FilterList: make('filter-list'),
    Apple: make('apple'),
    Google: make('google'),
    GraphUp: make('graph-up'),
    GridPlus: make('grid-plus'),
    Heart: make('heart'),
    HeartSolid: make('heart-solid'),
    Mail: make('mail'),
    LogOut: make('log-out'),
    MediaImage: make('media-image'),
    Menu: make('menu'),
    Minus: make('minus'),
    MoreHoriz: make('more-horiz'),
    MoreHorizCircle: make('more-horiz-circle'),
    Calendar: make('calendar'),
    Cart: make('cart'),
    ScanQrCode: make('scan-qr-code'),
    NavArrowDown: make('nav-arrow-down'),
    NavArrowLeft: make('nav-arrow-left'),
    NavArrowUp: make('nav-arrow-up'),
    Plus: make('plus'),
    RefreshDouble: make('refresh-double'),
    Scanning: make('scanning'),
    Search: make('search'),
    ShareIos: make('share-ios'),
    Suitcase: make('suitcase'),
    Trash: make('trash'),
    Upload: make('upload'),
  };
});

jest.mock('react-native-image-colors', () => ({
  getColors: jest.fn(async () => ({
    platform: 'ios',
    background: '#0D2B35',
    primary: '#1A4A5A',
    secondary: '#6D8C96',
    detail: '#FFFFFF',
    quality: 'low',
  })),
}));

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  // Render a plain View in tests — the wave animation needs a real WebView,
  // but screens only need it to mount without the native module present.
  return {
    WebView: (props: Record<string, unknown>) =>
      React.createElement(View, { testID: props.testID ?? 'mock-webview' }),
  };
});

jest.mock('expo-splash-screen', () => ({
  hideAsync: jest.fn(),
  preventAutoHideAsync: jest.fn(),
}));

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(async () => ({ type: 'cancel' })),
}));

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: jest.fn(() => 'spotlight://login-callback'),
}));

jest.mock('expo-auth-session/build/QueryParams', () => ({
  getQueryParams: jest.fn(() => ({ errorCode: null, params: {} })),
}));

const mockedExpoConstants = {
  expoConfig: {
    extra: {},
    name: 'Spotlight',
    scheme: 'spotlight',
    version: '1.0.0',
    ios: {
      buildNumber: '11',
    },
    android: {
      versionCode: 11,
    },
  },
};

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: mockedExpoConstants,
}));

jest.mock('expo-application', () => ({
  applicationId: 'com.spotlight.tests',
  nativeApplicationVersion: '1.0.0',
  nativeBuildVersion: '11',
}));

jest.mock('expo-device', () => ({
  DeviceType: {
    PHONE: 1,
    TABLET: 2,
    DESKTOP: 3,
    TV: 4,
  },
  brand: 'Apple',
  deviceType: 1,
  isDevice: true,
  manufacturer: 'Apple',
  modelName: 'iPhone 16 Pro',
  osName: 'iOS',
  osVersion: '18.0',
}));

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{
    timeZone: 'America/Los_Angeles',
  }]),
  getLocales: jest.fn(() => [{
    languageTag: 'en-US',
  }]),
}));

jest.mock('posthog-react-native', () => {
  const React = require('react');

  class MockPostHog {
    capture = jest.fn();
    identify = jest.fn();
    register = jest.fn();
    reset = jest.fn();
    screen = jest.fn(async () => {});
  }

  return {
    PostHog: MockPostHog,
    PostHogProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

jest.mock('expo-blur', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  return {
    BlurView: View,
  };
});

jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  const MockExpoImage = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement(View, { ...props, ref }, children),
  );
  MockExpoImage.displayName = 'MockExpoImage';
  MockExpoImage.prefetch = jest.fn(async () => true);

  return {
    Image: MockExpoImage,
  };
});

const mockUseKeepAwake = jest.fn();

jest.mock('expo-keep-awake', () => ({
  useKeepAwake: mockUseKeepAwake,
}));

jest.mock('expo-apple-authentication', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  const MockAppleAuthenticationButton = ({ children, ...props }: any) => React.createElement(View, props, children);
  MockAppleAuthenticationButton.displayName = 'MockAppleAuthenticationButton';

  return {
    AppleAuthenticationButton: MockAppleAuthenticationButton,
    AppleAuthenticationButtonStyle: {
      BLACK: 'BLACK',
      WHITE: 'WHITE',
    },
    AppleAuthenticationButtonType: {
      CONTINUE: 'CONTINUE',
      SIGN_IN: 'SIGN_IN',
    },
    AppleAuthenticationScope: {
      EMAIL: 'EMAIL',
      FULL_NAME: 'FULL_NAME',
    },
    isAvailableAsync: jest.fn(async () => true),
    signInAsync: jest.fn(async () => ({
      authorizationCode: 'mock-authorization-code',
      fullName: {
        familyName: 'Tester',
        givenName: 'Looty',
      },
      identityToken: 'mock-identity-token',
    })),
  };
});

jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(async () => {}),
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
}));

jest.mock('react-native-vision-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  // capturePhoto -> Photo. saveToTemporaryFileAsync returns '/mock-scan.jpg', which
  // the surface turns into uri 'file:///mock-scan.jpg' (the key the image-manipulator
  // + expo-file-system mocks below recognize). Dimensions mirror the old mock.
  const makeMockPhoto = () => ({
    width: 1080,
    height: 1620,
    saveToTemporaryFileAsync: jest.fn(async () => '/mock-scan.jpg'),
    dispose: jest.fn(() => {}),
  });
  const mockCapturePhoto = jest.fn(async () => makeMockPhoto());

  // Imperative CameraRef methods used by the capture surface (cold focus-settle).
  const mockFocusTo = jest.fn(async () => {});
  const mockResetFocus = jest.fn(async () => {});

  // <Camera> fires onStarted when "ready", exposes the CameraRef methods, and
  // renders a View so testIDs resolve.
  const Camera = React.forwardRef(({ onStarted, device: _device, outputs: _outputs, isActive: _isActive, ...props }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      focusTo: mockFocusTo,
      resetFocus: mockResetFocus,
    }));
    React.useEffect(() => {
      onStarted?.();
    }, [onStarted]);
    return React.createElement(View, props);
  });
  Camera.displayName = 'MockVisionCamera';

  const mockDevice = {
    id: 'mock-back-camera',
    position: 'back',
    name: 'Mock Back Camera',
    minZoom: 1,
    maxZoom: 8,
    neutralZoom: 1,
    physicalDevices: ['ultra-wide-angle', 'wide-angle'],
    hasFlash: false,
    hasTorch: false,
  };

  return {
    Camera,
    CommonResolutions: { HD_16_9: { width: 720, height: 1280 } },
    useCameraDevice: () => mockDevice,
    useCameraPermission: () => ({
      hasPermission: true,
      requestPermission: jest.fn(async () => true),
    }),
    usePhotoOutput: () => ({ capturePhoto: mockCapturePhoto }),
    // Exposed for tests asserting the cold focus-settle path.
    __mockFocusTo: mockFocusTo,
  };
});

// The vision-camera capture path reads base64 from the saved temp file via the
// NON-legacy expo-file-system (the surface imports `expo-file-system`). Mock it so
// base64 is present like the old inline-base64 capture; benign stubs for the rest.
jest.mock('expo-file-system', () => ({
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
  readAsStringAsync: jest.fn(async () => 'bW9jay1zY2FuLWJhc2U2NA=='),
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  deleteAsync: jest.fn(async () => {}),
  readDirectoryAsync: jest.fn(async () => []),
  documentDirectory: 'file:///mock-docs/',
  cacheDirectory: 'file:///mock-cache/',
}));

jest.mock('expo-image-manipulator', () => {
  const dimensionsByUri = new Map<string, { height: number; width: number }>();
  dimensionsByUri.set('file:///mock-scan.jpg', { height: 888, width: 1920 });
  let imageCounter = 0;

  function applyResize(
    current: { height: number; width: number },
    resize: { height?: number | null; width?: number | null },
  ) {
    if (resize.width && resize.height) {
      return {
        height: resize.height,
        width: resize.width,
      };
    }

    if (resize.width) {
      return {
        height: Math.round((current.height / current.width) * resize.width),
        width: resize.width,
      };
    }

    if (resize.height) {
      return {
        height: resize.height,
        width: Math.round((current.width / current.height) * resize.height),
      };
    }

    return current;
  }

  return {
    ImageManipulator: {
      manipulate: jest.fn((uri: string) => {
        let current = dimensionsByUri.get(uri) ?? { height: 1620, width: 1080 };

        return {
          crop(rect: { height: number; width: number }) {
            current = {
              height: Math.round(rect.height),
              width: Math.round(rect.width),
            };
            return this;
          },
          renderAsync: jest.fn(async () => ({
            height: current.height,
            release: jest.fn(),
            saveAsync: jest.fn(async ({ base64 }: { base64?: boolean } = {}) => {
              const nextUri = `file:///mock-normalized-${imageCounter += 1}.jpg`;
              dimensionsByUri.set(nextUri, current);
              return {
                base64: base64 ? 'bm9ybWFsaXplZC1zY2FuLWJhc2U2NA==' : undefined,
                height: current.height,
                uri: nextUri,
                width: current.width,
              };
            }),
            width: current.width,
          })),
          release: jest.fn(),
          resize(size: { height?: number | null; width?: number | null }) {
            current = applyResize(current, size);
            return this;
          },
          rotate(degrees: number) {
            if (Math.abs(degrees) % 180 === 90) {
              current = {
                height: current.width,
                width: current.height,
              };
            }
            return this;
          },
        };
      }),
    },
    manipulateAsync: jest.fn(async (
      uri: string,
      actions: Array<{
        crop?: { originX: number; originY: number; width: number; height: number };
        resize?: { height?: number | null; width?: number | null };
      }> = [],
      { base64 }: { base64?: boolean } = {},
    ) => {
      let current = dimensionsByUri.get(uri) ?? { height: 1620, width: 1080 };

      actions.forEach((action) => {
        if (action.crop) {
          current = {
            height: Math.round(action.crop.height),
            width: Math.round(action.crop.width),
          };
          return;
        }

        if (action.resize) {
          current = applyResize(current, action.resize);
        }
      });

      const nextUri = `file:///mock-normalized-${imageCounter += 1}.jpg`;
      dimensionsByUri.set(nextUri, current);

      return {
        base64: base64 ? 'bm9ybWFsaXplZC1zY2FuLWJhc2U2NA==' : undefined,
        height: current.height,
        uri: nextUri,
        width: current.width,
      };
    }),
    SaveFormat: {
      JPEG: 'jpeg',
      PNG: 'png',
      WEBP: 'webp',
    },
  };
});

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({
    canceled: true,
    assets: null,
  })),
}));

// The scanner now reads captured images via `expo-file-system/legacy` (SDK 55:
// readAsStringAsync only works from /legacy). Return the same mock base64 the
// non-legacy mock does so the scan match payload carries a sourceImage.
jest.mock('expo-file-system/legacy', () => ({
  EncodingType: {
    UTF8: 'utf8',
    Base64: 'base64',
  },
  readAsStringAsync: jest.fn(async () => 'bW9jay1zY2FuLWJhc2U2NA=='),
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  deleteAsync: jest.fn(async () => {}),
  readDirectoryAsync: jest.fn(async () => []),
}));
