import { render, screen } from '@testing-library/react-native';
import Constants from 'expo-constants';

import {
  buildStagingSmokeDiagnosticValueTestId,
  StagingSmokeDiagnostics,
  STAGING_SMOKE_API_BASE_URL_TEST_ID,
  STAGING_SMOKE_APP_ENV_TEST_ID,
  STAGING_SMOKE_DIAGNOSTICS_ROOT_TEST_ID,
} from '@/components/staging-smoke-diagnostics';

describe('StagingSmokeDiagnostics', () => {
  const mockedConstants = Constants as { expoConfig?: { extra?: Record<string, unknown> } };
  const originalExtra = mockedConstants.expoConfig?.extra
    ? { ...mockedConstants.expoConfig.extra }
    : undefined;
  const originalStagingSmokeEnv = process.env.EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED;
  const originalScannerSmokeEnv = process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED;
  const originalApiBaseUrl = process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;

  afterEach(() => {
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.extra = originalExtra ? { ...originalExtra } : {};

    if (originalStagingSmokeEnv === undefined) {
      delete process.env.EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED;
    } else {
      process.env.EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED = originalStagingSmokeEnv;
    }

    if (originalScannerSmokeEnv === undefined) {
      delete process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED;
    } else {
      process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED = originalScannerSmokeEnv;
    }

    if (originalApiBaseUrl === undefined) {
      delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;
    } else {
      process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = originalApiBaseUrl;
    }
  });

  it('renders hidden staging diagnostics when staging smoke mode is enabled', () => {
    process.env.EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED = '1';
    process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = 'https://looty.34.59.188.129.sslip.io';
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.extra = {
      ...mockedConstants.expoConfig.extra,
      spotlightAppEnv: 'staging',
    };

    render(<StagingSmokeDiagnostics />);

    expect(screen.getByTestId(STAGING_SMOKE_DIAGNOSTICS_ROOT_TEST_ID)).toBeTruthy();
    expect(screen.getByTestId(STAGING_SMOKE_APP_ENV_TEST_ID).props.accessibilityLabel).toBe('staging');
    expect(screen.getByTestId(STAGING_SMOKE_API_BASE_URL_TEST_ID).props.accessibilityLabel).toBe(
      'https://looty.34.59.188.129.sslip.io',
    );
    expect(screen.getByTestId(buildStagingSmokeDiagnosticValueTestId(STAGING_SMOKE_APP_ENV_TEST_ID, 'staging'))).toBeTruthy();
    expect(
      screen.getByTestId(buildStagingSmokeDiagnosticValueTestId(
        STAGING_SMOKE_API_BASE_URL_TEST_ID,
        'https://looty.34.59.188.129.sslip.io',
      )),
    ).toBeTruthy();
  });

  it('falls back to the legacy scanner smoke flag for staging smoke diagnostics', () => {
    process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED = '1';
    process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = 'https://looty.34.59.188.129.sslip.io';
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.extra = {
      ...mockedConstants.expoConfig.extra,
      spotlightAppEnv: 'staging',
    };

    render(<StagingSmokeDiagnostics />);

    expect(screen.getByTestId(STAGING_SMOKE_DIAGNOSTICS_ROOT_TEST_ID)).toBeTruthy();
  });

  it('stays hidden outside staging smoke mode', () => {
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED;
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED;
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.extra = {
      ...mockedConstants.expoConfig.extra,
      spotlightAppEnv: 'staging',
    };

    render(<StagingSmokeDiagnostics />);

    expect(screen.queryByTestId(STAGING_SMOKE_DIAGNOSTICS_ROOT_TEST_ID)).toBeNull();
  });
});
