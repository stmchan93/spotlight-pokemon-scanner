import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Localization from 'expo-localization';
import { Platform } from 'react-native';

import type { AppUser } from '@/features/auth/auth-models';
import { normalizeDisplayName } from '@/features/auth/auth-models';
import { resolveRuntimeAppEnv } from '@/lib/runtime-config';

type ObservabilityAppContext = {
  appEnv: string;
  appVersion: string;
  buildNumber: string;
  platform: string;
};

type ObservabilityUserTraits = {
  admin_enabled: boolean;
  has_display_name: boolean;
  labeler_enabled: boolean;
  providers_count: number;
};

function resolveConfiguredBuildNumber() {
  if (typeof Constants.expoConfig?.ios?.buildNumber === 'string') {
    return Constants.expoConfig.ios.buildNumber;
  }

  if (typeof Constants.expoConfig?.android?.versionCode === 'number') {
    return String(Constants.expoConfig.android.versionCode);
  }

  return '0';
}

function resolveDeviceTypeLabel() {
  switch (Device.deviceType) {
    case Device.DeviceType.PHONE:
      return 'Mobile';
    case Device.DeviceType.TABLET:
      return 'Tablet';
    case Device.DeviceType.DESKTOP:
      return 'Desktop';
    case Device.DeviceType.TV:
      return 'TV';
    default:
      return 'Mobile';
  }
}

export function getObservabilityAppContext(): ObservabilityAppContext {
  return {
    appEnv: resolveRuntimeAppEnv(),
    appVersion: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0',
    buildNumber: Application.nativeBuildVersion ?? resolveConfiguredBuildNumber(),
    platform: Platform.OS,
  };
}

export function getObservabilityUserTraits(user: AppUser | null): ObservabilityUserTraits | null {
  if (!user) {
    return null;
  }

  return {
    admin_enabled: user.adminEnabled,
    has_display_name: normalizeDisplayName(user.displayName) != null,
    labeler_enabled: user.labelerEnabled,
    providers_count: user.providers.length,
  };
}

export function getPostHogCustomAppProperties() {
  const locales = Localization.getLocales();
  const calendars = Localization.getCalendars();
  const locale = locales[0]?.languageTag ?? null;
  const timezone = calendars[0]?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  const appContext = getObservabilityAppContext();

  return {
    $app_build: appContext.buildNumber,
    $app_name: Constants.expoConfig?.name ?? null,
    $app_namespace: Application.applicationId ?? null,
    $app_version: appContext.appVersion,
    $device_manufacturer: Device.manufacturer ?? Device.brand ?? null,
    $device_model: Device.modelName ?? null,
    $device_type: resolveDeviceTypeLabel(),
    $is_emulator: !Device.isDevice,
    $locale: locale,
    $os_name: Device.osName ?? Platform.OS,
    $os_version: Device.osVersion ?? null,
    $timezone: timezone,
  };
}
