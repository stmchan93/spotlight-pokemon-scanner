import Constants from 'expo-constants';
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

type ExpoApplicationModule = typeof import('expo-application');
type ExpoDeviceModule = typeof import('expo-device');
type ExpoLocalizationModule = typeof import('expo-localization');

let cachedExpoApplicationModule: ExpoApplicationModule | null | undefined;
let cachedExpoLocalizationModule: ExpoLocalizationModule | null | undefined;

let cachedExpoDeviceModule: ExpoDeviceModule | null | undefined;

function getExpoApplicationModule(): ExpoApplicationModule | null {
  if (cachedExpoApplicationModule !== undefined) {
    return cachedExpoApplicationModule;
  }

  try {
    cachedExpoApplicationModule = require('expo-application') as ExpoApplicationModule;
  } catch {
    cachedExpoApplicationModule = null;
  }

  return cachedExpoApplicationModule;
}

function getExpoDeviceModule(): ExpoDeviceModule | null {
  if (cachedExpoDeviceModule !== undefined) {
    return cachedExpoDeviceModule;
  }

  try {
    cachedExpoDeviceModule = require('expo-device') as ExpoDeviceModule;
  } catch {
    cachedExpoDeviceModule = null;
  }

  return cachedExpoDeviceModule;
}

function getExpoLocalizationModule(): ExpoLocalizationModule | null {
  if (cachedExpoLocalizationModule !== undefined) {
    return cachedExpoLocalizationModule;
  }

  try {
    cachedExpoLocalizationModule = require('expo-localization') as ExpoLocalizationModule;
  } catch {
    cachedExpoLocalizationModule = null;
  }

  return cachedExpoLocalizationModule;
}

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
  const deviceModule = getExpoDeviceModule();
  if (!deviceModule) {
    return 'Mobile';
  }

  switch (deviceModule.deviceType) {
    case deviceModule.DeviceType.PHONE:
      return 'Mobile';
    case deviceModule.DeviceType.TABLET:
      return 'Tablet';
    case deviceModule.DeviceType.DESKTOP:
      return 'Desktop';
    case deviceModule.DeviceType.TV:
      return 'TV';
    default:
      return 'Mobile';
  }
}

export function getObservabilityAppContext(): ObservabilityAppContext {
  const applicationModule = getExpoApplicationModule();
  return {
    appEnv: resolveRuntimeAppEnv(),
    appVersion: applicationModule?.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0',
    buildNumber: applicationModule?.nativeBuildVersion ?? resolveConfiguredBuildNumber(),
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
  const applicationModule = getExpoApplicationModule();
  const deviceModule = getExpoDeviceModule();
  const localizationModule = getExpoLocalizationModule();
  const locales = localizationModule?.getLocales?.() ?? [];
  const calendars = localizationModule?.getCalendars?.() ?? [];
  const locale = locales[0]?.languageTag ?? null;
  const timezone = calendars[0]?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  const appContext = getObservabilityAppContext();

  return {
    $app_build: appContext.buildNumber,
    $app_name: Constants.expoConfig?.name ?? null,
    $app_namespace: applicationModule?.applicationId ?? null,
    $app_version: appContext.appVersion,
    $device_manufacturer: deviceModule?.manufacturer ?? deviceModule?.brand ?? null,
    $device_model: deviceModule?.modelName ?? null,
    $device_type: resolveDeviceTypeLabel(),
    $is_emulator: deviceModule ? !deviceModule.isDevice : null,
    $locale: locale,
    $os_name: deviceModule?.osName ?? Platform.OS,
    $os_version: deviceModule?.osVersion ?? null,
    $timezone: timezone,
  };
}
