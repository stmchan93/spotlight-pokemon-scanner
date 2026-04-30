jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
}));

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

jest.mock('expo-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  const mockTakePictureAsync = jest.fn(async () => ({
    base64: 'bW9jay1zY2FuLWJhc2U2NA==',
    uri: 'file:///mock-scan.jpg',
    width: 1080,
    height: 1620,
  }));

  const CameraView = React.forwardRef(({ onCameraReady, ...props }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      takePictureAsync: mockTakePictureAsync,
    }));

    React.useEffect(() => {
      onCameraReady?.();
    }, [onCameraReady]);

    return React.createElement(View, props);
  });
  CameraView.displayName = 'MockCameraView';

  return {
    CameraView,
    useCameraPermissions: () => [
      {
        granted: true,
        canAskAgain: true,
        status: 'granted',
      },
      jest.fn(async () => ({
        granted: true,
        canAskAgain: true,
        status: 'granted',
      })),
      jest.fn(async () => ({
        granted: true,
        canAskAgain: true,
        status: 'granted',
      })),
    ],
  };
});

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

jest.mock('expo-file-system/legacy', () => ({
  EncodingType: {
    UTF8: 'utf8',
    Base64: 'base64',
  },
  readAsStringAsync: jest.fn(async () => ''),
}));
