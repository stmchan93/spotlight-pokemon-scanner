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
    scheme: 'spotlight',
  },
};

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: mockedExpoConstants,
}));

jest.mock('expo-blur', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  return {
    BlurView: View,
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
