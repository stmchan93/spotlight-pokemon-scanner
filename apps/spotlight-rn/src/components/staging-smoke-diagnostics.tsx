import { StyleSheet, View } from 'react-native';

import { resolveRuntimeAppEnv, resolveStagingSmokeModeEnabled } from '@/lib/runtime-config';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';

export const STAGING_SMOKE_DIAGNOSTICS_ROOT_TEST_ID = 'staging-smoke-diagnostics';
export const STAGING_SMOKE_APP_ENV_TEST_ID = 'staging-smoke-app-env';
export const STAGING_SMOKE_API_BASE_URL_TEST_ID = 'staging-smoke-api-base-url';

function normalizeDiagnosticValue(value: string | null | undefined) {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, (match) => `${match.slice(0, -3)}-`)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'missing';
}

export function buildStagingSmokeDiagnosticValueTestId(prefix: string, value: string | null | undefined) {
  return `${prefix}-${normalizeDiagnosticValue(value)}`;
}

export function StagingSmokeDiagnostics() {
  if (!resolveStagingSmokeModeEnabled()) {
    return null;
  }

  const runtimeAppEnv = resolveRuntimeAppEnv();
  const repositoryBaseUrl = resolveRepositoryBaseUrl();

  return (
    <View
      collapsable={false}
      pointerEvents="none"
      style={styles.root}
      testID={STAGING_SMOKE_DIAGNOSTICS_ROOT_TEST_ID}
    >
      <View
        accessibilityLabel={runtimeAppEnv}
        collapsable={false}
        style={styles.marker}
        testID={STAGING_SMOKE_APP_ENV_TEST_ID}
      />
      <View
        collapsable={false}
        style={styles.marker}
        testID={buildStagingSmokeDiagnosticValueTestId(STAGING_SMOKE_APP_ENV_TEST_ID, runtimeAppEnv)}
      />
      <View
        accessibilityLabel={repositoryBaseUrl ?? 'missing'}
        collapsable={false}
        style={styles.marker}
        testID={STAGING_SMOKE_API_BASE_URL_TEST_ID}
      />
      <View
        collapsable={false}
        style={styles.marker}
        testID={buildStagingSmokeDiagnosticValueTestId(STAGING_SMOKE_API_BASE_URL_TEST_ID, repositoryBaseUrl)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 1,
    top: 1,
    width: 2,
    height: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    opacity: 0.015,
  },
  marker: {
    width: 1,
    height: 1,
    backgroundColor: '#000000',
  },
});
